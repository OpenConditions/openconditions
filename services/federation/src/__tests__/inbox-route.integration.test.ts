import { runMigrations } from "@openconditions/core/server";
import {
  blockPeer,
  createInMemoryRateLimiter,
  generateInstanceKey,
  getPeerHealth,
  type InstanceKey,
  type PeerRatePolicy,
  signMessage,
  storePeerVersions,
  unblockPeer,
} from "@openconditions/federation";
import { schemaVersions } from "@openconditions/model";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../server.js";
import { pageOf, peerSituation, registry } from "./record-fixtures.js";

/** A deliberately tiny budget so a second record trips the limiter in-test. */
const TIGHT_POLICY: PeerRatePolicy = { inboxPerMin: 1, backfillPerMin: 1 };

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let peerA: InstanceKey;
let peerB: InstanceKey;
let peerC: InstanceKey;
let stranger: InstanceKey;

const BASE_URL = "https://conditions.example.org";

const ACTOR_CONFIG = {
  instanceId: "oc-test",
  baseUrl: BASE_URL,
  operator: "Test Operator",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: {
    protocolVersion: "0.1",
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
  bodyObj?: unknown,
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

const idOf = (local: string) => `oc:situation:nl-ndw-events:${local}`;

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
  peerC = await generateInstanceKey(now);
  stranger = await generateInstanceKey(now);
  // Peers A and B have had their actor documents verified; peer C has not.
  await storePeerVersions(sql, "peer-a", schemaVersions(registry), now);
  await storePeerVersions(sql, "peer-b", schemaVersions(registry), now);

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
      {
        instanceId: "peer-c",
        actorUrl: "https://c.example.net/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: [peerC.keyId],
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
      const page = pageOf([{ seq: 1, txid: "100", record: peerSituation("peer-a", "t1") }]);
      const req = await signed(peerA, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: Buffer.from(JSON.stringify({ ...page, tampered: true })),
      });
      expect(res.statusCode).toBe(401);
      expect(await countRows(idOf("t1"))).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unpinned peer with 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const page = pageOf([{ seq: 1, txid: "100", record: peerSituation("peer-a", "t2") }]);
      const req = await signed(stranger, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).toBe("unknown-key");
      expect(await countRows(idOf("t2"))).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("answers 503 Retry-After to a peer whose capabilities are not yet known", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const page = pageOf([{ seq: 1, txid: "150", record: peerSituation("peer-c", "cap-1") }]);
      const req = await signed(peerC, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(503);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      expect(res.headers["federation-reason"]).toBe("capabilities-unknown");
      expect(res.json()).not.toHaveProperty("maxCursor");
      expect(await countRows(idOf("cap-1"))).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("lands a valid signed page from a pinned peer and returns counts + maxCursor", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const page = pageOf([
        { seq: 7, txid: "200", record: peerSituation("peer-a", "in-1") },
        { seq: 9, txid: "201", record: peerSituation("peer-a", "in-2") },
      ]);
      const req = await signed(peerA, "POST", "/peer/inbox", page);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req.headers,
        payload: req.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        accepted: 2,
        stale: 0,
        tombstoned: 0,
        skipped: [],
        maxCursor: "201.9",
      });

      const rows = await sql<{ instance_id: string; privacy_class: string }[]>`
        SELECT instance_id, privacy_class FROM conditions.situation WHERE id = ${idOf("in-1")}`;
      expect(rows[0]).toEqual({ instance_id: "peer-a", privacy_class: "authoritative" });
    } finally {
      await app.close();
    }
  }, 30_000);

  it.each(["40001", "23502", "22P02"])(
    "retries a partially committed page after local SQL %s without penalizing the peer",
    async (code) => {
      const firstLocal = `retry-first-${code}`;
      const secondLocal = `retry-second-${code}`;
      const app = await build({ sql, env: enabledEnv, logger: false });
      await sql`CREATE FUNCTION conditions.fail_inbox_retry_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.id LIKE 'oc:situation:nl-ndw-events:retry-second-%' THEN
          RAISE EXCEPTION 'temporary local failure' USING ERRCODE = TG_ARGV[0];
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`;
      await sql.unsafe(`CREATE TRIGGER fail_inbox_retry_test BEFORE INSERT ON conditions.situation
      FOR EACH ROW EXECUTE FUNCTION conditions.fail_inbox_retry_test('${code}')`);
      try {
        const page = pageOf([
          { seq: 1, txid: "290", record: peerSituation("peer-a", firstLocal) },
          { seq: 2, txid: "290", record: peerSituation("peer-a", secondLocal) },
        ]);
        const before = await getPeerHealth(sql, "peer-a");
        const first = await signed(peerA, "POST", "/peer/inbox", page);
        const failed = await app.inject({ method: "POST", url: "/peer/inbox", ...first });
        expect(failed.statusCode).toBe(500);
        expect(failed.json()).not.toHaveProperty("maxCursor");
        expect(await getPeerHealth(sql, "peer-a")).toEqual(before);
        expect(await countRows(idOf(firstLocal))).toBe(1);
        expect(await countRows(idOf(secondLocal))).toBe(0);

        await sql`DROP TRIGGER fail_inbox_retry_test ON conditions.situation`;
        const retry = await signed(peerA, "POST", "/peer/inbox", page);
        const succeeded = await app.inject({ method: "POST", url: "/peer/inbox", ...retry });
        expect(succeeded.statusCode).toBe(200);
        // The record that landed before the failure is a stale redelivery now.
        expect(succeeded.json()).toEqual({
          accepted: 1,
          stale: 1,
          tombstoned: 0,
          skipped: [],
          maxCursor: "290.2",
        });
        expect(await countRows(idOf(firstLocal))).toBe(1);
        expect(await countRows(idOf(secondLocal))).toBe(1);
        expect(await getPeerHealth(sql, "peer-a")).toEqual(before);
      } finally {
        await sql`DROP TRIGGER IF EXISTS fail_inbox_retry_test ON conditions.situation`;
        await sql`DROP FUNCTION conditions.fail_inbox_retry_test()`;
        await app.close();
      }
    },
    30_000,
  );

  it("skips and reports what it may not keep, counting each against the peer's schema health", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const before = (await getPeerHealth(sql, "peer-a"))?.schemaFailures ?? 0;
      const page = pageOf([
        // Peer B's record, delivered by peer A: a relay, refused.
        { seq: 1, txid: "300", record: peerSituation("peer-b", "relay") },
        { seq: 2, txid: "300", record: peerSituation("peer-a", "own") },
      ]);
      (page["orderedItems"] as unknown[]).push({ seq: 3, txid: "300", operation: "update" });
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
      expect(body.skipped).toEqual([
        { recordId: idOf("relay"), reason: expect.stringMatching(/peer-b's/) },
        { reason: "malformed entry" },
      ]);
      // The skipped entries still advance the processed cursor.
      expect(body.maxCursor).toBe("300.3");
      expect(await countRows(idOf("relay"))).toBe(0);
      expect((await getPeerHealth(sql, "peer-a"))!.schemaFailures).toBe(before + 2);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("never lets one peer's record replace another instance's under the same id", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false });
    try {
      const first = pageOf([{ seq: 1, txid: "400", record: peerSituation("peer-a", "shared") }]);
      const reqA = await signed(peerA, "POST", "/peer/inbox", first);
      await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: reqA.headers,
        payload: reqA.payload,
      });

      const second = pageOf([{ seq: 1, txid: "50", record: peerSituation("peer-b", "shared", 4) }]);
      const reqB = await signed(peerB, "POST", "/peer/inbox", second);
      const res = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: reqB.headers,
        payload: reqB.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        accepted: 0,
        skipped: [
          { recordId: idOf("shared"), reason: "another instance's record holds this id here" },
        ],
      });
      const rows = await sql<{ instance_id: string; revision: number }[]>`
        SELECT instance_id, revision FROM conditions.situation WHERE id = ${idOf("shared")}`;
      expect(rows).toEqual([{ instance_id: "peer-a", revision: 1 }]);
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

  it("rate-limits a peer that exceeds its per-minute record budget with 429", async () => {
    const app = await build({
      sql,
      env: enabledEnv,
      logger: false,
      rateLimiter: createInMemoryRateLimiter({ policyForTier: () => TIGHT_POLICY }),
    });
    try {
      const first = pageOf([{ seq: 1, txid: "500", record: peerSituation("peer-a", "rl-1") }]);
      const req1 = await signed(peerA, "POST", "/peer/inbox", first);
      const res1 = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: req1.headers,
        payload: req1.payload,
      });
      expect(res1.statusCode).toBe(200);

      const second = pageOf([{ seq: 2, txid: "501", record: peerSituation("peer-a", "rl-2") }]);
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
      expect(await countRows(idOf("rl-2"))).toBe(0);

      // The cap is per PEER: peer B is unaffected by peer A's exhaustion.
      const third = pageOf([{ seq: 1, txid: "502", record: peerSituation("peer-b", "rl-3") }]);
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

      const page = pageOf([{ seq: 1, txid: "600", record: peerSituation("peer-a", "blk-1") }]);
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
      expect(await countRows(idOf("blk-1"))).toBe(0);

      // The block is LOCAL only — it is never written into the peers document
      // this instance publishes (no auto-sync / propagation).
      const peersDoc = await app.inject({
        method: "GET",
        url: "/.well-known/openconditions/peers",
      });
      expect(JSON.stringify(peersDoc.json())).not.toContain("operator decision");

      await unblockPeer(sql, "peer-a");
      const page2 = pageOf([{ seq: 2, txid: "601", record: peerSituation("peer-a", "blk-2") }]);
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

  it("records rate and replay failures against peer HEALTH (never record truth)", async () => {
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
      const first = pageOf([{ seq: 1, txid: "700", record: peerSituation("peer-b", "h-1") }]);
      const r1 = await signed(peerB, "POST", "/peer/inbox", first);
      const ok = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: r1.headers,
        payload: r1.payload,
      });
      expect(ok.statusCode).toBe(200);

      // A second (freshly-signed) page authenticates but trips the limiter → 429
      // and a rate violation counted against health. The record that DID land
      // is untouched — a transport refusal never unwinds truth.
      const second = pageOf([{ seq: 2, txid: "701", record: peerSituation("peer-b", "h-2") }]);
      const r2 = await signed(peerB, "POST", "/peer/inbox", second);
      const over = await app.inject({
        method: "POST",
        url: "/peer/inbox",
        headers: r2.headers,
        payload: r2.payload,
      });
      expect(over.statusCode).toBe(429);
      expect(await countRows(idOf("h-1"))).toBe(1);

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
    SELECT count(*)::text AS n FROM conditions.situation WHERE id = ${id}`;
  return Number(rows[0]!.n);
}
