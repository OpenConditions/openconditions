import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  InMemoryNonceStore,
  encodeOutboxCursor,
  loadActiveKeys,
  verifyMessage,
} from "@openconditions/federation";
import type { OutboxEntry, OutboxPage } from "@openconditions/federation";
import { build } from "../server.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-07-13T12:00:00.000Z";
const OUTBOX_URL = "https://conditions.example.org/peer/outbox";

/** The wire-encoded composite cursor of a served entry. */
function cursorOf(entry: OutboxEntry): string {
  return encodeOutboxCursor({ txid: entry.txid, seq: entry.seq });
}

const ACTOR_CONFIG = {
  instanceId: "oc-test",
  baseUrl: "https://conditions.example.org",
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
    deliveryModes: ["pull"],
    subscriptionFilters: ["bbox"],
    maxEventRate: 10,
    convergenceBound: 300,
  },
};

const ENABLED_ENV = {
  OPENCONDITIONS_FEDERATION_ENABLED: "true",
  OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(ACTOR_CONFIG),
};

async function insertObservation(
  id: string,
  opts: { lon?: number; license?: string; evidenceState?: string | null; origin?: object } = {}
): Promise<void> {
  const geometry = { type: "Point", coordinates: [opts.lon ?? 5.1, 52.1] };
  const origin = opts.origin ?? {
    kind: "feed",
    attribution: { provider: "Test Authority", license: opts.license ?? "CC-BY-4.0" },
  };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, category, severity, severity_source,
       headline, status, geom, origin, data_updated_at, fetched_at, evidence_state)
    VALUES (${id}, 'route-test', 'datex2', 'roads', 'event', 'incident', 'incident', 'medium',
       'declared', ${id}, 'active',
       ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326),
       ${sql.json(origin as never)}, '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z',
       ${opts.evidenceState ?? null})`;
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
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
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

  it("serves a signed OrderedCollectionPage with a strong ETag", async () => {
    await insertObservation("route-a");
    await insertObservation("route-b");
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/outbox" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/activity+json");
      expect(res.headers["etag"]).toMatch(/^"\d+\.\d+-[0-9a-f]+"$/);

      const page = res.json() as OutboxPage;
      expect(page.type).toBe("OrderedCollectionPage");
      expect(page.partOf).toBe(OUTBOX_URL);
      expect(page.orderedItems.map((e) => e.objectId)).toEqual(["route-a", "route-b"]);
      expect(page.highWaterMark).toBe(cursorOf(page.orderedItems[1]!));

      const [key] = await loadActiveKeys(sql, NOW);
      const verified = await verifyMessage({
        method: "GET",
        url: OUTBOX_URL,
        status: 200,
        isResponse: true,
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
      expect(firstPage.orderedItems).toHaveLength(1);
      expect(firstPage.orderedItems[0]!.objectId).toBe("route-a");
      expect(firstPage.next).toContain(`after=${firstPage.highWaterMark}`);
      expect(firstPage.next).toContain("limit=1");

      const second = await app.inject({
        method: "GET",
        url: `/peer/outbox?after=${firstPage.highWaterMark}`,
      });
      const secondPage = second.json() as OutboxPage;
      expect(secondPage.orderedItems.map((e) => e.objectId)).toEqual(["route-b"]);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("applies the subscriber filter at source and still advances the highWaterMark", async () => {
    await insertObservation("route-far", { lon: 100.5 });
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox?bbox=100,52,101,53",
      });
      const page = res.json() as OutboxPage;
      expect(page.orderedItems.map((e) => e.objectId)).toEqual(["route-far"]);
      expect(page.highWaterMark).toBe(cursorOf(page.orderedItems[0]!));
      expect(page.next).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("keeps the filter on the next link", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/peer/outbox?limit=1&bbox=4,50,6,54&permissiveOnly=false",
      });
      const page = res.json() as OutboxPage;
      expect(page.next).toContain("after=");
      expect(page.next).toContain("bbox=4%2C50%2C6%2C54");
      expect(page.next).toContain("permissiveOnly=false");
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
        headers: headerStrings(notModified.headers as Record<string, unknown>),
        resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
        nonceStore: new InMemoryNonceStore(),
      });
      expect(verified.ok).toBe(true);

      await insertObservation("route-etag-new");
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
      expect(cursor.statusCode).toBe(200);
      expect(plain.headers["etag"]).not.toBe(cursor.headers["etag"]);
      // Same cursor + filter, different page size ⇒ different representation.
      expect(plain.headers["etag"]).not.toBe(limited.headers["etag"]);
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
        "/peer/outbox?minEvidenceTier=bogus",
        "/peer/outbox?maxAgeSec=-5",
        "/peer/outbox?limit=0",
      ]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(400);
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});
