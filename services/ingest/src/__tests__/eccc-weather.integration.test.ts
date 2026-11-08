import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { readOutbox } from "@openconditions/federation";
import {
  type EgressRecord,
  publicRecords,
  readCatalogDir,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import {
  type ArchivableRecord,
  publishedRecords,
  recordArchiveBuffer,
} from "@openconditions/publishers";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import { weatherDomain } from "@openconditions/weather";
import Fastify from "fastify";
import { parquetReadObjects } from "hyparquet";
import { fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, runSource } from "../pipeline/run.js";

const root = join(import.meta.dirname, "../../../..");
const file = readCatalogDir(join(root, "feeds"), [weatherDomain], {
  otherDomains: "ignore",
}).files.find((f) => f.domain === "weather" && f.region === "ca")!;
const feed = toCatalogFeed(file.feeds[0]!, {
  domain: file.domain,
  region: file.region,
  file: file.path,
  maintainers: [],
});
feed.requestLimits = { perMinute: 6000 };
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(root, "packages/weather/src/__tests__/fixtures/eccc", name), "utf8"),
  );
const sites = fixture("stations.json");
const status = fixture("caab.json");
status.numberMatched = status.numberReturned = 1;
status.links = [];
let db: TestDatabase;
let app: ReturnType<typeof Fastify>;
let at = "2026-11-08T01:10:00Z";
const roles = createRoleState();

