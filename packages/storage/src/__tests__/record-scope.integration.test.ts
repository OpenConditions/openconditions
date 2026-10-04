import {
  canonicalFeatureRecord,
  listCanonicalFeatures,
  listFeatures,
  listLatestObservations,
  listOffers,
  listSituations,
  type QueryRunner,
  readCoverage,
  readSeries,
  type Scope,
} from "@openconditions/core";
import {
  FUSED_PUBLIC_SOURCE_ID,
  FUSED_SOURCE_ID,
  isFusedSourceId,
  observationId,
} from "@openconditions/model";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { syncSources } from "../sources.js";
import { type WriteContext, writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { observationDraft, offerDraft, situationDraft } from "./drafts.js";
import { goldenFacilities, polled, registry } from "./facility-fixtures.js";

type Rec = Record<string, unknown>;

/**
 * Two sources describing one fuel station: the ministry's register, public,
 * and a mirror whose terms restrict it (its licence alone would let it out).
 * The mirror also publishes a situation and an offer. Public scope must
 * leave out everything the mirror contributes, in SQL; operator scope
 * leaves out nothing.
 */
const NOW = "2026-09-22T12:00:00.000Z";
const LATER = "2026-09-22T12:05:00.000Z";
const AT = new Date(LATER);
const INSTANCE = "test.local";
const ctx: WriteContext = { registry, instanceId: INSTANCE, now: NOW, complete: true };
const PUBLIC = "es-minetur-fuel";
const RESTRICTED = "es-fuel-test";

const minetur = goldenFacilities().get(PUBLIC)!;
const station = minetur.features.find((f) => f["id"] === `oc:feature:${PUBLIC}:3119`)!;
const e5 = minetur.observations.find(
  (o) =>
    (o["subject"] as Rec)["featureId"] === station["id"] &&
    (o["subject"] as Rec)["componentKey"] === "e5",
)!;
const stationGeometry = (station["location"] as { geometry: { coordinates: number[] } }).geometry;
const [lon, lat] = stationGeometry.coordinates as [number, number];
const box: [number, number, number, number] = [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01];

const restrictedProvenance = {
  ...(station["provenance"] as Rec),
  sourceId: RESTRICTED,
  attribution: { provider: "A restricted mirror", license: "CC-BY-4.0" },
};
const twin: Rec = {
  ...station,
  id: `oc:feature:${RESTRICTED}:3119`,
  location: {
    ...(station["location"] as Rec),
    geometry: { ...stationGeometry, coordinates: [lon + 0.00002, lat] },
  },
  provenance: restrictedProvenance,
  components: [(station["components"] as Rec[]).find((c) => c["key"] === "e5")],
};
const twinPrice: Rec = {
  ...e5,
  subject: { kind: "feature", featureId: twin["id"], componentKey: "e5" },
  provenance: restrictedProvenance,
};
delete twinPrice["id"];
twinPrice["id"] = observationId(RESTRICTED, twinPrice as never);

const feedProvenance = (sourceId: string, recordId: string) => ({
  origin: "feed",
  sourceId,
  sourceFormat: "datex2",
  accessMode: "bulk",
  recordId,
  attribution: { provider: sourceId, license: "CC-BY-4.0" },
  privacy: { class: "authoritative" },
});
const situationOf = (sourceId: string) =>
  situationDraft("scope", {
    id: `oc:situation:${sourceId}:scope`,
    validity: { status: "active", start: "2026-09-22T09:00:00Z" },
    provenance: feedProvenance(sourceId, "scope"),
    freshness: { fetchedAt: NOW },
  });
const offerOf = (sourceId: string) =>
  offerDraft("scope", {
    id: `oc:offer:${sourceId}:scope`,
    provenance: feedProvenance(sourceId, "scope"),
    freshness: { fetchedAt: NOW },
  });
const speed = observationDraft(
  "traffic.speed",
  { type: "quantity", value: 81, unit: "km/h" },
  { at: NOW, freshness: { fetchedAt: NOW } },
);

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let runner: QueryRunner;

const source = (id: string, restricted: boolean) => ({
  id,
  domain: "facilities",
  format: "test",
  product: "facilities",
  tier: "authoritative",
  country: "ES",
  operator: id,
  license: "CC-BY-4.0",
  attribution: id,
  restricted,
  cadenceSec: 300,
  freshnessWindowSec: 900,
});

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  runner = {
    execute: async <T>(query: string, params?: unknown[]) =>
      (await sql.unsafe(query, params as never)) as T,
  };
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
  await syncSources(sql, [
    source(PUBLIC, false),
    source(RESTRICTED, true),
    source("nl-ndw-flow", false),
  ]);
  for (const id of [PUBLIC, RESTRICTED, "nl-ndw-flow"]) await polled(sql, id, LATER);
  const writes: [string, Rec][] = [
    [
      PUBLIC,
      {
        features: minetur.features,
        observations: minetur.observations,
        situations: [situationOf(PUBLIC)],
        offers: [offerOf(PUBLIC)],
      },
    ],
    [
      RESTRICTED,
      {
        features: [twin],
        observations: [twinPrice],
        situations: [situationOf(RESTRICTED)],
        offers: [offerOf(RESTRICTED)],
      },
    ],
    ["nl-ndw-flow", { observations: [speed] }],
  ];
  for (const [sourceId, drafts] of writes) {
    const summary = await writeSnapshot(sql, sourceId, drafts, { ...ctx, now: LATER });
    expect(summary.rejected, sourceId).toEqual([]);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

const sourcesOf = (records: Rec[]) =>
  [...new Set(records.map((r) => (r["provenance"] as Rec)["sourceId"] as string))].sort();

async function everyClass(scope: Scope) {
  const features = await listFeatures(runner, { scope, at: AT, limit: 100 });
  const offers = await listOffers(runner, { scope, at: AT, limit: 100 });
  const situations = await listSituations(runner, { scope, at: AT, limit: 100 });
  const readings = await listLatestObservations(runner, registry, { scope, at: AT, limit: 100 });
  return {
    features: sourcesOf(features.records),
    offers: sourcesOf(offers.records),
    situations: sourcesOf(situations.records),
    readings: sourcesOf(readings.records),
  };
}

const seriesOf = (scope: Scope, sourceId: string) =>
  readSeries(
    runner,
    registry,
    {
      scope,
      subjectKey: `feature:${sourceId === PUBLIC ? station["id"] : twin["id"]}#e5`,
      property: "fuel.price",
      sourceId,
    },
    { from: new Date(NOW), to: new Date(LATER), now: AT, limit: 10 },
  );

/** The ids of the full fusions with no restricted contributor. */
async function fusedIds(): Promise<{ publicOnly: string[] }> {
  const rows = await sql<{ id: string; fused_from: string[] }[]>`
    SELECT conditions.observation_record(template, reading) ->> 'id' AS id, fused_from
      FROM conditions.observation_latest WHERE source_id = ${FUSED_SOURCE_ID}`;
  const mixed = rows.filter((r) => r.fused_from.includes(twinPrice["id"] as string));
  expect(mixed).toHaveLength(1);
  return {
    publicOnly: rows
      .filter((r) => !r.fused_from.includes(twinPrice["id"] as string))
      .map((r) => r.id),
  };
}

/** The ids of the records a fused reading was fused from. */
const derivedIds = (record: Rec) => {
  const derivedFrom = (record["provenance"] as Rec)["derivedFrom"] as Rec | undefined;
  return ((derivedFrom?.["records"] as Rec[] | undefined) ?? []).map((r) => r["id"] as string);
};

/** The subjects, properties and qualifiers a page holds more than one fused reading of. */
const subjectsTwice = (records: Rec[]) => {
  const keys = records
    .filter((r) => isFusedSourceId((r["provenance"] as Rec)["sourceId"] as string))
    .map((r) => JSON.stringify([r["subject"], r["property"], r["qualifiers"] ?? null]));
  return keys.filter((k, i) => keys.indexOf(k) !== i);
};

describe("reader scope", () => {
  test("public scope withholds a restricted source's features, offers, situations and readings", async () => {
    expect(await everyClass("public")).toEqual({
      features: [PUBLIC],
      offers: [PUBLIC],
      situations: [PUBLIC],
      readings: ["nl-ndw-flow", PUBLIC].sort(),
    });
    expect(await seriesOf("public", PUBLIC)).toMatchObject({ status: "found" });
    expect(await seriesOf("public", RESTRICTED)).toEqual({ status: "none" });
  });

  test("operator scope returns both sources", async () => {
    expect(await everyClass("operator")).toEqual({
      features: [PUBLIC, RESTRICTED].sort(),
      offers: [PUBLIC, RESTRICTED].sort(),
      situations: [PUBLIC, RESTRICTED].sort(),
      readings: ["nl-ndw-flow", PUBLIC, RESTRICTED].sort(),
    });
    expect(await seriesOf("operator", RESTRICTED)).toMatchObject({ status: "found" });
  });

  test("public latest readings serve the public fusion, operator the full one", async () => {
    const { publicOnly } = await fusedIds();
    expect(publicOnly.length).toBeGreaterThan(0);
    const canonical = async (scope: Scope) =>
      (
        await listLatestObservations(runner, registry, {
          scope,
          at: AT,
          limit: 500,
          canonical: true,
        })
      ).records;
    // The full and the public fusion of one subject share a record id: tell them apart by source.
    const e5Fusions = (records: Rec[]) =>
      records.filter((r) => derivedIds(r).includes(e5["id"] as string));

    const shown = await canonical("public");
    const [publicE5, ...otherPublic] = e5Fusions(shown);
    expect(otherPublic).toEqual([]);
    expect((publicE5!["provenance"] as Rec)["sourceId"]).toBe(FUSED_PUBLIC_SOURCE_ID);
    expect(derivedIds(publicE5!)).toEqual([e5["id"]]);
    expect(JSON.stringify(shown)).not.toContain(RESTRICTED);
    expect(shown.map((r) => r["id"])).toEqual(expect.arrayContaining(publicOnly));
    // A non-fusable property's own reading from a public source is still served.
    expect(shown.map((r) => r["id"])).toContain(speed["id"]);
    expect(subjectsTwice(shown)).toEqual([]);

    const all = await canonical("operator");
    const [fullE5, ...otherFull] = e5Fusions(all);
    expect(otherFull).toEqual([]);
    expect((fullE5!["provenance"] as Rec)["sourceId"]).toBe(FUSED_SOURCE_ID);
    expect(derivedIds(fullE5!)).toContain(twinPrice["id"]);
    expect(all.some((r) => (r["provenance"] as Rec)["sourceId"] === FUSED_PUBLIC_SOURCE_ID)).toBe(
      false,
    );
    expect(subjectsTwice(all)).toEqual([]);
  });

  test("@fused-public never counts in coverage and never enters history", async () => {
    const coverage = await readCoverage(runner, { scope: "operator", at: AT });
    const sources = coverage.flatMap((c) => c.sources);
    expect(sources).toContain(PUBLIC);
    expect(sources).not.toContain(FUSED_PUBLIC_SOURCE_ID);
    expect(sources).not.toContain(FUSED_SOURCE_ID);
    const [history] = await sql<{ fused: number; history: number }[]>`
      SELECT count(*)::int AS fused, count(o.series_id)::int AS history
        FROM conditions.observation_latest l
        LEFT JOIN conditions.observation o ON o.series_id = l.series_id
       WHERE l.source_id = ${FUSED_PUBLIC_SOURCE_ID}`;
    expect(history!.fused).toBeGreaterThan(0);
    expect(history!.history).toBe(0);
    const publicFusions = await sql<{ subject_key: string }[]>`
      SELECT subject_key FROM conditions.observation_latest
       WHERE source_id = ${FUSED_PUBLIC_SOURCE_ID} AND property = 'fuel.price'`;
    for (const scope of ["public", "operator"] as const) {
      for (const { subject_key } of publicFusions) {
        const read = await readSeries(
          runner,
          registry,
          {
            scope,
            subjectKey: subject_key,
            property: "fuel.price",
            sourceId: FUSED_PUBLIC_SOURCE_ID,
          },
          { from: new Date(NOW), to: new Date(LATER), now: AT, limit: 10 },
        );
        expect(read).toEqual({ status: "none" });
      }
    }
  });

  test("a canonical feature in public scope is built from its public members only", async () => {
    const clusterOf = async (scope: Scope) => {
      const page = await listCanonicalFeatures(runner, { scope, at: AT, bbox: box, limit: 10 });
      const cluster = page.clusters.find((c) => c.memberIds.includes(station["id"] as string))!;
      return { cluster, record: canonicalFeatureRecord(cluster, cluster.members)! };
    };
    const shown = await clusterOf("public");
    expect(shown.cluster.memberIds).toEqual([twin["id"], station["id"]]);
    expect(shown.cluster.members.map((m) => m["id"])).toEqual([station["id"]]);
    expect((shown.record["provenance"] as Rec)["sourceId"]).toBe(PUBLIC);
    expect(shown.record["provenance"]).not.toHaveProperty("mergedSources");
    expect(JSON.stringify(shown.record)).not.toContain(RESTRICTED);

    const operator = await clusterOf("operator");
    expect(operator.cluster.members.map((m) => m["id"])).toEqual([twin["id"], station["id"]]);
    expect((operator.record["provenance"] as Rec)["mergedSources"]).toHaveLength(1);
  });

  test("a cluster of restricted members only is not listed in public scope", async () => {
    const page = await listCanonicalFeatures(runner, {
      scope: "public",
      at: AT,
      sources: [RESTRICTED],
      limit: 10,
    });
    expect(page.clusters).toEqual([]);
  });
});
