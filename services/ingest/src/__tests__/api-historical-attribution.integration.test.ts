import { observationId } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { rollupObservations, writeSnapshot } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { siteKey, writeSiteReadings } from "./helpers/flow-series.js";

type HistoricalReading = {
  result: { value: number };
  provenance: {
    attribution: { provider: string; license: string };
    upstream?: unknown[];
    mergedSources?: unknown[];
  };
};
type HistoricalBucket = { mean: number; provenance: HistoricalReading["provenance"][] };
const bodyOf = (response: { json(): unknown }) =>
  response.json() as {
    records: HistoricalReading[];
    rollups: HistoricalBucket[];
    next: string | null;
  };
let db: TestDatabase;
let app: ReturnType<typeof Fastify>;
const registry = productionRegistry();
const now = new Date("2026-10-01T18:00:00Z");
const token = "test-operator-token".repeat(3);
const source = "nl-ndw-flow";
const geometry = { type: "Point" as const, coordinates: [4.5, 52] };
const url = (resolution = "raw", extra = "") =>
  `/observations?subject=${encodeURIComponent(siteKey(source, "history"))}&property=traffic.speed&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&resolution=${resolution}${extra}`;
const get = (resolution = "raw", extra = "", operator = false) =>
  app.inject({
    url: url(resolution, extra),
    ...(operator ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
const write = (
  at: string,
  provider: string,
  license: string,
  speed: number,
  upstream?: { publisher: string; license: string; attribution?: string }[],
) =>
  writeSiteReadings(
    db.sql,
    source,
    [
      {
        site: "history",
        geometry,
        at,
        speed,
        attribution: { provider, license, url: `https://example.test/${provider}` },
        upstream,
      },
    ],
    now.toISOString(),
  );
beforeAll(async () => {
  db = await createTestDatabase();
  app = Fastify();
  registerScope(app, token);
  registerApiRoutes(app, db.sql, { registry, now: () => now });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});
beforeEach(async () => {
  await db.sql`TRUNCATE conditions.observation_latest, conditions.observation, conditions.observation_rollup_progress CASCADE`;
});

it("keeps each raw reading's acquired publisher, URL, licence and upstream despite newer terms", async () => {
  await write("2026-10-01T08:00:00Z", "earlier", "CC0-1.0", 40, [
    { publisher: "original", license: "CC-BY-4.0", attribution: "Original notice" },
  ]);
  await write("2026-10-01T08:30:00Z", "later", "CC-BY-4.0", 60);
  const response = await get();
  expect(response.statusCode).toBe(200);
  const readings = bodyOf(response).records;
  expect(readings.map((r) => r.provenance.attribution)).toEqual([
    expect.objectContaining({
      provider: "earlier",
      license: "CC0-1.0",
      url: "https://example.test/earlier",
    }),
    expect.objectContaining({ provider: "later", license: "CC-BY-4.0" }),
  ]);
  expect(readings[0].provenance.upstream).toEqual([
    { publisher: "original", license: "CC-BY-4.0", attribution: "Original notice" },
  ]);
  expect(readings[1].provenance.upstream).toBeUndefined();
  expect(response.headers["x-data-license"]).toBe("CC-BY-4.0, CC0-1.0");
  const page = await get("raw", "&limit=1");
  expect(page.headers["x-data-license"]).toBe("CC-BY-4.0, CC0-1.0");
});

it("unions historical receipts per hourly bucket instead of borrowing the latest template", async () => {
  await write("2026-10-01T08:00:00Z", "earlier", "CC0-1.0", 40);
  await write("2026-10-01T08:30:00Z", "later", "CC-BY-4.0", 60);
  await write("2026-10-01T09:00:00Z", "newest", "CC0-1.0", 80);
  await rollupObservations(db.sql, { registry, period: "hourly", now });
  const response = await get("hourly");
  expect(response.statusCode).toBe(200);
  const buckets = bodyOf(response).rollups;
  expect(buckets[0]).toMatchObject({ sampleCount: 2, mean: 50, lineageComplete: true });
  expect(buckets[0].provenance.map((p) => p.attribution.provider).sort()).toEqual([
    "earlier",
    "later",
  ]);
  expect(buckets[1].provenance.map((p) => p.attribution.provider)).toEqual(["newest"]);
  expect(response.headers["x-data-license"]).toBe("CC-BY-4.0, CC0-1.0");
});

it("gates historical samples and whole aggregate buckets by their own upstream terms", async () => {
  await write("2026-10-01T08:00:00Z", "restricted", "CC0-1.0", 10, [
    { publisher: "upstream", license: "ODbL-1.0" },
  ]);
  await write("2026-10-01T08:30:00Z", "public", "CC0-1.0", 90);
  await write("2026-10-01T09:00:00Z", "public", "CC0-1.0", 70);
  expect(bodyOf(await get()).records.map((r) => r.result.value)).toEqual([90, 70]);
  expect(bodyOf(await get("raw", "", true)).records).toHaveLength(3);
  await rollupObservations(db.sql, { registry, period: "hourly", now });
  expect(bodyOf(await get("hourly")).rollups.map((r) => r.mean)).toEqual([70]);
  const operator = bodyOf(await get("hourly", "", true)).rollups;
  expect(operator[0]).toMatchObject({ mean: 50, lineageComplete: true });
  expect(operator[0].provenance).toHaveLength(2);
});

it("preserves immutable receipt identity when only an unprojected permission licence changes", async () => {
  await write("2026-10-01T08:00:00Z", "same", "CC0-1.0", 40);
  await write("2026-10-01T08:30:00Z", "same", "ODbL-1.0", 60);
  expect(bodyOf(await get()).records.map((r) => r.result.value)).toEqual([40]);
  expect(
    bodyOf(await get("raw", "", true)).records.map((r) => r.provenance.attribution.license),
  ).toEqual(["CC0-1.0", "ODbL-1.0"]);
});

it("does not invent historical receipts for unknown samples, including mixed buckets", async () => {
  await write("2026-10-01T08:00:00Z", "known", "CC0-1.0", 40);
  await write("2026-10-01T08:30:00Z", "known", "CC0-1.0", 60);
  await db.sql`UPDATE conditions.observation SET extra = extra #- '{provenance,creditReceiptId}'
    WHERE phenomenon_start = '2026-10-01T08:00:00Z'`;
  expect(bodyOf(await get()).records.map((r) => r.result.value)).toEqual([60]);
  const operator = bodyOf(await get("raw", "", true)).records;
  expect(operator[0].provenance.attribution.license).toBe("NOASSERTION");
  await rollupObservations(db.sql, { registry, period: "hourly", now });
  const response = await get("hourly");
  expect(response.json().rollups).toEqual([]);
  expect(response.headers["x-data-license"]).toBe("none");
  const operatorRollup = await get("hourly", "", true);
  expect(bodyOf(operatorRollup).rollups[0]).toMatchObject({
    mean: 50,
    lineageComplete: false,
  });
  expect(operatorRollup.headers["x-data-license"]).toBe("CC0-1.0, NOASSERTION");
});

it("captures out-of-order historical acquisitions independently of the newest sample", async () => {
  await writeSiteReadings(
    db.sql,
    source,
    [
      {
        site: "history",
        geometry,
        at: "2026-10-01T08:30:00Z",
        speed: 60,
        attribution: { provider: "later", license: "CC0-1.0" },
      },
      {
        site: "history",
        geometry,
        at: "2026-10-01T08:00:00Z",
        speed: 40,
        attribution: { provider: "earlier", license: "CC-BY-4.0" },
      },
    ],
    now.toISOString(),
  );
  expect(bodyOf(await get()).records.map((r) => r.provenance.attribution.provider)).toEqual([
    "earlier",
    "later",
  ]);
});

it("keeps a publisher transition in change-only history even when the value stays the same", async () => {
  for (const [at, provider] of [
    ["2026-10-01T08:00:00Z", "earlier"],
    ["2026-10-01T08:30:00Z", "later"],
  ]) {
    await writeSiteReadings(
      db.sql,
      source,
      [
        {
          site: "history",
          geometry,
          at,
          los: "free_flow",
          attribution: { provider, license: "CC0-1.0" },
        },
      ],
      now.toISOString(),
    );
  }
  const response = await app.inject({ url: url().replace("traffic.speed", "traffic.los") });
  expect(response.statusCode).toBe(200);
  expect(bodyOf(response).records.map((r) => r.provenance.attribution.provider)).toEqual([
    "earlier",
    "later",
  ]);
});

it("reports only the licences in the served historical page", async () => {
  await write("2026-10-01T08:00:00Z", "earlier", "CC0-1.0", 40);
  await write("2026-10-01T08:30:00Z", "later", "CC-BY-4.0", 60);
  const first = await get("raw", "&limit=1");
  expect(first.headers["x-data-license"]).toBe("CC0-1.0");
  const second = await get("raw", `&limit=1&cursor=${encodeURIComponent(first.json().next)}`);
  expect(second.headers["x-data-license"]).toBe("CC-BY-4.0");
  expect(second.json().next).toBeNull();
});

it("applies the raw-record public merged-source projection to historical rollup provenance", async () => {
  const { observationId } = await import("@openconditions/model");
  const { writeSnapshot } = await import("@openconditions/storage");
  // Prepare the real source and history partitions through the shared acquisition fixture.
  await write("2026-10-01T08:00:00Z", "own", "CC0-1.0", 40);
  const publicMember = {
    source: "public-member",
    recordId: "public-record",
    attribution: { provider: "Public member", license: "CC-BY-4.0" },
  };
  const restrictedMember = {
    source: "restricted-member",
    recordId: "restricted-record-trace",
    attribution: { provider: "Restricted member trace", license: "ODbL-1.0" },
  };
  const draft: Record<string, unknown> = {
    class: "observation",
    kind: "observation",
    temporality: "live",
    property: "traffic.speed",
    subject: { kind: "feature", featureId: `oc:feature:${source}:history` },
    result: { type: "quantity", value: 60, unit: "km/h" },
    phenomenonTime: { instant: "2026-10-01T08:30:00Z" },
    aggregation: "mean",
    location: { geometry, extent: "point", geometryOrigin: "site_table", fuzziness: "exact" },
    provenance: {
      origin: "feed",
      sourceId: source,
      sourceFormat: "datex2",
      accessMode: "bulk",
      recordId: "history",
      attribution: { provider: "own", license: "CC0-1.0" },
      privacy: { class: "authoritative" },
      mergedSources: [publicMember, restrictedMember],
    },
    freshness: { fetchedAt: "2026-10-01T08:30:00Z" },
  };
  draft.id = observationId(source, draft as Parameters<typeof observationId>[1]);
  const written = await writeSnapshot(
    db.sql,
    source,
    { observations: [draft] },
    {
      registry,
      instanceId: "test.local",
      now: now.toISOString(),
      complete: false,
    },
  );
  expect(written.rejected).toEqual([]);
  const raw = bodyOf(await get()).records;
  expect(raw[1].provenance.mergedSources).toEqual([publicMember]);
  await rollupObservations(db.sql, { registry, period: "hourly", now });
  const publicResponse = await get("hourly");
  const bucket = publicResponse.json().rollups[0];
  expect(bucket).toMatchObject({ sampleCount: 2, mean: 50, lineageComplete: true });
  expect(
    bucket.provenance.find((p: { mergedSources?: unknown[] }) => p.mergedSources)?.mergedSources,
  ).toEqual([publicMember]);
  expect(publicResponse.body).not.toContain("restricted-record-trace");
  expect(publicResponse.body).not.toContain("Restricted member trace");
  const operator = bodyOf(await get("hourly", "", true)).rollups[0];
  expect(
    operator.provenance.find((p: { mergedSources?: unknown[] }) => p.mergedSources)?.mergedSources,
  ).toEqual([publicMember, restrictedMember]);
});

it("captures a change-only same-value transition when only merged-source provenance changes", async () => {
  const { observationId } = await import("@openconditions/model");
  const { writeSnapshot } = await import("@openconditions/storage");
  await write("2026-10-01T07:00:00Z", "own", "CC0-1.0", 40);
  const merged = (member: string) => [
    {
      source: member,
      recordId: `${member}-record`,
      attribution: { provider: member, license: "CC0-1.0" },
    },
  ];
  for (const [at, member] of [
    ["2026-10-01T08:00:00Z", "earlier-member"],
    ["2026-10-01T08:30:00Z", "later-member"],
  ] as const) {
    const draft: Record<string, unknown> = {
      class: "observation",
      kind: "observation",
      temporality: "live",
      property: "traffic.los",
      subject: { kind: "feature", featureId: `oc:feature:${source}:history` },
      result: { type: "category", value: "free_flow", vocabulary: "los" },
      phenomenonTime: { instant: at },
      aggregation: "instantaneous",
      location: { geometry, extent: "point", geometryOrigin: "site_table", fuzziness: "exact" },
      provenance: {
        origin: "feed",
        sourceId: source,
        sourceFormat: "datex2",
        accessMode: "bulk",
        recordId: "history",
        attribution: { provider: "own", license: "CC0-1.0" },
        privacy: { class: "authoritative" },
        mergedSources: merged(member),
      },
      freshness: { fetchedAt: at },
    };
    draft.id = observationId(source, draft as Parameters<typeof observationId>[1]);
    const written = await writeSnapshot(
      db.sql,
      source,
      { observations: [draft] },
      {
        registry,
        instanceId: "test.local",
        now: now.toISOString(),
        complete: false,
      },
    );
    expect(written.rejected).toEqual([]);
  }
  const response = await app.inject({
    url: url().replace("property=traffic.speed", "property=traffic.los"),
  });
  expect(response.statusCode).toBe(200);
  expect(
    response
      .json()
      .records.map(
        (r: { result: { value: string }; provenance: { mergedSources?: unknown[] } }) => ({
          value: r.result.value,
          merged: r.provenance.mergedSources,
        }),
      ),
  ).toEqual([
    { value: "free_flow", merged: merged("earlier-member") },
    { value: "free_flow", merged: merged("later-member") },
  ]);
  const receipts =
    await db.sql`SELECT DISTINCT o.extra #>> '{provenance,creditReceiptId}' AS receipt_id
    FROM conditions.observation o JOIN conditions.observation_latest l USING(series_id)
    WHERE l.property='traffic.los' AND l.subject_key=${siteKey(source, "history")}`;
  expect(receipts).toHaveLength(2);
  expect(receipts.every((r) => typeof r.receipt_id === "string")).toBe(true);
});

it("retains daily money-bucket receipts after a publisher change", async () => {
  const sourceId = "es-minetur";
  for (const [at, provider, license, amount] of [
    ["2026-09-30T08:00:00Z", "morning", "CC0-1.0", "1.4000"],
    ["2026-09-30T12:00:00Z", "afternoon", "CC-BY-4.0", "1.6000"],
  ]) {
    const draft = {
      class: "observation",
      kind: "observation",
      property: "fuel.price",
      temporality: "live",
      subject: { kind: "feature", featureId: `oc:feature:${sourceId}:history`, componentKey: "e5" },
      phenomenonTime: { instant: at },
      aggregation: "instantaneous",
      result: { type: "money", amount, currency: "EUR", per: "L" },
      location: { geometry, extent: "point", geometryOrigin: "source", fuzziness: "exact" },
      provenance: {
        origin: "feed",
        sourceId,
        sourceFormat: "datex2",
        accessMode: "bulk",
        recordId: "history",
        attribution: { provider, license },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: now.toISOString() },
    };
    const written = await writeSnapshot(
      db.sql,
      sourceId,
      { observations: [{ ...draft, id: observationId(sourceId, draft as never) }] },
      { registry, now: now.toISOString(), instanceId: "test.local", complete: false },
    );
    expect(written.rejected).toEqual([]);
  }
  await rollupObservations(db.sql, { registry, period: "daily", now });
  const response = await app.inject(
    `/observations?subject=oc:feature:${sourceId}:history&component=e5&property=fuel.price&from=2026-09-30T00:00:00Z&to=2026-10-01T00:00:00Z&resolution=daily`,
  );
  expect(response.statusCode).toBe(200);
  const [bucket] = bodyOf(response).rollups;
  expect(bucket).toMatchObject({ mean: 1.5, sampleCount: 2, lineageComplete: true });
  expect(bucket.provenance.map((p) => p.attribution.provider).sort()).toEqual([
    "afternoon",
    "morning",
  ]);
  expect(response.headers["x-data-license"]).toBe("CC-BY-4.0, CC0-1.0");
});

it("publishes credit-only historical snapshots without internal rights evidence", async () => {
  await writeSiteReadings(
    db.sql,
    source,
    [
      {
        site: "history",
        geometry,
        at: "2026-10-01T08:00:00Z",
        speed: 40,
        attribution: {
          provider: "Credited publisher",
          license: "CC0-1.0",
          rights: {
            source_redistribution: "yes",
            derived_redistribution: "yes",
            commercial_use: "yes",
            attribution_required: "no",
            retention: "yes",
            evidence_origin: "private-review-origin",
            evidence_version: "private-review-version",
            reviewed_at: "2026-10-01T00:00:00Z",
          },
        },
      },
    ],
    now.toISOString(),
  );
  await rollupObservations(db.sql, { registry, period: "hourly", now });
  const response = await get("hourly");
  expect(response.statusCode).toBe(200);
  expect(bodyOf(response).rollups[0].provenance[0].attribution).toEqual({
    provider: "Credited publisher",
    license: "CC0-1.0",
  });
  expect(response.body).not.toContain("private-review");
});