let currentSites = sites;
let currentStatus = status;
let broken = false;
const requests: { url: string; validator: string | null }[] = [];
const upstream = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, validator: new Headers(init?.headers).get("if-none-match") });
  if (broken) return new Response("unavailable", { status: 503 });
  return new Response(
    JSON.stringify(url.includes("swob-stations") ? currentSites : currentStatus),
    { headers: { etag: `"${at}"` } },
  );
}) as typeof fetch;
const poll = () =>
  runSource(feed, {
    sql: db.sql,
    fetch: upstream,
    lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
    now: () => at,
    roles,
    model: { registry: productionRegistry(), instanceId: "test.local" },
  });
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [feed]);
  await db.sql`INSERT INTO conditions.federation_subscription
    (id, peer_id, filter, delivery_mode, created_at, updated_at)
    VALUES ('eccc-test', 'test-peer', ${db.sql.json({ properties: ["weather.air_temperature", "weather.humidity", "weather.wind_speed", "weather.wind_direction", "weather.precipitation_amount"] })}, 'pull', now(), now())`;

  app = Fastify();
  registerScope(app, "operator-test-token".repeat(4));
  registerApiRoutes(app, db.sql, {
    registry: productionRegistry(),
    now: () => new Date(at),
    catalog: { sources: [feed] },
  });
  await app.ready();
}, 120000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});
test("actual acquisition, status joins, public API, expiry and atomic rollback", async () => {
  expect((await poll()).error).toBeUndefined();
  expect(requests[1]!.url).toContain("2026-11-07T23:40:00Z/2026-11-08T01:10:00Z");
  const sources = await app.inject({ url: "/sources" });
  expect(sources.statusCode).toBe(200);
  expect(sources.body).toContain("LicenseRef-ECCC-Data-Servers-End-use");
  const features = await app.inject({ url: "/features?source=ca-eccc-weather&expand=latest" });
  expect(features.statusCode).toBe(200);
  expect(features.body).toContain("1.8");
  const latest = () => app.inject({ url: "/observations/latest?source=ca-eccc-weather" });
  expect((await latest()).json().records).toHaveLength(5);
  const journal =
    await db.sql`SELECT snapshot FROM conditions.federation_outbox WHERE snapshot #>> '{provenance,sourceId}' = ${feed.id}`;
  expect(journal.length).toBeGreaterThanOrEqual(2);
  expect(publicRecords(journal.map((r) => r.snapshot as EgressRecord))).toHaveLength(
    journal.length,
  );
  expect(JSON.stringify(journal)).not.toContain("DFO");
  const storedFeatures =
    await db.sql`SELECT record FROM conditions.feature WHERE source_id=${feed.id} AND tombstoned_at IS NULL`;
  const records = storedFeatures.map((r) => r.record as ArchivableRecord);
  expect(publishedRecords("feature", records, at)).toHaveLength(2);
  const denied = records.map((r) => ({
    ...r,
    provenance: { ...r.provenance, upstream: [{ publisher: "uncleared", license: "NOASSERTION" }] },
  }));
  expect(publishedRecords("feature", denied, at)).toHaveLength(0);
  const bytes = recordArchiveBuffer("feature", records, at);
  const archived = await parquetReadObjects({ file: bytes.buffer as ArrayBuffer });
  expect(archived).toHaveLength(2);
  expect(JSON.stringify(archived)).toContain("LicenseRef-ECCC-Data-Servers-End-use");
  at = "2026-11-08T01:20:00Z";
  currentStatus = structuredClone(status);
  currentStatus.features[0].properties.air_temp = 2;
  currentStatus.features[0].properties.processed_date_tm = "2026-11-08T01:15:00Z";
  expect((await poll()).error).toBeUndefined();
  expect(requests.filter((r) => r.url.includes("swob-stations"))).toHaveLength(1);
  expect((await latest()).body).toContain('"value":2');
  const before = deserialize(serialize(roles));
  const [journalBefore] = await db.sql`SELECT count(*)::int AS n FROM conditions.federation_outbox`;

  const format = weatherDomain.formats["eccc-swob"]!;
  const parseStatus = format.parseStatus!;
  const spy = vi.spyOn(format, "parseStatus").mockImplementation((...args) => {
    const out = parseStatus(...args);
    out.observations[0]!["result"] = { type: "quantity", value: 2, unit: "invalid" };
    return out;
  });
  at = "2026-11-08T01:30:00Z";
  expect((await poll()).error).toContain("atomic candidate rejected");
  expect(requests.at(-1)!.validator).toBeNull();
  spy.mockRestore();
  const [journalAfter] = await db.sql`SELECT count(*)::int AS n FROM conditions.federation_outbox`;
  expect(journalAfter!.n).toBe(journalBefore!.n);

  expect(roles).toEqual(before);
  expect((await latest()).body).toContain('"value":2');
  // A failed parse does not accept its validators or payload/index state.
  currentStatus = { ...status, numberMatched: 999 };
  at = "2026-11-08T01:40:00Z";
  expect((await poll()).error).toContain("incomplete");
  expect(roles).toEqual(before);
  currentStatus = { ...status, features: [], numberMatched: 0, numberReturned: 0 };
  expect((await poll()).error).toBeUndefined();
  expect((await latest()).json().records).toHaveLength(5);
  // Canonical failure during a full refresh must preserve features and retained readings together.
  roles.lastFetchedAt["sites"] = 0;
  const fullBefore = deserialize(serialize(roles));
  const parse = format.parse;
  const fullSpy = vi.spyOn(format, "parse").mockImplementation((...args) => {
    const out = parse(...args);
    out.features[0]!["kind"] = "invalid";
    return out;
  });
  at = "2026-11-08T01:45:00Z";
  expect((await poll()).error).toContain("atomic candidate rejected");
  fullSpy.mockRestore();
  expect(roles).toEqual(fullBefore);
  expect((await poll()).error).toBeUndefined();
  expect(requests.filter((r) => r.url.includes("swob-stations")).at(-1)!.validator).toContain(
    "01:10:00",
  );
  expect((await latest()).json().records).toHaveLength(5);
  const geo = await app.inject({ url: "/features.geojson?source=ca-eccc-weather" });
  expect(geo.statusCode).toBe(200);
  expect(geo.body).toContain("8400416");
  at = "2026-11-08T01:59:59Z";
  expect((await latest()).json().records).toHaveLength(5);
  at = "2026-11-08T02:00:00Z";
  // No poll: expiry is enforced at the read boundary even through an outage or process restart.
  expect((await latest()).json().records).toHaveLength(0);
  const [stored] =
    await db.sql`SELECT expires_at FROM conditions.observation_latest WHERE source_id=${feed.id} LIMIT 1`;
  expect(new Date(stored!.expires_at).toISOString()).toBe("2026-11-08T02:00:00.000Z");
  broken = true;
  await poll();
  const [n] =
    await db.sql`SELECT count(*)::int AS n FROM conditions.feature WHERE source_id=${feed.id} AND tombstoned_at IS NULL`;
  expect(n!.n).toBe(2);
  broken = false;
  // Only a complete metadata inventory can remove a feature. Status alone never does.
  at = "2026-11-09T02:00:00Z";
  currentSites = { ...sites, features: [sites.features[0]], numberMatched: 1, numberReturned: 1 };
  expect((await poll()).error).toBeUndefined();
  const [remaining] =
    await db.sql`SELECT count(*)::int AS n FROM conditions.feature WHERE source_id=${feed.id} AND tombstoned_at IS NULL`;
  expect(remaining!.n).toBe(1);
});

