import { runMigrations } from "@openconditions/core/server";
import { FUSED_PUBLIC_SOURCE_ID, FUSED_SOURCE_ID, isFusedSourceId } from "@openconditions/model";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type LatestReading, latestOfFeatures, offersOfFeatures } from "../feature-expand.js";
import type { QueryRunner } from "../query-runner.js";

type Rec = Record<string, unknown>;

/**
 * One fuel station two sources describe, a public register and a restricted
 * mirror, linked into one canonical feature. Both price E5, which the fused
 * row on the canonical feature holds, and the public fusion beside it holds
 * the register's price alone; only the register prices diesel, which
 * the canonical view keys under the register's prefix. A second station of
 * the register stands alone.
 */
const AT = new Date("2026-09-22T12:00:00.000Z");
const PUBLIC = "es-register";
const RESTRICTED = "es-mirror";
const STATION = `oc:feature:${PUBLIC}:1`;
const TWIN = `oc:feature:${RESTRICTED}:1`;
const LONE = `oc:feature:${PUBLIC}:2`;
const CANONICAL = "oc:feature:test.local:c1";

let container: StartedTestContainer;
let sql: postgres.Sql;
let calls = 0;
let runner: QueryRunner;

const price = (amount: string) => ({ type: "money", amount, currency: "EUR", per: "L" });

interface Reading {
  id: string;
  source: string;
  featureId: string;
  componentKey?: string;
  amount: string;
  license?: string;
  fusedSources?: string[];
  fusedPublic?: boolean;
  expiresAt?: string;
  validUntil?: string;
}

async function insertReading(r: Reading): Promise<void> {
  const subject = {
    kind: "feature",
    featureId: r.featureId,
    ...(r.componentKey === undefined ? {} : { componentKey: r.componentKey }),
  };
  const template = {
    class: "observation",
    kind: "observation",
    property: "fuel.price",
    subject,
    provenance: {
      origin: isFusedSourceId(r.source) ? "derived" : "feed",
      sourceId: r.source,
      attribution: { provider: r.source, license: r.license ?? "CC-BY-4.0" },
    },
  };
  const reading = {
    id: r.id,
    result: price(r.amount),
    phenomenonTime: { instant: "2026-09-22T11:00:00.000Z" },
    ...(r.validUntil === undefined ? {} : { validUntil: r.validUntil }),
  };
  const subjectKey = `feature:${r.featureId}${r.componentKey === undefined ? "" : `#${r.componentKey}`}`;
  await sql`
    INSERT INTO conditions.observation_latest
      (subject_key, property, source_id, subject_kind, feature_id, component_key, reading,
       template, template_hash, access_mode, result_type, effective_from, since_at, fused_sources,
       fused_public, expires_at)
    VALUES (${subjectKey}, 'fuel.price', ${r.source}, 'feature', ${r.featureId},
            ${r.componentKey ?? null}, ${sql.json(reading)}, ${sql.json(template)}, ${r.id}, 'bulk',
            'money', '2026-09-22T11:00:00Z', '2026-09-22T11:00:00Z', ${r.fusedSources ?? null},
            ${r.fusedPublic ?? null}, ${r.expiresAt ?? null})`;
}

async function insertOffer(o: {
  id: string;
  source: string;
  subjectId: string;
  componentKey?: string;
  validTo?: string;
}): Promise<void> {
  const record = {
    id: o.id,
    class: "offer",
    subject: {
      class: "feature",
      id: o.subjectId,
      ...(o.componentKey === undefined ? {} : { componentKey: o.componentKey }),
    },
    provenance: { sourceId: o.source, attribution: { provider: o.source, license: "CC-BY-4.0" } },
  };
  await sql`
    INSERT INTO conditions.offer
      (id, record, canonical_id, kind, domain, temporality, source_id, source_record_id, origin,
       access_mode, privacy_class, instance_id, revision, recorded_at, content_hash, fetched_at,
       subject_class, subject_id, component_key, currency, valid_to)
    VALUES (${o.id}, ${sql.json(record)}, ${o.id}, 'fuel_tariff', 'facilities', 'static',
            ${o.source}, ${o.id}, 'feed', 'bulk', 'authoritative', 'test.local', 1,
            '2026-09-22T11:00:00Z', ${o.id}, '2026-09-22T11:00:00Z', 'feature', ${o.subjectId},
            ${o.componentKey ?? null}, 'EUR', ${o.validTo ?? null})`;
}

const STATION_E5 = `oc:observation:${PUBLIC}:e5`;
const TWIN_E5 = `oc:observation:${RESTRICTED}:e5`;

