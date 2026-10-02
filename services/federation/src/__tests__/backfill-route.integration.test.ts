import { runMigrations } from "@openconditions/core/server";
import {
  generateInstanceKey,
  InMemoryNonceStore,
  type InstanceKey,
  loadActiveKeys,
  type RecordOutboxEntry,
  signMessage,
  verifyMessage,
} from "@openconditions/federation";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../server.js";
import {
  ownSituation,
  setOutboxAge,
  situationId,
  storeSituation,
  subscribeAll,
} from "./record-fixtures.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let tier1Peer: InstanceKey;
let tier0Peer: InstanceKey;
let stranger: InstanceKey;

const BASE_URL = "https://conditions.example.org";
const ARCHIVE_URL = "https://conditions.example.org/archive";
const ARCHIVE_FILES = {
  situation: `${ARCHIVE_URL}/archive-situation.parquet`,
  feature: `${ARCHIVE_URL}/archive-feature.parquet`,
  offer: `${ARCHIVE_URL}/archive-offer.parquet`,
  observation: `${ARCHIVE_URL}/archive-observation.parquet`,
};
const NOW = "2026-07-13T12:00:00.000Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
    deliveryModes: ["pull"],
    subscriptionFilters: ["bbox"],
    maxEventRate: 10,
    convergenceBound: 300,
  },
};

let enabledEnv: Record<string, string>;

/** Stores one of this instance's situations and backdates its journal entry. */
async function seed(local: string, msAgo: number): Promise<void> {
  await storeSituation(sql, ownSituation(local));
  await setOutboxAge(sql, situationId(local), msAgo, NOW);
}

const ids = (page: { orderedItems: RecordOutboxEntry[] }) =>
  page.orderedItems.map((e) => e.recordId);

/** Signs a peer GET the way the server reconstructs it (baseUrl + path+query). */
async function signedGet(key: InstanceKey, path: string): Promise<Record<string, string>> {
  const s = await signMessage({
    method: "GET",
    url: `${BASE_URL}${path}`,
    headers: {},
    keyId: key.keyId,
    privateKey: key.privateKey,
  });
  return s.headers;
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
  sql = postgres(url, { max: 4 });
  await runMigrations(url);
  await subscribeAll(sql, "sub-backfill-route");

  const now = new Date().toISOString();
  tier1Peer = await generateInstanceKey(now);
  tier0Peer = await generateInstanceKey(now);
  stranger = await generateInstanceKey(now);

  enabledEnv = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(ACTOR_CONFIG),
    OPENCONDITIONS_FEDERATION_ARCHIVE_URL: ARCHIVE_URL,
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([
      {
        instanceId: "peer-tier1",
        actorUrl: "https://a.example.net/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: [tier1Peer.keyId],
      },
      {
        instanceId: "peer-tier0",
        actorUrl: "https://b.example.net/.well-known/openconditions/actor.json",
        trustTier: 0,
        pinnedKeys: [tier0Peer.keyId],
      },
    ]),
  };
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("GET /peer/backfill", () => {
  it("serves 404 when federation is disabled", async () => {
    const app = await build({ sql, env: {}, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/backfill" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unsigned request with 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/peer/backfill" });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).toBeDefined();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a tampered signature with 401", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, now: () => NOW });
    try {
      const headers = await signedGet(tier1Peer, "/peer/backfill");
      // Point the signature at a different path than the one requested.
      const res = await app.inject({
        method: "GET",
        url: "/peer/backfill?limit=5",
        headers,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an unpinned peer with 401 (unknown-key)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, now: () => NOW });
    try {
      const headers = await signedGet(stranger, "/peer/backfill");
      const res = await app.inject({ method: "GET", url: "/peer/backfill", headers });
      expect(res.statusCode).toBe(401);
      expect(res.headers["federation-reason"]).toBe("unknown-key");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("serves a Tier-1 peer a signed page within 30 days, redirecting older to the archive", async () => {
    await seed("bf-route-recent", 10 * DAY);
    await seed("bf-route-old", 45 * DAY);

    const app = await build({ sql, env: enabledEnv, logger: false, now: () => NOW });
    try {
      const path = "/peer/backfill?limit=500";
      const headers = await signedGet(tier1Peer, path);
      const res = await app.inject({ method: "GET", url: path, headers });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/activity+json");

      const page = res.json();
      expect(ids(page)).toContain(situationId("bf-route-recent"));
      expect(ids(page)).not.toContain(situationId("bf-route-old"));
      const recent = page.orderedItems.find(
        (e: RecordOutboxEntry) => e.recordId === situationId("bf-route-recent"),
      );
      expect(recent).toMatchObject({ recordClass: "situation", operation: "create" });
      expect(recent.record.id).toBe(situationId("bf-route-recent"));
      expect(page.beyondWindow).toBe(true);
      expect(page.archiveUrl).toEqual(ARCHIVE_FILES);

      const [key] = await loadActiveKeys(sql, NOW);
      const verified = await verifyMessage({
        method: "GET",
        url: `${BASE_URL}/peer/backfill`,
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

  it("takes the tier from the pinned record: a Tier-0 peer only gets the last 24 hours", async () => {
    await seed("bf-route-t0-fresh", 2 * HOUR);
    await seed("bf-route-t0-2day", 2 * DAY);

    const app = await build({ sql, env: enabledEnv, logger: false, now: () => NOW });
    try {
      // A bogus tier=2 query param must be ignored — the tier is the pin's.
      const path = "/peer/backfill?limit=500&tier=2";
      const headers = await signedGet(tier0Peer, path);
      const res = await app.inject({ method: "GET", url: path, headers });
      expect(res.statusCode).toBe(200);

      const page = res.json();
      expect(ids(page)).toContain(situationId("bf-route-t0-fresh"));
      expect(ids(page)).not.toContain(situationId("bf-route-t0-2day"));
      expect(page.beyondWindow).toBe(true);
      expect(page.archiveUrl).toEqual(ARCHIVE_FILES);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects malformed query parameters with 400 (after authenticating)", async () => {
    const app = await build({ sql, env: enabledEnv, logger: false, now: () => NOW });
    try {
      const path = "/peer/backfill?after=abc";
      const headers = await signedGet(tier1Peer, path);
      const res = await app.inject({ method: "GET", url: path, headers });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 30_000);
});
