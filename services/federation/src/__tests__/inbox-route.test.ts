import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  blockPeer,
  createInMemoryRateLimiter,
  generateInstanceKey,
  getPeerHealth,
  signMessage,
  unblockPeer,
  type InstanceKey,
  type PeerRatePolicy,
} from "@openconditions/federation";
import { build } from "../server.js";

/** A deliberately tiny budget so a second event trips the limiter in-test. */
const TIGHT_POLICY: PeerRatePolicy = { inboxPerMin: 1, backfillPerMin: 1 };

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

const VALID_FROM = new Date(Date.now() - 5 * 60_000).toISOString();

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
    headers: body ? { "content-type": "application/activity+json" } : {},
    ...(body ? { body } : {}),
    keyId: key.keyId,
    privateKey: key.privateKey,
  });
  return { headers: s.headers, ...(body ? { payload: body } : {}) };
}

/** A fully-normalized published event, as a peer's outbox/webhook serves it. */
function fedEvent(id: string, instanceId: string, canonicalId: string): Record<string, unknown> {
  return {
    id,
    source: "ndw",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    type: "hazard",
    category: "incident",
    severity: "high",
    severitySource: "declared",
    headline: `Event ${id}`,
    status: "active",
    validFrom: VALID_FROM,
    geometry: { type: "Point", coordinates: [5.1, 52.1] },
    origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
    dataUpdatedAt: VALID_FROM,
    fetchedAt: VALID_FROM,
    isStale: false,
    instanceId,
    canonicalId,
    privacyClass: "authoritative",
  };
}