beforeAll(async () => {
  container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  await runMigrations(url);
  sql = postgres(url, { max: 2, onnotice: () => {} });
  runner = {
    execute: async <T>(query: string, params?: unknown[]) => {
      calls++;
      return (await sql.unsafe(query, params as never)) as T;
    },
  };
  for (const [id, restricted] of [
    [PUBLIC, false],
    [RESTRICTED, true],
  ] as const) {
    await sql`
      INSERT INTO conditions.source
        (id, domain, format, product, access_mode, tier, operator, license, attribution,
         restricted, cadence_sec, freshness_window_sec)
      VALUES (${id}, 'fuel', 'test', 'fuel', 'bulk', 'authoritative', ${id}, 'CC-BY-4.0', ${id},
              ${restricted}, 300, 900)`;
  }
  await sql`
    INSERT INTO conditions.feature_canonical
      (canonical_feature_id, survivor_id, member_ids, components, computed_at)
    VALUES (${CANONICAL}, ${STATION}, ${[STATION, TWIN]}, ${sql.json([
      {
        key: "e5",
        kind: "fuel_grade",
        members: [
          { featureId: STATION, key: "e5" },
          { featureId: TWIN, key: "e5" },
        ],
      },
      {
        key: `${PUBLIC}/diesel`,
        kind: "fuel_grade",
        members: [{ featureId: STATION, key: "diesel" }],
      },
    ])}, ${AT.toISOString()})`;
  await insertReading({
    id: STATION_E5,
    source: PUBLIC,
    featureId: STATION,
    componentKey: "e5",
    amount: "1.700",
  });
  await insertReading({
    id: `oc:observation:${PUBLIC}:diesel`,
    source: PUBLIC,
    featureId: STATION,
    componentKey: "diesel",
    amount: "1.600",
    validUntil: "2026-09-22T18:00:00.000Z",
  });
  await insertReading({
    id: `oc:observation:${PUBLIC}:lpg`,
    source: PUBLIC,
    featureId: STATION,
    componentKey: "lpg",
    amount: "0.900",
    expiresAt: "2026-09-22T11:30:00.000Z",
  });
  await insertReading({
    id: TWIN_E5,
    source: RESTRICTED,
    featureId: TWIN,
    componentKey: "e5",
    amount: "1.720",
  });
  await insertReading({
    id: "oc:observation:test.local:fused-e5",
    source: FUSED_SOURCE_ID,
    featureId: CANONICAL,
    componentKey: "e5",
    amount: "1.720",
    fusedSources: [RESTRICTED, PUBLIC],
    fusedPublic: false,
  });
  // The public fusion beside it has the same record id: the id names no source.
  await insertReading({
    id: "oc:observation:test.local:fused-e5",
    source: FUSED_PUBLIC_SOURCE_ID,
    featureId: CANONICAL,
    componentKey: "e5",
    amount: "1.700",
    fusedSources: [PUBLIC],
    fusedPublic: true,
  });
  await insertReading({
    id: `oc:observation:${PUBLIC}:lone`,
    source: PUBLIC,
    featureId: LONE,
    amount: "1.650",
  });
  await insertOffer({ id: `oc:offer:${PUBLIC}:wash`, source: PUBLIC, subjectId: STATION });
  await insertOffer({
    id: `oc:offer:${PUBLIC}:e5-card`,
    source: PUBLIC,
    subjectId: STATION,
    componentKey: "e5",
  });
  await insertOffer({ id: `oc:offer:${RESTRICTED}:club`, source: RESTRICTED, subjectId: TWIN });
  await insertOffer({
    id: `oc:offer:${PUBLIC}:ended`,
    source: PUBLIC,
    subjectId: LONE,
    validTo: "2026-09-22T10:00:00.000Z",
  });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
}, 30_000);

const byKey = (readings: readonly LatestReading[] | undefined) =>
  Object.fromEntries((readings ?? []).map((r) => [r.componentKey ?? "", r]));