// Network qualification is separate from the deterministic full gate.
test.runIf(process.env["ECCC_LIVE"] === "1")(
  "current public GeoMet acquisition through PostGIS and API",
  async () => {
    at = new Date().toISOString();
    const live = { ...feed, id: "ca-eccc-live-weather" };
    await syncSources(db.sql, [live]);
    const result = await runSource(live, {
      sql: db.sql,
      fetch: undiciFetch as unknown as typeof fetch,
      now: () => at,
      roles: createRoleState(),
      model: { registry: productionRegistry(), instanceId: "test.local" },
    });
    expect(result.error).toBeUndefined();
    const features = await app.inject({
      url: "/features?source=ca-eccc-live-weather&expand=latest",
    });
    const readings = await app.inject({ url: "/observations/latest?source=ca-eccc-live-weather" });
    expect(features.statusCode).toBe(200);
    expect(readings.statusCode).toBe(200);
    expect(readings.json().records.length).toBeGreaterThan(0);
    process.stdout.write(
      "ECCC_LIVE_QUALIFICATION " +
        JSON.stringify({
          at,
          result,
          features: features.json().records.length,
          readings: readings.json().records.length,
        }),
    );
  },
  120000,
);

test("complete feature absence ends retained fresh readings", async () => {
  at = "2026-11-08T01:10:00Z";
  const isolated = { ...feed, id: "ca-eccc-withdraw-weather" };
  await syncSources(db.sql, [isolated]);
  const state = createRoleState();
  currentSites = sites;
  currentStatus = status;
  const run = () =>
    runSource(isolated, {
      sql: db.sql,
      fetch: upstream,
      lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      now: () => at,
      roles: state,
      model: { registry: productionRegistry(), instanceId: "test.local" },
    });
  expect((await run()).error).toBeUndefined();
  at = "2026-11-08T01:20:00Z";
  state.lastFetchedAt["sites"] = 0;
  currentSites = { ...sites, features: [sites.features[1]], numberMatched: 1, numberReturned: 1 };
  expect((await run()).error).toBeUndefined();
  const response = await app.inject({
    url: "/observations/latest?source=ca-eccc-withdraw-weather",
  });
  expect(response.json().records).toHaveLength(0);
});

test("acquisition aborts an oversized response and restores held state", async () => {
  at = "2026-11-08T01:10:00Z";
  currentSites = sites;
  currentStatus = status;
  const bounded = {
    ...feed,
    id: "ca-eccc-byte-limit-weather",
    endpoints: { ...feed.endpoints, status: { ...feed.endpoints["status"], maxResponseBytes: 64 } },
  };
  const state = createRoleState();
  const result = await runSource(bounded, {
    sql: db.sql,
    fetch: upstream,
    lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
    now: () => at,
    roles: state,
    model: { registry: productionRegistry(), instanceId: "test.local" },
  });
  expect(result.error).toMatch(/exceeded|exceeds/);
  expect(state).toEqual(createRoleState());
});

