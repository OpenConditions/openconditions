import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { generateInstanceKey, signMessage, type InstanceKey } from "@openconditions/federation";
import { build } from "../server.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let peerA: InstanceKey;
let peerB: InstanceKey;
let stranger: InstanceKey;

const BASE_URL = "https://conditions.example.org";

const ACTOR_CONFIG = {
  instanceId: "oc-test",
  baseUrl: BASE_URL,
  operator: "Test Operator",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  supportedTypes: ["incident", "roadwork"],
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: {
    protocolVersion: "0.1",
    schemaVersions: ["1"],
    wireFormats: ["application/activity+json"],
    deliveryModes: ["pull", "webhook", "sse"],
    subscriptionFilters: ["bbox"],
    maxEventRate: 10,
    convergenceBound: 300,
  },
};

let enabledEnv: Record<string, string>;

/** Signs a peer request the way the server reconstructs it (baseUrl + path). */
async function signed(
  key: InstanceKey,
  method: string,
  path: string,
  bodyObj?: unknown
): Promise<{ headers: Record<string, string>; payload?: Buffer }> {
  const body = bodyObj === undefined ? undefined : Buffer.from(JSON.stringify(bodyObj));
  const s = await signMessage({
    method,
    url: `${BASE_URL}${path}`,
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body } : {}),
    keyId: key.keyId,
    privateKey: key.privateKey,
  });
  return { headers: s.headers, ...(body ? { payload: body } : {}) };
}

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 4 });
  await runMigrations(url);

  const now = new Date().toISOString();
  peerA = await generateInstanceKey(now);
  peerB = await generateInstanceKey(now);
  stranger = await generateInstanceKey(now);

  enabledEnv = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(ACTOR_CONFIG),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([
      {
        instanceId: "peer-a",
        actorUrl: "https://a.example.net/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: [peerA.keyId],
      },
      {
        instanceId: "peer-b",
        actorUrl: "https://b.example.net/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: [peerB.keyId],
      },
    ]),
  };
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("POST /peer/subscriptions — authentication", () => {
  it("serves 404 when federation is disabled", async () => {
    const app = await build({ sql, env: {}, logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/subscriptions" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unsigned request with 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ deliveryMode: "pull" }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).toBeDefined();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a tampered body (bad signature) with 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const req = await signed(peerA, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: Buffer.from(JSON.stringify({ deliveryMode: "webhook" })), // different bytes
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unknown (unpinned) peer with 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const req = await signed(stranger, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).toBe("unknown-key");
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("subscription CRUD and ownership", () => {
  it("creates a subscription and returns its id", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const req = await signed(peerA, "POST", "/peer/subscriptions", {
        deliveryMode: "pull",
        filter: { bbox: [4, 50, 6, 54] },
      });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.peerId).toBe("peer-a");
      expect(body.cursor).toBe("0.0");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("a peer lists only its OWN subscriptions", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const a = await signed(peerA, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: a.headers,
        payload: a.payload,
      });
      const b = await signed(peerB, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: b.headers,
        payload: b.payload,
      });

      const listB = await signed(peerB, "GET", "/peer/subscriptions");
      const res = await app.inject({
        method: "GET",
        url: "/peer/subscriptions",
        headers: listB.headers,
      });
      const { subscriptions } = res.json();
      expect(subscriptions.length).toBeGreaterThan(0);
      for (const sub of subscriptions) expect(sub.peerId).toBe("peer-b");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("returns 403 on a cross-peer GET and DELETE", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const create = await signed(peerA, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const created = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: create.headers,
        payload: create.payload,
      });
      const id = created.json().id;

      const getB = await signed(peerB, "GET", `/peer/subscriptions/${id}`);
      const resGet = await app.inject({
        method: "GET",
        url: `/peer/subscriptions/${id}`,
        headers: getB.headers,
      });
      expect(resGet.statusCode).toBe(403);

      const delB = await signed(peerB, "DELETE", `/peer/subscriptions/${id}`);
      const resDel = await app.inject({
        method: "DELETE",
        url: `/peer/subscriptions/${id}`,
        headers: delB.headers,
      });
      expect(resDel.statusCode).toBe(403);

      // The owner can GET, PATCH and DELETE.
      const getA = await signed(peerA, "GET", `/peer/subscriptions/${id}`);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/peer/subscriptions/${id}`,
            headers: getA.headers,
          })
        ).statusCode
      ).toBe(200);

      const patchA = await signed(peerA, "PATCH", `/peer/subscriptions/${id}`, {
        filter: { bbox: [1, 1, 2, 2] },
      });
      const resPatch = await app.inject({
        method: "PATCH",
        url: `/peer/subscriptions/${id}`,
        headers: patchA.headers,
        payload: patchA.payload,
      });
      expect(resPatch.statusCode).toBe(200);
      expect(resPatch.json().filter.bbox).toEqual([1, 1, 2, 2]);

      const delA = await signed(peerA, "DELETE", `/peer/subscriptions/${id}`);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/peer/subscriptions/${id}`,
            headers: delA.headers,
          })
        ).statusCode
      ).toBe(204);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("subscription validation (422)", () => {
  it("rejects an over-broad webhook filter", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const req = await signed(peerA, "POST", "/peer/subscriptions", {
        deliveryMode: "webhook",
        inboxUrl: "https://peer-a.example.net/inbox",
        filter: {},
      });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("over-broad-filter");
      expect(res.json().recommended).toBeDefined();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a webhook without an inboxUrl", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const req = await signed(peerA, "POST", "/peer/subscriptions", {
        deliveryMode: "webhook",
        filter: { bbox: [4, 50, 6, 54] },
      });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("inbox-required");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a webhook with a private/loopback inboxUrl (SSRF)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const req = await signed(peerA, "POST", "/peer/subscriptions", {
        deliveryMode: "webhook",
        inboxUrl: "https://127.0.0.1/inbox",
        filter: { bbox: [4, 50, 6, 54] },
      });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("inbox-not-public");
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("GET /peer/stream — authenticated SSE THROUGH the subscription model", () => {
  it("requires a subscriptionId and rejects a cross-peer/unknown one", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const noId = await signed(peerA, "GET", "/peer/stream");
      expect(
        (await app.inject({ method: "GET", url: "/peer/stream", headers: noId.headers })).statusCode
      ).toBe(400);

      // A subscription owned by peer B cannot be streamed by peer A.
      const bId = await createSub(app, peerB, {
        deliveryMode: "sse",
        filter: { bbox: [4, 50, 6, 54] },
      });
      const crossPath = `/peer/stream?subscriptionId=${bId}`;
      const cross = await signed(peerA, "GET", crossPath);
      expect(
        (await app.inject({ method: "GET", url: crossPath, headers: cross.headers })).statusCode
      ).toBe(403);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an over-broad SSE subscription at creation (no firehose over a push channel)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const req = await signed(peerA, "POST", "/peer/subscriptions", {
        deliveryMode: "sse",
        filter: {},
      });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("over-broad-filter");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("streams a subscription's events (snapshot + live), each carrying the composite cursor", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as { port: number };
      const id = await createSub(app, peerA, {
        deliveryMode: "sse",
        priorityOnly: false,
        filter: { bbox: [18, 51, 19, 53], permissiveOnly: false },
      });
      const path = `/peer/stream?subscriptionId=${id}`;

      await insertEvent("sse-snap", 18.5);

      const req = await signed(peerA, "GET", path);
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: req.headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const events = await readEvents(reader, 1, 8000, (e) => e.data.includes("sse-snap"));
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.parse(events[0]!.data).cursor).toMatch(/^\d+\.\d+$/);

      await insertEvent("sse-live", 18.6);
      const live = await readEvents(reader, 1, 8000, (e) => e.data.includes("sse-live"));
      expect(live.length).toBeGreaterThan(0);
      expect(JSON.parse(live[live.length - 1]!.data).cursor as string).toMatch(/^\d+\.\d+$/);

      await reader.cancel();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("respects the subscription's priorityOnly — a non-priority matching event is NOT streamed", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as { port: number };
      const id = await createSub(app, peerA, {
        deliveryMode: "sse",
        priorityOnly: true,
        filter: {
          bbox: [20, 51, 21, 53],
          types: ["road_closure", "roadworks"],
          permissiveOnly: false,
        },
      });
      const path = `/peer/stream?subscriptionId=${id}`;

      await insertEvent("sse-works", 20.4, "roadworks"); // non-priority, matches filter
      await insertEvent("sse-closure", 20.5, "road_closure"); // priority

      const req = await signed(peerA, "GET", path);
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: req.headers });
      const reader = res.body!.getReader();
      const events = await readEvents(reader, 1, 8000, (e) => e.data.includes("sse-closure"));
      expect(events.length).toBeGreaterThan(0);
      // The priority closure streamed; the non-priority roadwork did NOT.
      expect(events.some((e) => e.data.includes("sse-works"))).toBe(false);

      await reader.cancel();
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("PATCH re-enables a push_disabled subscription (recovery)", () => {
  it("resets status to active and push_failures to 0", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const id = await createSub(app, peerA, {
        deliveryMode: "webhook",
        inboxUrl: "https://peer-a.example.net/inbox",
        filter: { bbox: [4, 50, 6, 54] },
      });
      // Simulate the cron having disabled the channel after repeated failures.
      await sql`UPDATE conditions.federation_subscription
                SET status = 'push_disabled', push_failures = 5 WHERE id = ${id}`;

      const patch = await signed(peerA, "PATCH", `/peer/subscriptions/${id}`, {
        inboxUrl: "https://peer-a.example.net/inbox-recovered",
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/peer/subscriptions/${id}`,
        headers: patch.headers,
        payload: patch.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("active");
      expect(res.json().pushFailures).toBe(0);
      expect(res.json().inboxUrl).toBe("https://peer-a.example.net/inbox-recovered");
    } finally {
      await app.close();
    }
  }, 30_000);
});

async function insertEvent(id: string, lon: number, type = "road_closure"): Promise<void> {
  const geometry = { type: "Point", coordinates: [lon, 52.1] };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, category, severity, severity_source,
       headline, status, geom, origin, data_updated_at, fetched_at, privacy_class)
    VALUES (${id}, 'sse-test', 'datex2', 'roads', 'event', ${type}, 'incident', 'high',
       'declared', ${id}, 'active',
       ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326),
       ${sql.json({ kind: "feed", attribution: { provider: "Auth", license: "CC-BY-4.0" } } as never)},
       '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z', 'authoritative')`;
}

/** Creates a subscription via the signed route and returns its id. */
async function createSub(
  app: Awaited<ReturnType<typeof build>>,
  key: InstanceKey,
  input: unknown
): Promise<string> {
  const req = await signed(key, "POST", "/peer/subscriptions", input);
  const res = await app.inject({
    method: "POST",
    url: "/peer/subscriptions",
    headers: req.headers,
    payload: req.payload,
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.payload}`);
  return res.json().id;
}

interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

/** Reads SSE frames until `count` events match `predicate` (or a byte timeout). */
async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs: number,
  predicate: (e: SseEvent) => boolean = () => true
): Promise<SseEvent[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const matched: SseEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (matched.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now())
      ),
    ]);
    if (chunk.done || chunk.value === undefined) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (frame.startsWith(":")) continue; // heartbeat
      const event: SseEvent = { data: "" };
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event.event = line.slice(6).trim();
        else if (line.startsWith("id:")) event.id = line.slice(3).trim();
        else if (line.startsWith("data:")) event.data += line.slice(5).trim();
      }
      if (event.data && predicate(event)) matched.push(event);
    }
  }
  return matched;
}