describe("latestOfFeatures", () => {
  test("returns each feature's latest readings, component keys included, in one query", async () => {
    calls = 0;
    const latest = await latestOfFeatures(runner, {
      features: [{ id: STATION }, { id: TWIN }, { id: LONE }],
      canonical: false,
      scope: "operator",
      at: AT,
    });
    expect(calls).toBe(1);
    const station = byKey(latest.get(STATION));
    expect(Object.keys(station).sort()).toEqual(["diesel", "e5"]);
    expect(station["diesel"]).toEqual({
      property: "fuel.price",
      componentKey: "diesel",
      result: price("1.600"),
      phenomenonTime: { instant: "2026-09-22T11:00:00.000Z" },
      validUntil: "2026-09-22T18:00:00.000Z",
      source: PUBLIC,
    });
    expect(latest.get(TWIN)).toEqual([expect.objectContaining({ source: RESTRICTED })]);
    expect(latest.get(LONE)).toEqual([
      expect.not.objectContaining({ componentKey: expect.anything() }),
    ]);
  });

  test("in canonical mode a fused reading stands in for its members' readings", async () => {
    calls = 0;
    const latest = await latestOfFeatures(runner, {
      features: [{ id: CANONICAL, memberIds: [STATION, TWIN] }],
      canonical: true,
      scope: "operator",
      at: AT,
    });
    // The canonical components, then the readings.
    expect(calls).toBe(2);
    const readings = latest.get(CANONICAL)!;
    expect(readings).toHaveLength(2);
    expect(byKey(readings)["e5"]).toMatchObject({
      source: FUSED_SOURCE_ID,
      result: price("1.720"),
      contributors: [RESTRICTED, PUBLIC],
    });
    expect(byKey(readings)[`${PUBLIC}/diesel`]).not.toHaveProperty("contributors");
    expect(byKey(readings)[`${PUBLIC}/diesel`]).toMatchObject({
      source: PUBLIC,
      componentKey: `${PUBLIC}/diesel`,
    });
  });

  test("reads no canonical components the caller already holds", async () => {
    calls = 0;
    const latest = await latestOfFeatures(runner, {
      features: [
        {
          id: CANONICAL,
          memberIds: [STATION],
          components: [{ key: "gasoil", members: [{ featureId: STATION, key: "diesel" }] }],
        },
      ],
      canonical: true,
      scope: "operator",
      at: AT,
    });
    expect(calls).toBe(1);
    expect(byKey(latest.get(CANONICAL))["gasoil"]).toMatchObject({ source: PUBLIC });
  });

  test("expand=latest in public scope stands in the public fusion for the members", async () => {
    calls = 0;
    const latest = await latestOfFeatures(runner, {
      features: [{ id: CANONICAL, memberIds: [STATION] }],
      canonical: true,
      scope: "public",
      at: AT,
    });
    expect(calls).toBe(2);
    const e5 = (latest.get(CANONICAL) ?? []).filter((r) => r.componentKey === "e5");
    expect(e5).toEqual([
      {
        property: "fuel.price",
        componentKey: "e5",
        result: price("1.700"),
        phenomenonTime: { instant: "2026-09-22T11:00:00.000Z" },
        source: FUSED_PUBLIC_SOURCE_ID,
        contributors: [PUBLIC],
      },
    ]);
    // Only a fused reading of public contributors is ever served in public scope.
    expect((latest.get(CANONICAL) ?? []).flatMap((r) => r.contributors ?? [])).not.toContain(
      RESTRICTED,
    );
  });

  test("honours public scope: a withheld fused reading gives way to the public member's", async () => {
    const latest = await latestOfFeatures(runner, {
      features: [{ id: CANONICAL, memberIds: [STATION] }],
      canonical: true,
      scope: "public",
      at: AT,
      // The licence gate withholds the public fusion: the member's own reading stands.
      egress: (records) =>
        records.filter((r) => (r["provenance"] as Rec)["sourceId"] !== FUSED_PUBLIC_SOURCE_ID),
    });
    const e5 = (latest.get(CANONICAL) ?? []).filter((r) => r.componentKey === "e5");
    expect(e5).toEqual([expect.objectContaining({ source: PUBLIC, result: price("1.700") })]);
    const perSource = await latestOfFeatures(runner, {
      features: [{ id: TWIN }],
      canonical: false,
      scope: "public",
      at: AT,
    });
    expect(perSource.get(TWIN)).toEqual([]);
  });

  test("runs every row through the egress before a fused reading stands in", async () => {
    const latest = await latestOfFeatures(runner, {
      features: [{ id: CANONICAL, memberIds: [STATION, TWIN] }],
      canonical: true,
      scope: "operator",
      at: AT,
      egress: (records) =>
        records.filter((r) => (r["provenance"] as Rec)["sourceId"] !== FUSED_SOURCE_ID),
    });
    const e5 = (latest.get(CANONICAL) ?? []).filter((r) => r.componentKey === "e5");
    expect(e5.map((r) => r.source).sort()).toEqual([RESTRICTED, PUBLIC].sort());
  });
});

describe("offersOfFeatures", () => {
  const ids = (records: readonly Rec[] | undefined) =>
    (records ?? []).map((r) => r["id"] as string).sort();

  test("returns the live offers of a feature and its components", async () => {
    const offers = await offersOfFeatures(runner, {
      features: [{ id: STATION }, { id: LONE }],
      scope: "operator",
      at: AT,
    });
    expect(ids(offers.get(STATION))).toEqual([
      `oc:offer:${PUBLIC}:e5-card`,
      `oc:offer:${PUBLIC}:wash`,
    ]);
    expect(offers.get(LONE)).toEqual([]);
  });

  test("returns a canonical feature's members' offers, and honours public scope", async () => {
    const all = await offersOfFeatures(runner, {
      features: [{ id: CANONICAL, memberIds: [STATION, TWIN] }],
      scope: "operator",
      at: AT,
    });
    expect(ids(all.get(CANONICAL))).toHaveLength(3);
    const shown = await offersOfFeatures(runner, {
      features: [{ id: CANONICAL, memberIds: [STATION, TWIN] }],
      scope: "public",
      at: AT,
    });
    expect(ids(shown.get(CANONICAL))).toEqual([
      `oc:offer:${PUBLIC}:e5-card`,
      `oc:offer:${PUBLIC}:wash`,
    ]);
  });
});
