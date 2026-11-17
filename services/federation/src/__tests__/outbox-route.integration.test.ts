import { runMigrations } from "@openconditions/core/server";
import type {
  InstanceKey,
  RecordOutboxEntry,
  OutboxPage as WireOutboxPage,
} from "@openconditions/federation";
import {
  createInMemoryRateLimiter,
  encodeOutboxCursor,
  generateInstanceKey,
  getPeerHealth,
  InMemoryNonceStore,
  loadActiveKeys,
  signMessage,
  verifyMessage,
} from "@openconditions/federation";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database/profile";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchiveManifest } from "../archive.js";
import { build } from "../server.js";
import {
  noteArchive,
  type OwnSituationOptions,
  ownSituation,
  setOutboxAge,
  situationId,
  storeSituation,
  subscribeAll,
  tombstoneSituation,
} from "./record-fixtures.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-07-13T12:00:00.000Z";
const OUTBOX_URL = "https://conditions.example.org/peer/outbox";

/** A served page of records: these tests ask for no source's liveness. */
type OutboxPage = Omit<WireOutboxPage, "orderedItems"> & { orderedItems: RecordOutboxEntry[] };

/** The wire-encoded composite cursor of a served entry. */
function cursorOf(entry: RecordOutboxEntry): string {
  return encodeOutboxCursor({ txid: entry.txid, seq: entry.seq });
}

const ACTOR_CONFIG = {
  instanceId: "oc-test",
  baseUrl: "https://conditions.example.org",
  operator: "Test Operator",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: {
    protocolVersion: "0.1",
    convergenceBound: 300,
  },
};

const ENABLED_ENV = {
  OPENCONDITIONS_FEDERATION_ENABLED: "true",
  OPENCONDITIONS_INSTANCE_ID: ACTOR_CONFIG.instanceId,
  OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(ACTOR_CONFIG),
};

/** Stores one of this instance's situations, which the capture journals. */
async function seed(local: string, opts: OwnSituationOptions = {}): Promise<void> {
  await storeSituation(sql, ownSituation(local, opts));
}

const ids = (page: OutboxPage) => page.orderedItems.map((e) => e.recordId);

/** An unsigned GET of `path`, as the served response signature is bound to it. */
function anonymousGet(path: string) {
  return { method: "GET", url: `${ACTOR_CONFIG.baseUrl}${path}`, headers: {} };
}

