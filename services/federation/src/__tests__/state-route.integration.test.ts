/**
 * The publisher's record state routes: GET /peer/state lists the live
 * records the outbox may carry to the requester, in byte order of their ids;
 * POST /peer/records answers for named records with the entry the journal
 * would carry for each now. Both behind the gates of /peer/backfill.
 */
import { runMigrations } from "@openconditions/core/server";
import {
  createInMemoryRateLimiter,
  generateInstanceKey,
  InMemoryNonceStore,
  type InstanceKey,
  loadActiveKeys,
  OUTBOX_PAGE_MAX_ENTRY_BYTES,
  readInboundEntry,
  recordStateStatement,
  signMessage,
  verifyMessage,
} from "@openconditions/federation";
import { syncSources } from "@openconditions/storage";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database/profile";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { heldCopiesStatement } from "../reconcile.js";
import { build } from "../server.js";
import {
  ownSituation,
  peerSituation,
  situationId,
  storeSituation,
  subscribeAll,
  tombstoneSituation,
} from "./record-fixtures.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let peerKey: InstanceKey;
let app: FastifyInstance;

const BASE_URL = "https://conditions.example.org";
const NOW = "2026-07-13T12:00:00.000Z";
const PEER = "peer-tier1";
const SOURCE = "nl-ndw-events";

const ACTOR_CONFIG = {
  instanceId: "oc-test",
  baseUrl: BASE_URL,
  operator: "Test Operator",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: { protocolVersion: "0.3", convergenceBound: 300 },
};

let env: Record<string, string>;

async function signedGet(path: string): Promise<Record<string, string>> {
  const s = await signMessage({
    method: "GET",
    url: `${BASE_URL}${path}`,
    headers: {},
    keyId: peerKey.keyId,
    privateKey: peerKey.privateKey,
  });
  return s.headers;
}

const get = async (path: string, target = app) =>
  target.inject({ method: "GET", url: path, headers: await signedGet(path) });

async function post(body: unknown, target = app) {
  const payload = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const s = await signMessage({
    method: "POST",
    url: `${BASE_URL}/peer/records`,
    headers: { "content-type": "application/json" },
    body: payload,
    keyId: peerKey.keyId,
    privateKey: peerKey.privateKey,
  });
  return target.inject({ method: "POST", url: "/peer/records", headers: s.headers, payload });
}

