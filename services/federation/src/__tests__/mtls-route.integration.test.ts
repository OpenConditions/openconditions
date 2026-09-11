import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  generateInstanceKey,
  signMessage,
  type InstanceKey,
  type MtlsContext,
} from "@openconditions/federation";
import type { FastifyRequest } from "fastify";
import { build } from "../server.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let mtlsPeer: InstanceKey;
let plainPeer: InstanceKey;

const BASE_URL = "https://conditions.example.org";
const ARCHIVE_URL = "https://conditions.example.org/archive";
const PINNED_FINGERPRINT = "AA:BB:CC:DD";

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

/**
 * Simulates the TLS layer's verdict from a test header, since `app.inject` has
 * no real TLS socket: `x-test-cert: authorized` presents a matching cert,
 * `bad-fp` an authorized cert with an unpinned fingerprint, `unauthorized` an
 * unverified cert; absent → no client cert at all.
 */
function mtlsContextFor(req: FastifyRequest): MtlsContext | undefined {
  const header = req.headers["x-test-cert"];
  if (header === "authorized") return { authorized: true, fingerprint: PINNED_FINGERPRINT };
  if (header === "bad-fp") return { authorized: true, fingerprint: "99:99:99:99" };
  if (header === "unauthorized") return { authorized: false, fingerprint: PINNED_FINGERPRINT };
  return undefined;
}

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
  mtlsPeer = await generateInstanceKey(now);
  plainPeer = await generateInstanceKey(now);

  enabledEnv = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(ACTOR_CONFIG),
    OPENCONDITIONS_FEDERATION_ARCHIVE_URL: ARCHIVE_URL,
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([
      {
        instanceId: "peer-mtls",
        actorUrl: "https://a.example.net/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: [mtlsPeer.keyId],
        mtlsRequired: true,
        mtlsFingerprints: [PINNED_FINGERPRINT],
      },
      {
        instanceId: "peer-plain",
        actorUrl: "https://b.example.net/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: [plainPeer.keyId],
      },
    ]),
  };
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("POST /peer/inbox — the optional mTLS gate under RFC 9421 signing", () => {
  it("rejects a validly-signed mtlsRequired peer that presents NO client cert (mtls-required)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const page = pageOf([
        {
          seq: 1,
          txid: "100",
          observation: fedEvent("peer-mtls:m1", "peer-mtls", "a0".repeat(32)),
        },
      ]);
      const req = await signed(mtlsPeer, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-required");
      expect(await countRows("peer-mtls:m1")).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a validly-signed mtlsRequired peer whose cert the TLS layer did not authorize", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const page = pageOf([
        {
          seq: 1,
          txid: "110",
          observation: fedEvent("peer-mtls:m2", "peer-mtls", "a1".repeat(32)),
        },
      ]);
      const req = await signed(mtlsPeer, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: { ...req.headers, "x-test-cert": "unauthorized" },
        payload: req.payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-required");
      expect(await countRows("peer-mtls:m2")).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a validly-signed mtlsRequired peer whose authorized cert is not the pinned fingerprint", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const page = pageOf([
        {
          seq: 1,
          txid: "120",
          observation: fedEvent("peer-mtls:m3", "peer-mtls", "a2".repeat(32)),
        },
      ]);
      const req = await signed(mtlsPeer, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: { ...req.headers, "x-test-cert": "bad-fp" },
        payload: req.payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-fingerprint-mismatch");
      expect(await countRows("peer-mtls:m3")).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("accepts a validly-signed mtlsRequired peer presenting an authorized, pinned cert", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const page = pageOf([
        {
          seq: 1,
          txid: "130",
          observation: fedEvent("peer-mtls:m4", "peer-mtls", "a3".repeat(32)),
        },
      ]);
      const req = await signed(mtlsPeer, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: { ...req.headers, "x-test-cert": "authorized" },
        payload: req.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(1);
      expect(await countRows("peer-mtls:m4")).toBe(1);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("keeps RFC 9421 signing mandatory: a mtlsRequired peer with a valid cert but a BAD signature is still 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const page = pageOf([
        {
          seq: 1,
          txid: "140",
          observation: fedEvent("peer-mtls:m5", "peer-mtls", "a4".repeat(32)),
        },
      ]);
      const req = await signed(mtlsPeer, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: { ...req.headers, "x-test-cert": "authorized" },
        // Tampered body → the signature no longer verifies; mTLS must not rescue it.
        payload: Buffer.from(JSON.stringify({ ...page, tampered: true })),
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).not.toMatch(/^mtls-/);
      expect(await countRows("peer-mtls:m5")).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("leaves a non-mTLS peer unaffected: a valid signature alone passes with no client cert", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const page = pageOf([
        {
          seq: 1,
          txid: "150",
          observation: fedEvent("peer-plain:p1", "peer-plain", "a5".repeat(32)),
        },
      ]);
      const req = await signed(plainPeer, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(1);
      expect(await countRows("peer-plain:p1")).toBe(1);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("GET /peer/backfill — the mTLS gate is threaded uniformly (proxy-aware resolver)", () => {
  it("accepts a validly-signed mtlsRequired peer presenting an authorized, pinned cert", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "GET", "/peer/backfill");
      const res = await app.inject({
        method: "GET",
        url: "/peer/backfill",
        headers: { ...req.headers, "x-test-cert": "authorized" },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects the same peer presenting NO client cert (fail-closed still runs)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "GET", "/peer/backfill");
      const res = await app.inject({ method: "GET", url: "/peer/backfill", headers: req.headers });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-required");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unauthorized (unverified) cert (fail-closed still runs)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "GET", "/peer/backfill");
      const res = await app.inject({
        method: "GET",
        url: "/peer/backfill",
        headers: { ...req.headers, "x-test-cert": "unauthorized" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-required");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an authorized cert whose fingerprint is not pinned (mtls-fingerprint-mismatch)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "GET", "/peer/backfill");
      const res = await app.inject({
        method: "GET",
        url: "/peer/backfill",
        headers: { ...req.headers, "x-test-cert": "bad-fp" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-fingerprint-mismatch");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("leaves a non-mTLS peer unaffected: a valid signature alone passes", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(plainPeer, "GET", "/peer/backfill");
      const res = await app.inject({ method: "GET", url: "/peer/backfill", headers: req.headers });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("keeps RFC 9421 signing FIRST: a valid cert but a bad signature is still 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      // Sign for the bare path but request a different query → signature mismatch.
      const req = await signed(mtlsPeer, "GET", "/peer/backfill");
      const res = await app.inject({
        method: "GET",
        url: "/peer/backfill?limit=5",
        headers: { ...req.headers, "x-test-cert": "authorized" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).not.toMatch(/^mtls-/);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("POST /peer/subscriptions — the mTLS gate is threaded uniformly (proxy-aware resolver)", () => {
  it("accepts a validly-signed mtlsRequired peer presenting an authorized, pinned cert", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: { ...req.headers, "x-test-cert": "authorized" },
        payload: req.payload,
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects the same peer presenting NO client cert (fail-closed still runs)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-required");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unauthorized (unverified) cert (fail-closed still runs)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: { ...req.headers, "x-test-cert": "unauthorized" },
        payload: req.payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-required");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an authorized cert whose fingerprint is not pinned (mtls-fingerprint-mismatch)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: { ...req.headers, "x-test-cert": "bad-fp" },
        payload: req.payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-fingerprint-mismatch");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("leaves a non-mTLS peer unaffected: a valid signature alone passes", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(plainPeer, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("keeps RFC 9421 signing FIRST: a valid cert but a bad signature is still 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "POST", "/peer/subscriptions", { deliveryMode: "pull" });
      const res = await app.inject({
        method: "POST",
        url: "/peer/subscriptions",
        headers: { ...req.headers, "x-test-cert": "authorized" },
        // Tampered body → the signature no longer verifies; mTLS must not rescue it.
        payload: Buffer.from(JSON.stringify({ deliveryMode: "webhook" })),
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).not.toMatch(/^mtls-/);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("GET /peer/outbox — the optionalPeer mTLS gate is threaded (proxy-aware resolver)", () => {
  it("accepts a validly-signed mtlsRequired peer presenting an authorized, pinned cert", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "GET", "/peer/outbox");
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox",
        headers: { ...req.headers, "x-test-cert": "authorized" },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects the same peer presenting NO client cert (fail-closed still runs)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "GET", "/peer/outbox");
      const res = await app.inject({ method: "GET", url: "/peer/outbox", headers: req.headers });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-required");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unauthorized (unverified) cert (fail-closed still runs)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "GET", "/peer/outbox");
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox",
        headers: { ...req.headers, "x-test-cert": "unauthorized" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-required");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an authorized cert whose fingerprint is not pinned (mtls-fingerprint-mismatch)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(mtlsPeer, "GET", "/peer/outbox");
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox",
        headers: { ...req.headers, "x-test-cert": "bad-fp" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["federation-reason"]).toBe("mtls-fingerprint-mismatch");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("leaves a non-mTLS peer unaffected: a valid signature alone passes", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      const req = await signed(plainPeer, "GET", "/peer/outbox");
      const res = await app.inject({ method: "GET", url: "/peer/outbox", headers: req.headers });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("keeps RFC 9421 signing FIRST: a valid cert but a bad signature is still 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, mtlsContextFor });
    try {
      // Sign for the bare path but request a different query → signature mismatch.
      const req = await signed(mtlsPeer, "GET", "/peer/outbox");
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox?limit=5",
        headers: { ...req.headers, "x-test-cert": "authorized" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).not.toMatch(/^mtls-/);
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