function headerStrings(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

beforeAll(async () => {
  // A server of its own: the outbox fence reads the server-wide xmin horizon,
  // which another suite's open transaction on a shared server would hold back.
  const profile = postgisProfile();
  const container = await new GenericContainer(POSTGIS_IMAGES[profile])
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
  sql = postgres(url, { max: 3 });
  await assertPostgisProfile(sql, profile, {
    fixture: "outbox-route.integration.test",
    containerId: container.getId(),
  });
  await runMigrations(url);
  await subscribeAll(sql, "sub-outbox-route");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("GET /peer/outbox", () => {
  it("serves 404 when federation is disabled", async () => {
    const app = await build({ sql, env: {}, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/outbox" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("serves a signed OrderedCollectionPage of record entries with a strong ETag", async () => {
    await seed("route-a");
    await seed("route-b");
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/outbox" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.headers["etag"]).toMatch(/^"\d+\.\d+-[0-9a-f]+"$/);

      const page = res.json() as OutboxPage;
      expect(page.type).toBe("OrderedCollectionPage");
      expect(page.partOf).toBe(OUTBOX_URL);
      expect(ids(page)).toEqual([situationId("route-a"), situationId("route-b")]);
      expect(page.highWaterMark).toBe(cursorOf(page.orderedItems[1]!));
      const [first] = page.orderedItems;
      expect(first).toMatchObject({
        operation: "create",
        recordClass: "situation",
        kind: "incident",
        domain: "roads",
      });
      expect(first!.record).toMatchObject({
        id: situationId("route-a"),
        class: "situation",
        revision: 1,
        provenance: { instanceId: "oc-test", sourceId: "nl-ndw-events" },
      });

      const [key] = await loadActiveKeys(sql, NOW);
      const verified = await verifyMessage({
        method: "GET",
        url: OUTBOX_URL,
        status: 200,
        isResponse: true,
        request: anonymousGet("/peer/outbox"),
        headers: headerStrings(res.headers as Record<string, unknown>),
        body: res.rawPayload,
        resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
        nonceStore: new InMemoryNonceStore(),
      });
      expect(verified).toEqual({ ok: true, keyId: key!.keyId });
    } finally {
      await app.close();
    }
  }, 30_000);

  it("returns only entries after the cursor and pages with a next link", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const first = await app.inject({ method: "GET", url: "/peer/outbox?limit=1" });
      const firstPage = first.json() as OutboxPage;
      expect(ids(firstPage)).toEqual([situationId("route-a")]);
      expect(firstPage.next).toContain(`after=${firstPage.highWaterMark}`);
      expect(firstPage.next).toContain("limit=1");
      const live = await app.inject({
        method: "GET",
        url: "/peer/outbox?limit=1&sourceLiveness=true",
      });
      expect((live.json() as OutboxPage).next).toContain("sourceLiveness=true");

      const second = await app.inject({
        method: "GET",
        url: `/peer/outbox?after=${firstPage.highWaterMark}`,
      });
      expect(ids(second.json() as OutboxPage)).toEqual([situationId("route-b")]);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("applies the subscriber filter at source and still advances the highWaterMark", async () => {
    await seed("route-far", { lon: 100.5 });
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox?bbox=100,52,101,53",
      });
      const page = res.json() as OutboxPage;
      expect(ids(page)).toEqual([situationId("route-far")]);
      expect(page.highWaterMark).toBe(cursorOf(page.orderedItems[0]!));
      expect(page.next).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("filters by record class, kind and domain from the journal columns", async () => {
    await seed("route-works", { kind: "roadworks" });
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const works = await app.inject({ method: "GET", url: "/peer/outbox?kinds=roadworks" });
      expect(ids(works.json() as OutboxPage)).toEqual([situationId("route-works")]);

      const incidents = await app.inject({
        method: "GET",
        url: "/peer/outbox?classes=situation&kinds=incident&domains=roads",
      });
      const incidentIds = ids(incidents.json() as OutboxPage);
      expect(incidentIds).toContain(situationId("route-a"));
      expect(incidentIds).not.toContain(situationId("route-works"));

      const features = await app.inject({ method: "GET", url: "/peer/outbox?classes=feature" });
      expect(ids(features.json() as OutboxPage)).toEqual([]);

      const otherDomain = await app.inject({
        method: "GET",
        url: "/peer/outbox?domains=parking",
      });
      expect(ids(otherDomain.json() as OutboxPage)).toEqual([]);

      // Naming properties narrows to the observations named: no situation passes.
      const properties = await app.inject({
        method: "GET",
        url: "/peer/outbox?properties=traffic.speed",
      });
      expect(ids(properties.json() as OutboxPage)).toEqual([]);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("never serves a record whose licence is not public, whatever the subscriber asks", async () => {
    await seed("route-odbl", { license: "ODbL-1.0" });
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const publicPage = await app.inject({ method: "GET", url: "/peer/outbox?limit=500" });
      expect(ids(publicPage.json() as OutboxPage)).not.toContain(situationId("route-odbl"));
      // No query parameter widens the scope: an unknown one is refused.
      const asked = await app.inject({
        method: "GET",
        url: "/peer/outbox?limit=500&publicOnly=false",
      });
      expect(asked.statusCode).toBe(400);
      expect(asked.json().error).toMatch(/publicOnly/);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("keeps the filter on the next link", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox?limit=1&bbox=4,50,6,54&classes=situation&kinds=incident",
      });
      const page = res.json() as OutboxPage;
      expect(page.next).toContain("after=");
      expect(page.next).toContain("bbox=4%2C50%2C6%2C54");
      expect(page.next).toContain("classes=situation");
      expect(page.next).toContain("kinds=incident");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("answers a matching If-None-Match with a signed 304 until something new lands", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const fresh = await app.inject({ method: "GET", url: "/peer/outbox" });
      const etag = fresh.headers["etag"] as string;

      const notModified = await app.inject({
        method: "GET",
        url: "/peer/outbox",
        headers: { "if-none-match": etag },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.headers["etag"]).toBe(etag);
      expect(notModified.headers["signature"]).toBeDefined();

      const [key] = await loadActiveKeys(sql, NOW);
      const verified = await verifyMessage({
        method: "GET",
        url: OUTBOX_URL,
        status: 304,
        isResponse: true,
        request: anonymousGet("/peer/outbox"),
        headers: headerStrings(notModified.headers as Record<string, unknown>),
        resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
        nonceStore: new InMemoryNonceStore(),
      });
      expect(verified.ok).toBe(true);
      // The 304 answers this request only: not one for another cursor.
      const elsewhere = await verifyMessage({
        method: "GET",
        url: OUTBOX_URL,
        status: 304,
        isResponse: true,
        request: anonymousGet("/peer/outbox?after=1.1"),
        headers: headerStrings(notModified.headers as Record<string, unknown>),
        resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
        nonceStore: new InMemoryNonceStore(),
      });
      expect(elsewhere).toEqual({ ok: false, reason: "bad-signature" });

      await seed("route-etag-new");
      const changed = await app.inject({
        method: "GET",
        url: "/peer/outbox",
        headers: { "if-none-match": etag },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.headers["etag"]).not.toBe(etag);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("scopes the ETag to the cursor, limit, and filter", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const plain = await app.inject({ method: "GET", url: "/peer/outbox" });
      const cursor = await app.inject({ method: "GET", url: "/peer/outbox?after=1.1" });
      const limited = await app.inject({ method: "GET", url: "/peer/outbox?limit=1" });
      const filtered = await app.inject({ method: "GET", url: "/peer/outbox?kinds=incident" });
      expect(cursor.statusCode).toBe(200);
      expect(plain.headers["etag"]).not.toBe(cursor.headers["etag"]);
      // Same cursor + filter, different page size ⇒ different representation.
      expect(plain.headers["etag"]).not.toBe(limited.headers["etag"]);
      expect(plain.headers["etag"]).not.toBe(filtered.headers["etag"]);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("signs the 304 ETag so a tampered ETag fails verification", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const fresh = await app.inject({ method: "GET", url: "/peer/outbox" });
      const etag = fresh.headers["etag"] as string;
      const notModified = await app.inject({
        method: "GET",
        url: "/peer/outbox",
        headers: { "if-none-match": etag },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.headers["signature-input"]).toContain('"etag"');

      const [key] = await loadActiveKeys(sql, NOW);
      const headers = headerStrings(notModified.headers as Record<string, unknown>);
      const tampered = await verifyMessage({
        method: "GET",
        url: OUTBOX_URL,
        status: 304,
        isResponse: true,
        request: anonymousGet("/peer/outbox"),
        headers: { ...headers, etag: '"999-deadbeef"' },
        resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
        nonceStore: new InMemoryNonceStore(),
      });
      expect(tampered.ok).toBe(false);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects malformed query parameters with 400", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      for (const url of [
        "/peer/outbox?after=abc",
        "/peer/outbox?after=-1",
        "/peer/outbox?bbox=1,2,3",
        "/peer/outbox?classes=observations",
        "/peer/outbox?kinds=",
        "/peer/outbox?minEvidenceTier=bogus",
        "/peer/outbox?maxAgeSec=-5",
        "/peer/outbox?sourceLiveness=yes",
        "/peer/outbox?limit=0",
        "/peer/outbox?kind=incident",
      ]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(400);
      }
    } finally {
      await app.close();
    }
  }, 30_000);

  it("serves a tombstone as a signed delete entry with its reason; a tampered page fails verification", async () => {
    await seed("route-tomb");
    await tombstoneSituation(sql, situationId("route-tomb"), "withdrawn");
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/outbox?limit=500" });
      expect(res.statusCode).toBe(200);
      const page = res.json() as OutboxPage;
      const entries = page.orderedItems.filter((e) => e.recordId === situationId("route-tomb"));
      expect(entries.map((e) => e.operation)).toEqual(["create", "delete"]);
      const tomb = entries[1]!;
      expect(tomb).toMatchObject({
        recordClass: "situation",
        kind: "incident",
        tombstone: true,
        reason: "withdrawn",
      });
      expect(tomb.record).toBeUndefined();

      const [key] = await loadActiveKeys(sql, NOW);
      const verified = await verifyMessage({
        method: "GET",
        url: OUTBOX_URL,
        status: 200,
        isResponse: true,
        request: anonymousGet("/peer/outbox?limit=500"),
        headers: headerStrings(res.headers as Record<string, unknown>),
        body: res.rawPayload,
        resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
        nonceStore: new InMemoryNonceStore(),
      });
      expect(verified).toEqual({ ok: true, keyId: key!.keyId });

      // A tampered body (the content-digest no longer matches) is rejected.
      const tampered = await verifyMessage({
        method: "GET",
        url: OUTBOX_URL,
        status: 200,
        isResponse: true,
        request: anonymousGet("/peer/outbox?limit=500"),
        headers: headerStrings(res.headers as Record<string, unknown>),
        body: Buffer.from(res.rawPayload.toString("utf8").replace('"withdrawn"', '"expired"')),
        resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
        nonceStore: new InMemoryNonceStore(),
      });
      expect(tampered.ok).toBe(false);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("serves nothing of an erased record but its rights_revoked delete", async () => {
    await seed("route-erased", { headline: "Reporter's free text" });
    await tombstoneSituation(sql, situationId("route-erased"), "rights_revoked");
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/outbox?limit=500" });
      const page = res.json() as OutboxPage;
      const entries = page.orderedItems.filter((e) => e.recordId === situationId("route-erased"));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        operation: "delete",
        tombstone: true,
        reason: "rights_revoked",
      });
      expect(res.body).not.toContain("Reporter's free text");
    } finally {
      await app.close();
    }
  }, 30_000);
});

async function signedGet(key: InstanceKey, path: string): Promise<Record<string, string>> {
  const s = await signMessage({
    method: "GET",
    url: `${ACTOR_CONFIG.baseUrl}${path}`,
    headers: {},
    keyId: key.keyId,
    privateKey: key.privateKey,
  });
  return s.headers;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ARCHIVE_URL = "https://conditions.example.org/archive";

function peersEnv(peer: InstanceKey, tier: 0 | 1 | 2): Record<string, string> {
  return {
    ...ENABLED_ENV,
    OPENCONDITIONS_FEDERATION_ARCHIVE_URL: ARCHIVE_URL,
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([
      {
        instanceId: "peer-snap",
        actorUrl: "https://a.example.net/.well-known/openconditions/actor.json",
        trustTier: tier,
        pinnedKeys: [peer.keyId],
      },
    ]),
  };
}

describe("GET /peer/outbox — the tier-bounded public snapshot", () => {
  it("floors an UNAUTHENTICATED request to Tier-0 (24h) and redirects older history to the archive", async () => {
    await seed("snap-fresh");
    await seed("snap-2day");
    await setOutboxAge(sql, situationId("snap-fresh"), 2 * HOUR, NOW);
    await setOutboxAge(sql, situationId("snap-2day"), 2 * DAY, NOW);

    const archive = await noteArchive(
      sql,
      ARCHIVE_URL,
      new Date(Date.parse(NOW) - HOUR).toISOString(),
    );
    const env = { ...ENABLED_ENV, OPENCONDITIONS_FEDERATION_ARCHIVE_URL: ARCHIVE_URL };
    const app = await build({ sql, env, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/outbox?limit=500" });
      expect(res.statusCode).toBe(200);
      const page = res.json() as OutboxPage & {
        beyondWindow?: boolean;
        archive?: ArchiveManifest;
      };
      // A within-24h entry is always served; the 2-day-old one is beyond the floor.
      expect(ids(page)).toContain(situationId("snap-fresh"));
      expect(ids(page)).not.toContain(situationId("snap-2day"));
      expect(page.beyondWindow).toBe(true);
      expect(page.archive).toEqual(archive);
    } finally {
      await app.close();
      await sql`DELETE FROM conditions.archive_file`;
    }
  }, 30_000);

  it("serves an AUTHENTICATED Tier-1 peer its 30-day window (an entry the Tier-0 floor excludes)", async () => {
    await seed("snap-t1-2day");
    await setOutboxAge(sql, situationId("snap-t1-2day"), 2 * DAY, NOW);
    const peer = await generateInstanceKey(new Date().toISOString());

    const app = await build({ sql, env: peersEnv(peer, 1), logger: false, now: () => NOW });
    try {
      const path = "/peer/outbox?limit=500";
      const res = await app.inject({
        method: "GET",
        url: path,
        headers: await signedGet(peer, path),
      });
      expect(res.statusCode).toBe(200);
      expect(ids(res.json() as OutboxPage)).toContain(situationId("snap-t1-2day"));
    } finally {
      await app.close();
    }
  }, 30_000);

  it("binds a signed page to the signed request it answers, query included", async () => {
    const peer = await generateInstanceKey(new Date().toISOString());
    const app = await build({ sql, env: peersEnv(peer, 1), logger: false, now: () => NOW });
    try {
      const path = "/peer/outbox?limit=2&kinds=incident";
      const sent = await signedGet(peer, path);
      const res = await app.inject({ method: "GET", url: path, headers: sent });
      expect(res.statusCode).toBe(200);
      expect(res.headers["signature-input"]).toContain(
        '"@method";req "@target-uri";req "signature";req',
      );

      const [key] = await loadActiveKeys(sql, NOW);
      const verifyAs = (request: {
        method: string;
        url: string;
        headers: Record<string, string>;
      }) =>
        verifyMessage({
          ...request,
          status: 200,
          isResponse: true,
          request,
          headers: headerStrings(res.headers as Record<string, unknown>),
          body: res.rawPayload,
          resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
          nonceStore: new InMemoryNonceStore(),
        });
      const url = `${ACTOR_CONFIG.baseUrl}${path}`;
      expect(await verifyAs({ method: "GET", url, headers: sent })).toEqual({
        ok: true,
        keyId: key!.keyId,
      });
      // The same page offered as the answer to another cursor.
      const otherPath = "/peer/outbox?limit=2&kinds=incident&after=1.1";
      const other = await signedGet(peer, otherPath);
      expect(
        await verifyAs({
          method: "GET",
          url: `${ACTOR_CONFIG.baseUrl}${otherPath}`,
          headers: other,
        }),
      ).toEqual({ ok: false, reason: "bad-signature" });
      // Or as the answer to the request without the Signature it carried.
      expect(await verifyAs({ method: "GET", url, headers: {} })).toEqual({
        ok: false,
        reason: "bad-signature",
      });
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a present-but-invalid signature with 401 (no silent downgrade to Tier-0)", async () => {
    const now = new Date().toISOString();
    const peer = await generateInstanceKey(now);
    const stranger = await generateInstanceKey(now);

    const app = await build({ sql, env: peersEnv(peer, 1), logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox",
        headers: await signedGet(stranger, "/peer/outbox"),
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).toBe("unknown-key");
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("GET /peer/outbox — rate limits", () => {
  /** Two journal reads a minute at tier 0, three above it. */
  const tight = () =>
    createInMemoryRateLimiter({
      policyForTier: (tier) => ({ inboxPerMin: 1000, backfillPerMin: tier === 0 ? 2 : 3 }),
    });

  const anonymous = (
    app: Awaited<ReturnType<typeof build>>,
    remoteAddress: string,
    headers: Record<string, string> = {},
  ) => app.inject({ method: "GET", url: "/peer/outbox", remoteAddress, headers });

  it("meters an anonymous reader at tier 0 per client address, the 304 included", async () => {
    const app = await build({
      sql,
      env: ENABLED_ENV,
      logger: false,
      now: () => NOW,
      rateLimiter: tight(),
    });
    try {
      const first = await anonymous(app, "192.0.2.1");
      expect(first.statusCode).toBe(200);
      const etag = String(first.headers["etag"]);
      expect((await anonymous(app, "192.0.2.1", { "if-none-match": etag })).statusCode).toBe(304);

      const over = await anonymous(app, "192.0.2.1", { "if-none-match": etag });
      expect(over.statusCode).toBe(429);
      expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
      expect(over.headers["federation-reason"]).toBe("rate-limited");
      expect(over.json()).toMatchObject({ error: expect.any(String), retryAfterSec: 60 });
      // An address in the same IPv6 /64 is the same reader; another address is not.
      expect((await anonymous(app, "192.0.2.2")).statusCode).toBe(200);
      expect((await anonymous(app, "2001:db8:1:2::1")).statusCode).toBe(200);
      expect((await anonymous(app, "2001:db8:1:2::2")).statusCode).toBe(200);
      expect((await anonymous(app, "2001:db8:1:2::3")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("draws a signed peer's outbox and backfill reads from one budget, at its pinned tier", async () => {
    const peer = await generateInstanceKey(new Date().toISOString());
    const app = await build({
      sql,
      env: peersEnv(peer, 1),
      logger: false,
      now: () => NOW,
      rateLimiter: tight(),
    });
    try {
      const read = async (path: string) =>
        app.inject({ method: "GET", url: path, headers: await signedGet(peer, path) });
      expect((await read("/peer/outbox")).statusCode).toBe(200);
      expect((await read("/peer/backfill")).statusCode).toBe(200);
      expect((await read("/peer/outbox?limit=5")).statusCode).toBe(200);
      const before = (await getPeerHealth(sql, "peer-snap"))?.rateViolations ?? 0;
      const over = await read("/peer/outbox?limit=6");
      expect(over.statusCode).toBe(429);
      expect(over.headers["federation-reason"]).toBe("rate-limited");
      expect((await getPeerHealth(sql, "peer-snap"))?.rateViolations).toBe(before + 1);
      expect((await read("/peer/backfill?limit=6")).statusCode).toBe(429);
      // Anonymous readers from the same address keep their own budget.
      expect((await app.inject({ method: "GET", url: "/peer/outbox" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("takes the client address from X-Forwarded-For only on a connection from a trusted proxy", async () => {
    const readers = async (proxies: string | undefined) => {
      const env =
        proxies === undefined
          ? ENABLED_ENV
          : { ...ENABLED_ENV, OPENCONDITIONS_FEDERATION_TRUSTED_PROXIES: proxies };
      const app = await build({ sql, env, logger: false, now: () => NOW, rateLimiter: tight() });
      try {
        const statuses: number[] = [];
        // Three clients behind the proxy at 127.0.0.1 read once each.
        for (const client of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
          const res = await anonymous(app, "127.0.0.1", { "x-forwarded-for": client });
          statuses.push(res.statusCode);
        }
        return statuses;
      } finally {
        await app.close();
      }
    };
    expect(await readers("127.0.0.0/8")).toEqual([200, 200, 200]);
    // Without the setting, or from a proxy not named, all three are the proxy's address.
    expect(await readers(undefined)).toEqual([200, 200, 429]);
    expect(await readers("10.0.0.2")).toEqual([200, 200, 429]);
  }, 30_000);
});