function headerStrings(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** A copy of another instance's situation, as the inbox stores one. */
function foreignCopy(local: string) {
  const record = peerSituation("other.example.net", local);
  const provenance = record["provenance"] as Record<string, unknown>;
  return {
    ...record,
    provenance: {
      ...provenance,
      originChain: [
        { instanceId: "other.example.net", viaPeer: "other.example.net", receivedAt: NOW },
      ],
    },
  };
}

beforeAll(async () => {
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
  sql = postgres(url, { max: 4, onnotice: () => {} });
  await assertPostgisProfile(sql, profile, {
    fixture: "state-route.integration.test",
    containerId: container.getId(),
  });
  await runMigrations(url);
  await subscribeAll(sql, "sub-state-route");
  await syncSources(sql, [
    {
      id: SOURCE,
      domain: "roads",
      format: "datex2",
      product: "events",
      tier: "authoritative",
      country: "NL",
      operator: "NDW",
      license: "CC0-1.0",
      attribution: "NDW",
      restricted: false,
      cadenceSec: 60,
      freshnessWindowSec: 600,
    },
  ]);
  peerKey = await generateInstanceKey(new Date().toISOString());
  env = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: ACTOR_CONFIG.instanceId,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(ACTOR_CONFIG),
    OPENCONDITIONS_FEDERATION_ARCHIVE_URL: `${BASE_URL}/archive`,
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([
      {
        instanceId: PEER,
        actorUrl: "https://a.example.net/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: [peerKey.keyId],
      },
    ]),
  };
  app = await build({ sql, env, logger: false, now: () => NOW });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  await containerStop?.();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation CASCADE`;
  await sql`
    UPDATE conditions.source SET restricted = false, restricted_since = NULL WHERE id = ${SOURCE}`;
});

describe("GET /peer/state", () => {
  it("lists the live records the outbox carries, in byte order across pages", async () => {
    for (const local of ["st-b", "st-a", "st-C", "st-d"]) {
      await storeSituation(sql, ownSituation(local, { revision: 2 }));
    }
    await storeSituation(sql, ownSituation("st-ended"));
    await tombstoneSituation(sql, situationId("st-ended"), "withdrawn");
    await storeSituation(sql, foreignCopy("st-foreign"));
    await storeSituation(sql, ownSituation("st-far", { lon: 100.5 }));
    await storeSituation(sql, ownSituation("st-sharealike", { license: "CC-BY-SA-4.0" }));

    const filter = "bbox=4,51,6,53";
    const first = await get(`/peer/state?class=situation&limit=3&${filter}`);
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(page).toMatchObject({ type: "RecordStatePage", class: "situation" });
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([
      situationId("st-C"),
      situationId("st-a"),
      situationId("st-b"),
    ]);
    expect(page.items[0]).toEqual({
      id: situationId("st-C"),
      revision: 2,
      recordedAt: expect.any(String) as string,
    });
    expect(page.through).toBe(situationId("st-b"));
    const next = new URL(page.next);
    expect(next.origin + next.pathname).toBe(`${BASE_URL}/peer/state`);
    expect(Object.fromEntries(next.searchParams)).toEqual({
      class: "situation",
      after: situationId("st-b"),
      bbox: "4,51,6,53",
      limit: "3",
    });
    // The next page scans the three live rows left; the filter keeps one.
    const rest = (await get(next.pathname + next.search)).json();
    expect(rest.items.map((i: { id: string }) => i.id)).toEqual([situationId("st-d")]);
    expect(rest.through).toBe(situationId("st-sharealike"));
    const last = new URL(rest.next);
    const tail = (await get(last.pathname + last.search)).json();
    expect(tail.items).toEqual([]);
    expect(tail.through).toBeUndefined();
    expect(tail.next).toBeUndefined();

    // The answer is signed and bound to the request.
    const [key] = await loadActiveKeys(sql, NOW);
    const path = `/peer/state?class=situation&limit=3&${filter}`;
    const headers = await signedGet(path);
    const res = await app.inject({ method: "GET", url: path, headers });
    const request = { method: "GET", url: `${BASE_URL}${path}`, headers };
    expect(
      await verifyMessage({
        ...request,
        status: 200,
        isResponse: true,
        request,
        headers: headerStrings(res.headers as Record<string, unknown>),
        body: res.rawPayload,
        resolvePublicKey: async (keyId) => (keyId === key!.keyId ? key!.publicKey : null),
        nonceStore: new InMemoryNonceStore(),
      }),
    ).toEqual({ ok: true, keyId: key!.keyId });
  });

  it("leaves out a restricted source's records", async () => {
    await storeSituation(sql, ownSituation("st-restricted"));
    await sql`UPDATE conditions.source SET restricted = true WHERE id = ${SOURCE}`;
    expect((await get("/peer/state?class=situation")).json().items).toEqual([]);
  });

  it("names through and next on a full scan the filter dropped entirely", async () => {
    await storeSituation(sql, ownSituation("st-x"));
    await storeSituation(sql, ownSituation("st-y"));
    const page = (await get("/peer/state?class=situation&limit=2&bbox=100,0,101,1")).json();
    expect(page.items).toEqual([]);
    expect(page.through).toBe(situationId("st-y"));
    expect(page.next).toBeDefined();
  });

  it("refuses an unsigned request, an unknown or observation class and an unknown parameter", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/peer/state?class=situation" })).statusCode,
    ).toBe(401);
    for (const path of [
      "/peer/state",
      "/peer/state?class=observation",
      "/peer/state?class=camera",
      "/peer/state?class=situation&colour=red",
      "/peer/state?class=situation&limit=0",
    ]) {
      expect((await get(path)).statusCode, path).toBe(400);
    }
  });

  it("counts each request as one journal read", async () => {
    const tight = await build({
      sql,
      env,
      logger: false,
      now: () => NOW,
      rateLimiter: createInMemoryRateLimiter({
        policyForTier: () => ({ inboxPerMin: 1000, backfillPerMin: 1 }),
      }),
    });
    try {
      expect((await get("/peer/state?class=feature", tight)).statusCode).toBe(200);
      const refused = await get("/peer/state?class=offer", tight);
      expect(refused.statusCode).toBe(429);
      expect(refused.headers["retry-after"]).toBeDefined();
    } finally {
      await tight.close();
    }
  });
});

describe("POST /peer/records", () => {
  it("answers each id with the publisher's current state, in request order", async () => {
    await storeSituation(sql, ownSituation("rec-live", { revision: 3, headline: "live" }));
    for (const [local, reason] of [
      ["rec-withdrawn", "withdrawn"],
      ["rec-expired", "expired"],
      ["rec-erased", "rights_revoked"],
    ] as const) {
      await storeSituation(sql, ownSituation(local));
      await tombstoneSituation(sql, situationId(local), reason);
    }
    await storeSituation(sql, foreignCopy("rec-foreign"));
    await storeSituation(sql, ownSituation("rec-sharealike", { license: "CC-BY-SA-4.0" }));

    const ids = [
      "rec-live",
      "rec-withdrawn",
      "rec-expired",
      "rec-erased",
      "rec-missing",
      "rec-foreign",
      "rec-sharealike",
    ].map((l) => situationId(l));
    const res = await post({ class: "situation", ids });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page).toMatchObject({
      type: "RecordsPage",
      class: "situation",
      // A licence that may not leave is not carried, so the record is not named.
      unknown: [
        situationId("rec-missing"),
        situationId("rec-foreign"),
        situationId("rec-sharealike"),
      ],
      unanswered: [],
      withheld: [],
    });
    expect(typeof page.epoch).toBe("string");
    const answers = page.orderedItems.map((e: Record<string, unknown>) => [
      e["recordId"],
      e["operation"],
      e["reason"] ?? null,
      e["revision"] ?? (e["record"] as { revision?: number } | undefined)?.revision,
    ]);
    expect(answers).toEqual([
      [situationId("rec-live"), "create", null, 3],
      [situationId("rec-withdrawn"), "delete", "withdrawn", 2],
      [situationId("rec-expired"), "delete", "expired", 2],
      [situationId("rec-erased"), "delete", "rights_revoked", 2],
    ]);
    // Every entry is one a subscriber's reader accepts.
    for (const item of page.orderedItems) expect(readInboundEntry(item).ok).toBe(true);
    expect(page.orderedItems[0]).toMatchObject({ txid: "0", seq: 0, createdAt: NOW });
  });

  it("does not name a live record whose source turned restricted", async () => {
    await storeSituation(sql, ownSituation("rec-restricted", { revision: 4 }));
    await sql`UPDATE conditions.source SET restricted = true WHERE id = ${SOURCE}`;
    const ids = [situationId("rec-restricted")];
    const page = (await post({ class: "situation", ids })).json();
    expect(page).toMatchObject({ orderedItems: [], unknown: ids });
  });

  it("names no record a peer could never have held, not even by a delete", async () => {
    // The source is restricted before these records are stored: nothing of
    // them is journalled, and no peer can hold them.
    await sql`
      UPDATE conditions.source SET restricted = true, restricted_since = now() - interval '1 day'
       WHERE id = ${SOURCE}`;
    await storeSituation(sql, ownSituation("never-live"));
    await storeSituation(sql, ownSituation("never-ended"));
    await tombstoneSituation(sql, situationId("never-ended"), "withdrawn");
    const ids = [situationId("never-live"), situationId("never-ended")];
    const page = (await post({ class: "situation", ids })).json();
    expect(page).toMatchObject({ orderedItems: [], unknown: ids });
  });

  it("keeps to the page budget, leaving the rest unanswered and withholding what never fits", async () => {
    const big = "x".repeat(400_000);
    for (const local of ["big-1", "big-2", "big-3"]) {
      await storeSituation(sql, ownSituation(local, { headline: big }));
    }
    await storeSituation(
      sql,
      ownSituation("too-big", { headline: "x".repeat(OUTBOX_PAGE_MAX_ENTRY_BYTES) }),
    );
    const ids = ["too-big", "big-1", "big-2", "big-3"].map((l) => situationId(l));
    const res = await post({ class: "situation", ids });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.withheld).toEqual([situationId("too-big")]);
    expect(page.orderedItems.map((e: { recordId: string }) => e.recordId)).toEqual([
      situationId("big-1"),
      situationId("big-2"),
    ]);
    expect(page.unanswered).toEqual([situationId("big-3")]);
    expect(res.rawPayload.byteLength).toBeLessThan(1_048_576);
  });

  it("refuses a malformed request", async () => {
    const ids = [situationId("a")];
    for (const body of [
      "not json",
      [],
      { class: "situation" },
      { class: "situation", ids: [] },
      { class: "situation", ids: [""] },
      { class: "situation", ids: ["a", "a"] },
      { class: "situation", ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) },
      { class: "situation", ids: ["x".repeat(513)] },
      { class: "observation", ids },
      { class: "situation", ids, more: true },
    ]) {
      expect((await post(body)).statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const unsigned = await app.inject({
      method: "POST",
      url: "/peer/records",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ class: "situation", ids }),
    });
    expect(unsigned.statusCode).toBe(401);
  });
});

describe("reading records in byte order of their ids", () => {
  it("walks the byte-order index for a listing page and for the copies a page covers", async () => {
    await storeSituation(sql, ownSituation("plan-seed"));
    // Enough rows that sorting the class would cost more than walking the index.
    await sql`
      INSERT INTO conditions.situation
      SELECT (jsonb_populate_record(s, jsonb_build_object(
                'id', s.id || '-' || lpad(g::text, 5, '0'),
                'instance_id', CASE WHEN g % 2 = 0 THEN 'peer.example.net' ELSE s.instance_id END))).*
        FROM conditions.situation s, generate_series(1, 20000) g
       WHERE s.id = ${situationId("plan-seed")}`;
    await sql`ANALYZE conditions.situation`;
    const plans: string[] = [];
    const explain = async (statement: { text: string; params: unknown[] }) => {
      const plan = await sql.unsafe(
        `EXPLAIN (FORMAT JSON) ${statement.text}`,
        statement.params as never,
      );
      plans.push(JSON.stringify(plan));
      return JSON.stringify(plan);
    };
    const after = situationId("plan-seed-10000");
    const through = situationId("plan-seed-11000");
    for (const statement of [
      recordStateStatement("situation", undefined, 1000),
      recordStateStatement("situation", after, 1000),
      heldCopiesStatement("situation", "peer.example.net", after, through),
    ]) {
      const plan = await explain(statement);
      expect(plan, statement.text).toContain('"Index Name":"idx_situation_id_bytes"');
      expect(plan, statement.text).not.toContain('"Node Type":"Sort"');
    }
  }, 60_000);
});