test.each([false, true])(
  "durable correction suppression and ranking, reverse=%s",
  async (reverse) => {
    const isolated = { ...feed, id: `ca-eccc-revisions-${reverse}-weather` };
    await syncSources(db.sql, [isolated]);
    let state = createRoleState();
    currentSites = sites;
    currentStatus = structuredClone(status);
    at = "2026-11-08T01:10:00Z";
    const run = () =>
      runSource(isolated, {
        sql: db.sql,
        fetch: upstream,
        lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
        now: () => at,
        roles: state,
        model: { registry: productionRegistry(), instanceId: "test.local" },
      });
    const latest = async () =>
      (await app.inject({ url: `/observations/latest?source=${isolated.id}` })).json().records;
    const temp = async () =>
      (await latest()).filter(
        (r: Record<string, unknown>) => r["property"] === "weather.air_temperature",
      );
    expect((await run()).error).toBeUndefined();
    const [initial] =
      await db.sql`SELECT series_id FROM conditions.observation_latest WHERE source_id=${isolated.id} AND property='weather.air_temperature'`;
    const correction = structuredClone(status.features[0]);
    correction.id = correction.properties.id = "suppressed.xml";
    Object.assign(correction.properties, {
      "air_temp-qa": -10,
      "cor-value": "CCA",
      processed_date_tm: "2026-11-08T01:15:00Z",
    });
    // A previous acceptable measurement must not become the fallback either.
    const older = structuredClone(status.features[0]);
    older.id = older.properties.id = "older.xml";
    Object.assign(older.properties, {
      "date_tm-value": "2026-11-08T00:55:00Z",
      obs_date_tm: "2026-11-08T00:55:00Z",
    });
    const rows = [older, status.features[0], correction];
    currentStatus = {
      ...status,
      features: reverse ? rows.reverse() : rows,
      numberMatched: 3,
      numberReturned: 3,
    };
    at = "2026-11-08T01:20:00Z";
    expect((await run()).error).toBeUndefined();
    expect(await temp()).toHaveLength(0);
    expect(await latest()).toHaveLength(4);
    const page = await readOutbox(db.sql, { now: at, limit: 500 });
    expect(page.orderedItems.every((e) => !JSON.stringify(e).includes("NOASSERTION"))).toBe(true);
    // The correction journals expiry of the earlier public reading for peers.
    const journal = await db.sql`SELECT snapshot FROM conditions.federation_outbox
    WHERE snapshot #>> '{provenance,sourceId}'=${isolated.id} AND property='weather.air_temperature' ORDER BY seq DESC LIMIT 1`;
    expect(Date.parse(journal[0]!.snapshot.freshness.expiresAt)).toBe(Date.parse(at));
    const stored =
      await db.sql`SELECT conditions.observation_record(template, reading) AS record FROM conditions.observation_latest WHERE source_id=${isolated.id}`;
    expect(
      publishedRecords(
        "observation",
        stored.map((r) => r.record as ArchivableRecord),
        at,
      ),
    ).toHaveLength(4);
    const expanded = await app.inject({ url: `/features?source=${isolated.id}&expand=latest` });
    expect(expanded.body).not.toContain('"value":1.8');
    // Restart the worker state and replay an older revision from a new acquisition.
    state = createRoleState();
    currentStatus = structuredClone(status);
    at = "2026-11-08T01:25:00Z";
    expect((await run()).error).toBeUndefined();
    expect(await temp()).toHaveLength(0);
    // A higher correction restores exact zero on the same stable series.
    currentStatus = structuredClone(status);
    Object.assign(currentStatus.features[0].properties, {
      air_temp: 0,
      "cor-value": "CCB",
      processed_date_tm: "2026-11-08T01:26:00Z",
    });
    at = "2026-11-08T01:30:00Z";
    expect((await run()).error).toBeUndefined();
    expect((await temp())[0].result.value).toBe(0);
    const [restored] =
      await db.sql`SELECT series_id FROM conditions.observation_latest WHERE source_id=${isolated.id} AND property='weather.air_temperature'`;
    expect(restored!.series_id).toBe(initial!.series_id);
    currentStatus = structuredClone(status);
    at = "2026-11-08T01:40:00Z";
    expect((await run()).error).toBeUndefined();
    expect((await temp())[0].result.value).toBe(0);
    // Equal rank conflict is refused atomically across polls.
    Object.assign(currentStatus.features[0].properties, {
      air_temp: 9,
      "cor-value": "CCB",
      processed_date_tm: "2026-11-08T01:26:00Z",
    });
    const before = deserialize(serialize(state));
    at = "2026-11-08T01:45:00Z";
    expect((await run()).error).toContain("ambiguous");
    expect(state).toEqual(before);
    expect((await temp())[0].result.value).toBe(0);
    // New measurement outranks an old clock's higher correction; absent humidity is retained.
    currentStatus = structuredClone(status);
    Object.assign(currentStatus.features[0].properties, {
      air_temp: 3,
      "date_tm-value": "2026-11-08T01:40:00Z",
      obs_date_tm: "2026-11-08T01:40:00Z",
      processed_date_tm: "2026-11-08T01:41:00Z",
    });
    delete currentStatus.features[0].properties.rel_hum;
    delete currentStatus.features[0].properties["rel_hum-qa"];
    at = "2026-11-08T01:50:00Z";
    expect((await run()).error).toBeUndefined();
    expect((await temp())[0].result.value).toBe(3);
    expect(await latest()).toHaveLength(5);
  },
);