function pageOf(
  entries: { seq: number; txid: string; observation: Record<string, unknown> }[]
): Record<string, unknown> {
  return {
    type: "OrderedCollectionPage",
    partOf: "https://a.example.net/peer/outbox",
    highWaterMark: "0.0",
    orderedItems: entries.map((e) => ({
      seq: e.seq,
      txid: e.txid,
      operation: "create",
      objectId: e.observation["id"],
      canonicalId: e.observation["canonicalId"],
      createdAt: VALID_FROM,
      observation: e.observation,
    })),
  };
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

describe("POST /peer/inbox — the trust boundary", () => {
  it("serves 404 when federation is disabled", async () => {
    const app = await build({ sql, env: {}, logger: false });
    try {
      const res = await app.inject({ method: "POST", url: "/peer/inbox" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unsigned page with 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: { "content-type": "application/activity+json" },
        payload: JSON.stringify(pageOf([])),
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).toBeDefined();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a tampered page (bad signature) with 401 — the WHOLE page", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const page = pageOf([
        { seq: 1, txid: "100", observation: fedEvent("ndw:t1", "peer-a", "10".repeat(32)) },
      ]);
      const req = await signed(peerA, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: Buffer.from(JSON.stringify({ ...page, tampered: true })),
      });
      expect(res.statusCode).toBe(401);
      expect(await countRows("ndw:t1")).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unpinned peer with 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const page = pageOf([
        { seq: 1, txid: "100", observation: fedEvent("ndw:t2", "peer-a", "11".repeat(32)) },
      ]);
      const req = await signed(stranger, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).toBe("unknown-key");
      expect(await countRows("ndw:t2")).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("ingests a valid signed page from a pinned peer and returns counts + maxCursor", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const page = pageOf([
        { seq: 7, txid: "200", observation: fedEvent("peer-a:in-1", "peer-a", "12".repeat(32)) },
        { seq: 9, txid: "201", observation: fedEvent("peer-a:in-2", "peer-a", "13".repeat(32)) },
      ]);
      const req = await signed(peerA, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(2);
      expect(body.resupplied).toBe(0);
      expect(body.skipped).toEqual([]);
      expect(body.maxCursor).toBe("201.9");

      const rows = await sql<{ instance_id: string | null; privacy_class: string }[]>`
        SELECT instance_id, privacy_class FROM conditions.observations WHERE id = 'peer-a:in-1'`;
      expect(rows[0]).toEqual({ instance_id: "peer-a", privacy_class: "authoritative" });
    } finally {
      await app.close();
    }
  }, 30_000);

  it("skips (and reports) an event whose instanceId is not the sending peer's", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const page = pageOf([
        // peer B's event, delivered by peer A: third-instance relay, rejected.
        { seq: 1, txid: "300", observation: fedEvent("peer-b:relay", "peer-b", "14".repeat(32)) },
        { seq: 2, txid: "300", observation: fedEvent("peer-a:own", "peer-a", "15".repeat(32)) },
      ]);
      const req = await signed(peerA, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(1);
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0].objectId).toBe("peer-b:relay");
      expect(body.skipped[0].reason).toMatch(/authenticated peer/);
      // The skipped event still advances the processed cursor.
      expect(body.maxCursor).toBe("300.2");
      expect(await countRows("peer-b:relay")).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("a resupply through the inbox collapses instead of duplicating", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const canonicalId = "16".repeat(32);
      const first = pageOf([
        { seq: 1, txid: "400", observation: fedEvent("ndw:shared", "peer-a", canonicalId) },
      ]);
      const reqA = await signed(peerA, "POST", "/peer/inbox", first);
      await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: reqA.headers,
        payload: reqA.payload,
      });

      const second = pageOf([
        { seq: 1, txid: "50", observation: fedEvent("ndw:shared", "peer-b", canonicalId) },
      ]);
      const reqB = await signed(peerB, "POST", "/peer/inbox", second);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: reqB.headers,
        payload: reqB.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(0);
      expect(res.json().resupplied).toBe(1);
      expect(await countRows("ndw:shared")).toBe(1);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("answers 400 on a body without orderedItems", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const req = await signed(peerA, "POST", "/peer/inbox", { not: "a page" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rate-limits a peer that exceeds its per-minute event budget with 429", async () => {
    const app = await build({
      sql,
      env: enabledEnv,
      logger: false,
      rateLimiter: createInMemoryRateLimiter({ policyForTier: () => TIGHT_POLICY }),
    });
    try {
      const first = pageOf([
        { seq: 1, txid: "500", observation: fedEvent("peer-a:rl-1", "peer-a", "17".repeat(32)) },
      ]);
      const req1 = await signed(peerA, "POST", "/peer/inbox", first);
      const res1 = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req1.headers,
        payload: req1.payload,
      });
      expect(res1.statusCode).toBe(200);

      const second = pageOf([
        { seq: 2, txid: "501", observation: fedEvent("peer-a:rl-2", "peer-a", "18".repeat(32)) },
      ]);
      const req2 = await signed(peerA, "POST", "/peer/inbox", second);
      const res2 = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req2.headers,
        payload: req2.payload,
      });
      expect(res2.statusCode).toBe(429);
      expect(res2.headers["retry-after"]).toBeDefined();
      expect(res2.headers["federation-reason"]).toBe("rate-limited");
      expect(await countRows("peer-a:rl-2")).toBe(0);

      // The cap is per PEER: peer B is unaffected by peer A's exhaustion.
      const third = pageOf([
        { seq: 1, txid: "502", observation: fedEvent("peer-b:rl-3", "peer-b", "19".repeat(32)) },
      ]);
      const req3 = await signed(peerB, "POST", "/peer/inbox", third);
      const res3 = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req3.headers,
        payload: req3.payload,
      });
      expect(res3.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("refuses a blocked peer with 403 and restores it on unblock (transport control, not truth)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      await blockPeer(sql, {
        peerId: "peer-a",
        reason: "operator decision",
        createdBy: "op-test",
        now: new Date().toISOString(),
      });

      const page = pageOf([
        { seq: 1, txid: "600", observation: fedEvent("peer-a:blk-1", "peer-a", "20".repeat(32)) },
      ]);
      const req = await signed(peerA, "POST", "/peer/inbox", page);
      const blocked = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().reason).toBe("blocked");
      // The block stops the request BEFORE ingest — nothing landed.
      expect(await countRows("peer-a:blk-1")).toBe(0);

      // The block is LOCAL only — it is never written into the peers document
      // this instance publishes (no auto-sync / propagation).
      const peersDoc = await app.inject({
        method: "GET",
        url: "/.well-known/openconditions/peers",
      });
      expect(JSON.stringify(peersDoc.json())).not.toContain("operator decision");

      await unblockPeer(sql, "peer-a");
      const page2 = pageOf([
        { seq: 2, txid: "601", observation: fedEvent("peer-a:blk-2", "peer-a", "21".repeat(32)) },
      ]);
      const req2 = await signed(peerA, "POST", "/peer/inbox", page2);
      const restored = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req2.headers,
        payload: req2.payload,
      });
      expect(restored.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("records rate and replay failures against peer HEALTH (never event truth)", async () => {
    const app = await build({
      sql,
      env: enabledEnv,
      logger: false,
      rateLimiter: createInMemoryRateLimiter({ policyForTier: () => TIGHT_POLICY }),
    });
    try {
      const before = await getPeerHealth(sql, "peer-b");
      const rateBefore = before?.rateViolations ?? 0;
      const replayBefore = before?.replayFailures ?? 0;

      // A first valid page lands and consumes the tight budget's single slot.
      const first = pageOf([
        { seq: 1, txid: "700", observation: fedEvent("peer-b:h-1", "peer-b", "22".repeat(32)) },
      ]);
      const r1 = await signed(peerB, "POST", "/peer/inbox", first);
      const ok = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: r1.headers,
        payload: r1.payload,
      });
      expect(ok.statusCode).toBe(200);

      // A second (freshly-signed) page authenticates but trips the limiter → 429
      // and a rate violation counted against health. The event that DID land
      // (peer-b:h-1) is untouched — a transport refusal never unwinds truth.
      const second = pageOf([
        { seq: 2, txid: "701", observation: fedEvent("peer-b:h-2", "peer-b", "23".repeat(32)) },
      ]);
      const r2 = await signed(peerB, "POST", "/peer/inbox", second);
      const over = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: r2.headers,
        payload: r2.payload,
      });
      expect(over.statusCode).toBe(429);
      expect(await countRows("peer-b:h-1")).toBe(1);

      // Replaying the first request (same signed nonce) fails on the verify path
      // under peer-b's pinned key → a replay failure counted against health.
      const replay = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: r1.headers,
        payload: r1.payload,
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.headers["federation-reason"]).toBe("replayed");

      const after = await getPeerHealth(sql, "peer-b");
      expect(after!.rateViolations).toBeGreaterThan(rateBefore);
      expect(after!.replayFailures).toBeGreaterThan(replayBefore);
    } finally {
      await app.close();
    }
  }, 30_000);
});

async function countRows(id: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM conditions.observations WHERE id = ${id}`;
  return Number(rows[0]!.n);
}