test("rights-changing retained features refuse the whole generation and all public surfaces stay coherent", async () => {
  const isolated = { ...feed, id: "ca-eccc-rights-weather" };
  await syncSources(db.sql, [isolated]);
  const state = createRoleState();
  currentSites = sites;
  currentStatus = status;
  at = "2026-11-08T01:10:00Z";
  const run = () =>
    runSource(isolated, {
      sql: db.sql,
      fetch: upstream,
      lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      now: () => at,
      roles: state,
      model: { registry: productionRegistry(), instanceId: "test.local" },
    });
  expect((await run()).error).toBeUndefined();
  state.lastFetchedAt["sites"] = 0;
  const before = deserialize(serialize(state));
  const snapshot =
    async () => db.sql`SELECT (SELECT jsonb_agg(record ORDER BY id) FROM conditions.feature WHERE source_id=${isolated.id}) AS features,
    (SELECT jsonb_agg(reading ORDER BY series_id) FROM conditions.observation_latest WHERE source_id=${isolated.id}) AS readings,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY property) FROM conditions.observation_revision r WHERE source_id=${isolated.id}) AS authority,
    (SELECT count(*) FROM conditions.federation_outbox) AS journal`;
  const held = await snapshot();
  const format = weatherDomain.formats["eccc-swob"]!;
  const parse = format.parse;
  const spy = vi.spyOn(format, "parse").mockImplementation((...args) => {
    const out = parse(...args);
    out.observations = [];
    for (const f of out.features)
      (f["provenance"] as Record<string, unknown>)["upstream"] = [
        { publisher: "uncleared", license: "NOASSERTION" },
      ];
    return out;
  });
  at = "2026-11-08T01:20:00Z";
  try {
    expect((await run()).error).toContain("retained reading rights");
  } finally {
    spy.mockRestore();
  }
  expect(state).toEqual(before);
  expect(await snapshot()).toEqual(held);
  const featureResponse = await app.inject({
    url: `/features?source=${isolated.id}&expand=latest`,
  });
  expect(featureResponse.json().records).toHaveLength(2);
  expect(featureResponse.body).not.toContain("NOASSERTION");
  // Status-only drafts must agree with the retained feature rights as well.
  state.lastFetchedAt["sites"] = Date.parse(at);
  const statusBefore = deserialize(serialize(state));
  const parseStatus = format.parseStatus!;
  const statusSpy = vi.spyOn(format, "parseStatus").mockImplementation((...args) => {
    const out = parseStatus(...args);
    for (const r of out.observations)
      (r["provenance"] as Record<string, unknown>)["upstream"] = [
        { publisher: "uncleared", license: "NOASSERTION" },
      ];
    return out;
  });
  at = "2026-11-08T01:30:00Z";
  try {
    expect((await run()).error).toContain("reading and feature rights differ");
  } finally {
    statusSpy.mockRestore();
  }
  expect(state).toEqual(statusBefore);
  expect(await snapshot()).toEqual(held);
  const response = await app.inject({ url: `/observations/latest?source=${isolated.id}` });
  expect(response.json().records).toHaveLength(5);
  expect(response.body).not.toContain("NOASSERTION");
  const records = (
    await db.sql`SELECT record FROM conditions.feature WHERE source_id=${isolated.id}`
  ).map((r) => r.record as ArchivableRecord);
  const bytes = recordArchiveBuffer("feature", records, at);
  expect(
    JSON.stringify(await parquetReadObjects({ file: bytes.buffer as ArrayBuffer })),
  ).not.toContain("NOASSERTION");
});
