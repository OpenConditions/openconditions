import { latestOfFeatures } from "@openconditions/core";
import {
  FUSED_PUBLIC_SOURCE_ID,
  FUSED_SOURCE_ID,
  landClaim,
  observationId,
} from "@openconditions/model";
import { createTestDatabase } from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Sql } from "../bulk.js";
import {
  type FusedScope,
  LOCK_SPACES,
  type OutdatedRefreshOptions,
  refreshFlippedFusions,
  refreshFused,
  refreshOutdatedFusions,
} from "../fused-rows.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { type SourceEntry, syncSources } from "../sources.js";
import { writeRecord } from "../write-record.js";
import { type WriteContext, writeSnapshot } from "../write-records.js";
import { goldenFacilities, polled, registry } from "./facility-fixtures.js";

type Rec = Record<string, unknown>;

/**
 * One fuel station three sources describe: the ministry's register, public;
 * a mirror whose terms restrict it; and a relay whose own licence is public
 * but whose upstream publisher's is not. Each fused price is written once
 * over every source, and once more over the public ones only when the two
 * differ.
 */
const NOW = "2026-09-22T12:00:00.000Z";
const LATER = "2026-09-22T12:05:00.000Z";
const INSTANCE = "test.local";
const ctx: WriteContext = { registry, instanceId: INSTANCE, now: LATER, complete: true };
const PUBLIC = "es-minetur-fuel";
const RESTRICTED = "es-fuel-test";
const RELAY = "es-fuel-relay";

const minetur = goldenFacilities().get(PUBLIC)!;
const station = minetur.features.find((f) => f["id"] === `oc:feature:${PUBLIC}:3119`)!;
const priceOf = (componentKey: string) =>
  minetur.observations.find(
    (o) =>
      (o["subject"] as Rec)["featureId"] === station["id"] &&
      (o["subject"] as Rec)["componentKey"] === componentKey,
  )!;
const stationGeometry = (station["location"] as { geometry: { coordinates: number[] } }).geometry;
const [lon, lat] = stationGeometry.coordinates as [number, number];
const componentOf = (key: string) =>
  (station["components"] as Rec[]).find((c) => c["key"] === key)!;

const provenanceOf = (sourceId: string, extra: Rec = {}) => ({
  ...(station["provenance"] as Rec),
  sourceId,
  attribution: { provider: sourceId, license: "CC-BY-4.0" },
  ...extra,
});

function twinOf(sourceId: string, offset: [number, number], components: Rec[], extra: Rec = {}) {
  return {
    ...station,
    id: `oc:feature:${sourceId}:3119`,
    location: {
      ...(station["location"] as Rec),
      geometry: { ...stationGeometry, coordinates: [lon + offset[0], lat + offset[1]] },
    },
    provenance: provenanceOf(sourceId, extra),
    components,
  };
}

function priceDraft(
  sourceId: string,
  featureId: string,
  componentKey: string,
  from: Rec,
  change: Rec,
  extra: Rec = {},
): Rec {
  const draft: Rec = {
    ...from,
    ...change,
    subject: { kind: "feature", featureId, componentKey },
    provenance: provenanceOf(sourceId, extra),
  };
  delete draft["id"];
  draft["id"] = observationId(sourceId, draft as never);
  return draft;
}

const e10Component = {
  ...componentOf("e5"),
  key: "e10",
  details: { ...(componentOf("e5")["details"] as Rec), grade: "e10" },
};
const twin = twinOf(RESTRICTED, [0.00002, 0], [componentOf("e5"), e10Component]);
/** The mirror's E5 price, newer than the register's: it wins the full fusion. */
const twinE5 = priceDraft(RESTRICTED, twin["id"], "e5", priceOf("e5"), {
  result: { type: "money", amount: "1.999", currency: "EUR", per: "L" },
  phenomenonTime: { instant: "2026-09-22T11:30:00Z" },
});
/** A grade only the mirror sells. */
const twinE10 = priceDraft(RESTRICTED, twin["id"], "e10", priceOf("e5"), {
  result: { type: "money", amount: "1.899", currency: "EUR", per: "L" },
});
const upstream = { upstream: [{ publisher: "OpenStreetMap", license: "ODbL-1.0" }] };
const relay = twinOf(RELAY, [0, 0.00002], [componentOf("sp98")], upstream);
/** The relay's SP98 price, the register's value at the register's time: both contribute. */
const relaySp98 = priceDraft(RELAY, relay["id"], "sp98", priceOf("sp98"), {}, upstream);

const source = (id: string, restricted: boolean): SourceEntry => ({
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

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
  await syncSources(sql, [source(PUBLIC, false), source(RESTRICTED, true), source(RELAY, false)]);
  for (const id of [PUBLIC, RESTRICTED, RELAY]) await polled(sql, id, LATER);
  const writes: [string, Rec][] = [
    [PUBLIC, { features: minetur.features, observations: minetur.observations }],
    [RESTRICTED, { features: [twin], observations: [twinE5, twinE10] }],
    [RELAY, { features: [relay], observations: [relaySp98] }],
  ];
  for (const [sourceId, drafts] of writes) {
    const summary = await writeSnapshot(sql, sourceId, drafts, ctx);
    expect(summary.rejected, sourceId).toEqual([]);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

interface FusedDbRow {
  source_id: string;
  fused_public: boolean | null;
  fused_from: string[];
  record: Rec;
}

const canonicalId = async () => {
  const [row] = await sql<{ canonical_feature_id: string; member_ids: string[] }[]>`
    SELECT canonical_feature_id, member_ids FROM conditions.feature_canonical
     WHERE ${station["id"] as string} = ANY(member_ids)`;
  expect(row!.member_ids).toHaveLength(3);
  return row!.canonical_feature_id;
};

/**
 * The fused prices of one grade. Which member survives decides the canonical
 * keys: the survivor's components keep theirs, the rest join as
 * `<source id>/<key>`.
 */
const fusedOf = async (grade: string) =>
  sql<FusedDbRow[]>`
    SELECT source_id, fused_public, fused_from,
           conditions.observation_record(template, reading) AS record
      FROM conditions.observation_latest
     WHERE source_id IN (${FUSED_SOURCE_ID}, ${FUSED_PUBLIC_SOURCE_ID})
       AND feature_id = ${await canonicalId()}
       AND (component_key = ${grade} OR component_key LIKE ${`%/${grade}`})
       AND property = 'fuel.price'
     ORDER BY source_id`;

const amountOf = (row: FusedDbRow) => (row.record["result"] as Rec)["amount"];

/** Refreshes every fused row of the station's canonical feature. */
const refresh = async () => {
  const canonical = await canonicalId();
  return sql.begin((tx) =>
    refreshFused(tx, registry, [{ featureId: canonical }], { instanceId: INSTANCE, now: LATER }),
  );
};

describe("a contributor's source going stale, or fresh again", () => {
  const full = async () => (await fusedOf("e5")).find((r) => r.source_id === FUSED_SOURCE_ID)!;
  const flips = (from: string, to: string) =>
    refreshFlippedFusions(sql, registry, { from, to, instanceId: INSTANCE });

  test("refuses the fusion its stale winner held, and gives it back when it polls again", async () => {
    // The mirror's newer price wins while every source is fresh.
    expect(amountOf(await full())).toBe("1.999");
    // The mirror's last success, at 11:40, goes stale at 11:55: nothing it
    // writes says so, yet the register's fresh price takes over.
    await sql`UPDATE conditions.source_status SET last_success_at = '2026-09-22T11:40:00Z'
      WHERE source = ${RESTRICTED}`;
    try {
      expect(await flips("2026-09-22T11:50:00Z", "2026-09-22T12:00:00Z")).toBe(1);
      expect(amountOf(await full())).toBe((priceOf("e5")["result"] as Rec)["amount"]);
      // Polled again at 12:20 after its 11:40 success: fresh again, it wins again.
      await sql`
        INSERT INTO conditions.source_poll_attempt
          (source, attempted_at, finished_at, outcome, network_validated, published)
        VALUES (${RESTRICTED}, '2026-09-22T11:40:00Z', '2026-09-22T11:41:00Z', 'changed', true, true),
               (${RESTRICTED}, '2026-09-22T12:20:00Z', '2026-09-22T12:21:00Z', 'changed', true, true)`;
      await sql`UPDATE conditions.source_status SET last_success_at = '2026-09-22T12:20:00Z'
        WHERE source = ${RESTRICTED}`;
      // The register and the relay, last polled at 12:05, go stale at 12:20 too.
      expect(await flips("2026-09-22T12:15:00Z", "2026-09-22T12:25:00Z")).toBe(3);
      expect(amountOf(await full())).toBe("1.999");
      // Nothing flipped since: nothing is refreshed.
      expect(await flips("2026-09-22T12:25:00Z", "2026-09-22T12:30:00Z")).toBe(0);
    } finally {
      await sql`DELETE FROM conditions.source_poll_attempt WHERE source = ${RESTRICTED}`;
      await polled(sql, RESTRICTED, LATER);
      await refresh();
    }
  });
});

describe("a contributor's poll that ran long", () => {
  test("counts as fresh from when it finished, for fusion and for its flips", async () => {
    const full = async () => (await fusedOf("e5")).find((r) => r.source_id === FUSED_SOURCE_ID)!;
    // The mirror's success began at 11:30 (stale by 12:05 if dated so) and finished at 12:03.
    await sql`
      INSERT INTO conditions.source_poll_attempt
        (source, attempted_at, finished_at, outcome, network_validated, published)
      VALUES (${RESTRICTED}, '2026-09-22T11:00:00Z', '2026-09-22T11:01:00Z', 'changed', true, true),
             (${RESTRICTED}, '2026-09-22T11:30:00Z', '2026-09-22T12:03:00Z', 'changed', true, true)`;
    await sql`UPDATE conditions.source_status SET last_success_at = '2026-09-22T11:30:00Z'
      WHERE source = ${RESTRICTED}`;
    try {
      await refresh();
      expect(amountOf(await full())).toBe("1.999");
      const flips = (from: string, to: string) =>
        refreshFlippedFusions(sql, registry, { from, to, instanceId: INSTANCE });
      // Back fresh when the 12:03 finish landed, after the 11:01 one lapsed.
      expect(await flips("2026-09-22T12:00:00Z", "2026-09-22T12:05:00Z")).toBe(1);
      // Stale fifteen minutes after that finish, not after the start.
      expect(await flips("2026-09-22T11:40:00Z", "2026-09-22T11:50:00Z")).toBe(0);
    } finally {
      await sql`DELETE FROM conditions.source_poll_attempt WHERE source = ${RESTRICTED}`;
      await polled(sql, RESTRICTED, LATER);
      await refresh();
    }
  });
});

describe("a series a complete poll ends", () => {
  test("leaves the fusion it won to the next contributor, and wins it back when stated again", async () => {
    const full = async () => (await fusedOf("e5")).find((r) => r.source_id === FUSED_SOURCE_ID)!;
    expect(amountOf(await full())).toBe("1.999");
    const poll = (observations: Rec[]) =>
      writeSnapshot(
        sql,
        RESTRICTED,
        { observations },
        { ...ctx, complete: false, statesComplete: true },
      );
    // The mirror stops stating its E5 price.
    expect((await poll([twinE10])).observations.ended).toBe(1);
    expect(amountOf(await full())).toBe((priceOf("e5")["result"] as Rec)["amount"]);
    await poll([twinE5, twinE10]);
    expect(amountOf(await full())).toBe("1.999");
  });

  test("locks the links before the fused rows, and the fused rows at once, like every write", async () => {
    // Two writes taking the two in different orders, or the fused rows in two
    // rounds, can each hold what the other waits for.
    const locks: string[] = [];
    const traced = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      debug: (_connection, query, params) => {
        if (/pg_advisory_xact_lock\(\$1::int, b\)/.test(query)) {
          locks.push(Number(params[0]) === LOCK_SPACES.featureLink ? "link" : "fused");
        }
      },
    });
    try {
      const renamed = { ...twin, name: [{ lang: "es", text: "Estación de servicio del espejo" }] };
      const summary = await writeSnapshot(
        traced,
        RESTRICTED,
        { features: [renamed], observations: [twinE10] },
        { ...ctx, complete: false, statesComplete: true },
      );
      expect(summary.counts.feature.updated).toBe(1);
      expect(summary.observations.ended).toBe(1);
      expect(locks).toEqual(["link", "fused"]);
    } finally {
      await traced.end();
      await writeSnapshot(
        sql,
        RESTRICTED,
        { features: [twin], observations: [twinE5, twinE10] },
        ctx,
      );
    }
    const [full] = await fusedOf("e5");
    expect(amountOf(full!)).toBe("1.999");
  });
});

describe("the public fusion beside the full one", () => {
  test("an all-public fusion is written once, flagged public", async () => {
    const rows = await fusedOf("diesel");
    expect(rows.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, true]]);
    expect(rows[0]!.fused_from).toEqual([priceOf("diesel")["id"]]);
  });

  test("a fusion won by a restricted contributor also writes the public fusion of the rest", async () => {
    const [full, publicOnly] = await fusedOf("e5");
    expect(full).toMatchObject({ source_id: FUSED_SOURCE_ID, fused_public: false });
    expect(full!.fused_from).toEqual([twinE5["id"]]);
    expect(amountOf(full!)).toBe("1.999");
    expect(publicOnly).toMatchObject({ source_id: FUSED_PUBLIC_SOURCE_ID, fused_public: true });
    expect(publicOnly!.fused_from).toEqual([priceOf("e5")["id"]]);
    expect(amountOf(publicOnly!)).toBe("1.989");
    expect(publicOnly!.record["provenance"]).toMatchObject({
      sourceId: FUSED_PUBLIC_SOURCE_ID,
      origin: "derived",
      attribution: { license: "CC-BY-4.0" },
    });
    expect(publicOnly!.record["subject"]).toEqual(full!.record["subject"]);
  });

  test("a contributor whose upstream licence is not public is left out of the public fusion", async () => {
    const [full, publicOnly] = await fusedOf("sp98");
    expect(full).toMatchObject({ source_id: FUSED_SOURCE_ID, fused_public: false });
    expect([...full!.fused_from].sort()).toEqual(
      [priceOf("sp98")["id"] as string, relaySp98["id"] as string].sort(),
    );
    expect(publicOnly).toMatchObject({ source_id: FUSED_PUBLIC_SOURCE_ID, fused_public: true });
    expect(publicOnly!.fused_from).toEqual([priceOf("sp98")["id"]]);
    expect(amountOf(publicOnly!)).toBe(amountOf(full!));
  });

  test("no public candidate means no public row", async () => {
    const rows = await fusedOf("e10");
    expect(rows.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, false]]);
    expect(rows[0]!.fused_from).toEqual([twinE10["id"]]);
  });

  test("when the public fusion becomes equal to the full one, the extra row is removed", async () => {
    await syncSources(sql, [
      source(PUBLIC, false),
      source(RESTRICTED, false),
      source(RELAY, false),
    ]);
    const canonical = await canonicalId();
    const counts = await sql.begin((tx) =>
      refreshFused(tx, registry, [{ featureId: canonical }], { instanceId: INSTANCE, now: LATER }),
    );
    expect(counts.deleted).toBe(1);
    const e5 = await fusedOf("e5");
    expect(e5.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, true]]);
    expect(amountOf(e5[0]!)).toBe("1.999");
    const e10 = await fusedOf("e10");
    expect(e10.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, true]]);
    // The relay's upstream licence still keeps it out of the public fusion.
    const sp98 = await fusedOf("sp98");
    expect(sp98.map((r) => [r.source_id, r.fused_public])).toEqual([
      [FUSED_SOURCE_ID, false],
      [FUSED_PUBLIC_SOURCE_ID, true],
    ]);
  });

  test("an all-public fusion that gains a restricted contributor writes the public fusion beside it", async () => {
    await syncSources(sql, [source(PUBLIC, false), source(RESTRICTED, true), source(RELAY, false)]);
    const counts = await refresh();
    expect(counts.deleted).toBe(0);
    const [full, publicOnly] = await fusedOf("e5");
    expect(full).toMatchObject({ source_id: FUSED_SOURCE_ID, fused_public: false });
    expect(amountOf(full!)).toBe("1.999");
    expect(publicOnly).toMatchObject({ source_id: FUSED_PUBLIC_SOURCE_ID, fused_public: true });
    expect(amountOf(publicOnly!)).toBe("1.989");
    const e10 = await fusedOf("e10");
    expect(e10.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, false]]);
  });

  test("a fusion with nothing left to fuse takes both of its rows with it", async () => {
    const canonical = await canonicalId();
    expect(await fusedOf("sp98")).toHaveLength(2);
    await sql`
      DELETE FROM conditions.observation_latest
       WHERE source_id = ANY(${[PUBLIC, RELAY]}::text[]) AND property = 'fuel.price'
         AND component_key = 'sp98'
         AND feature_id = ANY(SELECT unnest(member_ids) FROM conditions.feature_canonical
                               WHERE canonical_feature_id = ${canonical})`;
    const counts = await refresh();
    expect(counts.deleted).toBe(2);
    expect(await fusedOf("sp98")).toEqual([]);
  });

  test("a mixed fusion that loses its last public candidate keeps the full row only", async () => {
    await syncSources(sql, [source(PUBLIC, true), source(RESTRICTED, true), source(RELAY, false)]);
    const counts = await refresh();
    expect(counts.deleted).toBe(1);
    const e5 = await fusedOf("e5");
    expect(e5.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, false]]);
    expect(amountOf(e5[0]!)).toBe("1.999");
  });

  test("a canonical feature that goes takes both fusions with it", async () => {
    // Both fusions of a grade, so the drop is seen to take each.
    await syncSources(sql, [source(PUBLIC, false), source(RESTRICTED, true), source(RELAY, false)]);
    await refresh();
    expect(await fusedOf("e5")).toHaveLength(2);
    const canonical = await canonicalId();
    // Another writer holds the cluster's fused lock: the drop waits for it,
    // so it never deletes a row that writer is about to upsert.
    const holder = await sql.reserve();
    await holder`SELECT pg_advisory_lock(2, hashtext(${canonical}) & 1023)`;
    const dropping = sql.begin((tx) =>
      refreshFused(tx, registry, [], { instanceId: INSTANCE, now: LATER, vanished: [canonical] }),
    );
    const waited = await Promise.race([
      dropping.then(() => "dropped"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
    ]);
    expect(waited).toBe("waiting");
    await holder`SELECT pg_advisory_unlock(2, hashtext(${canonical}) & 1023)`;
    holder.release();
    expect((await dropping).deleted).toBeGreaterThan(5);
    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.observation_latest
       WHERE source_id IN (${FUSED_SOURCE_ID}, ${FUSED_PUBLIC_SOURCE_ID})
         AND feature_id = ${canonical}`;
    expect(left!.n).toBe(0);
  });
});

describe("a restricted flip at boot", () => {
  const refreshOutdated = (opts: Partial<OutdatedRefreshOptions> = {}) =>
    refreshOutdatedFusions(sql, { registry, instanceId: INSTANCE, now: () => LATER, ...opts });
  /** What boot does: sync the catalogue, then refresh the fusions it outdated. */
  const boot = async (sources: SourceEntry[], opts: Partial<OutdatedRefreshOptions> = {}) => {
    await syncSources(sql, sources);
    return refreshOutdated(opts);
  };
  const basisOf = async (id: string) => {
    const [row] = await sql`
      SELECT fusion_restricted, fusion_tier FROM conditions.source WHERE id = ${id}`;
    return row;
  };

  test("a source never refreshed is refreshed once, then settled", async () => {
    // The suites above synced the sources without refreshing their fusions.
    const first = await refreshOutdated();
    expect(first.sources).toEqual([RELAY, RESTRICTED, PUBLIC].sort());
    expect(first.settled).toEqual(first.sources);
    expect(await basisOf(RESTRICTED)).toEqual({
      fusion_restricted: true,
      fusion_tier: "authoritative",
    });
    expect((await fusedOf("e5")).map((r) => r.source_id)).toEqual([
      FUSED_SOURCE_ID,
      FUSED_PUBLIC_SOURCE_ID,
    ]);
  });

  test("a source turning unrestricted at boot joins the public fusion", async () => {
    const counts = await boot([
      source(PUBLIC, false),
      source(RESTRICTED, false),
      source(RELAY, false),
    ]);
    expect(counts.sources).toEqual([RESTRICTED]);
    expect(counts.settled).toEqual([RESTRICTED]);
    // The mirror has readings on the station only.
    expect(counts).toMatchObject({ features: 1, total: 1, deleted: 1 });
    const e5 = await fusedOf("e5");
    expect(e5.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, true]]);
    expect(amountOf(e5[0]!)).toBe("1.999");
    const e10 = await fusedOf("e10");
    expect(e10.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, true]]);
  });

  test("a source turning restricted at boot leaves the public fusion without it", async () => {
    const counts = await boot([
      source(PUBLIC, false),
      source(RESTRICTED, true),
      source(RELAY, false),
    ]);
    expect(counts.sources).toEqual([RESTRICTED]);
    expect(counts).toMatchObject({ features: 1, total: 1, deleted: 0 });
    const [full, publicOnly] = await fusedOf("e5");
    expect(full).toMatchObject({ source_id: FUSED_SOURCE_ID, fused_public: false });
    expect(amountOf(full!)).toBe("1.999");
    expect(publicOnly).toMatchObject({ source_id: FUSED_PUBLIC_SOURCE_ID, fused_public: true });
    expect(amountOf(publicOnly!)).toBe("1.989");
    const e10 = await fusedOf("e10");
    expect(e10.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, false]]);
  });

  test("a completed refresh is not repeated on the next boot", async () => {
    const counts = await boot([
      source(PUBLIC, false),
      source(RESTRICTED, true),
      source(RELAY, false),
    ]);
    expect(counts).toEqual({
      sources: [],
      settled: [],
      features: 0,
      total: 0,
      written: 0,
      unchanged: 0,
      deleted: 0,
    });
  });

  test("a licence reclassification refreshes every source once", async () => {
    const sources = [source(PUBLIC, false), source(RESTRICTED, true), source(RELAY, false)];
    const licensesOf = async (id: string) => {
      const [row] = await sql<{ fusion_licenses: string | null }[]>`
        SELECT fusion_licenses FROM conditions.source WHERE id = ${id}`;
      return row!.fusion_licenses;
    };
    const current = await licensesOf(PUBLIC);
    expect(current).toMatch(/^[0-9a-f]{64}$/);

    const reclassified = await boot(sources, { licenses: "reclassified" });
    expect(reclassified.sources).toEqual([RELAY, RESTRICTED, PUBLIC].sort());
    expect(reclassified.settled).toEqual(reclassified.sources);
    expect(await licensesOf(RELAY)).toBe("reclassified");
    expect((await boot(sources, { licenses: "reclassified" })).sources).toEqual([]);

    // Back to the registry's classification: every source once more.
    expect((await boot(sources)).sources).toEqual([RELAY, RESTRICTED, PUBLIC].sort());
    expect(await licensesOf(RELAY)).toBe(current);
    expect((await boot(sources)).sources).toEqual([]);
  });

  test("a tier change triggers a refresh", async () => {
    const counts = await boot([
      source(PUBLIC, false),
      { ...source(RESTRICTED, true), tier: "aggregator" },
      source(RELAY, false),
    ]);
    expect(counts.sources).toEqual([RESTRICTED]);
    expect(counts).toMatchObject({ settled: [RESTRICTED], features: 1, total: 1 });
    expect(await basisOf(RESTRICTED)).toEqual({
      fusion_restricted: true,
      fusion_tier: "aggregator",
    });
  });

  test("a refresh stopped part-way resumes on the next boot", async () => {
    const stop = new AbortController();
    const progress: number[] = [];
    const sources = [source(PUBLIC, true), source(RESTRICTED, true), source(RELAY, false)];
    const counts = await boot(sources, {
      batchSize: 1,
      signal: stop.signal,
      onBatch: ({ done }) => {
        progress.push(done);
        stop.abort();
      },
    });
    // The register flipped and the mirror's tier went back: the register's two
    // stations (the shared one and its other) to refresh, one per batch.
    expect(counts.sources).toEqual([RESTRICTED, PUBLIC].sort());
    expect(counts).toMatchObject({ features: 1, total: 2 });
    expect(progress).toEqual([1]);
    // The register's other station is not yet refreshed: it stays outdated.
    expect(counts.settled).not.toContain(PUBLIC);
    expect(await basisOf(PUBLIC)).toEqual({
      fusion_restricted: false,
      fusion_tier: "authoritative",
    });

    const resumed = await boot(sources, { batchSize: 1 });
    expect(resumed.sources).toEqual(counts.sources.filter((id) => !counts.settled.includes(id)));
    expect(resumed.settled).toEqual(resumed.sources);
    expect(resumed).toMatchObject({ features: 2, total: 2 });
    expect(await basisOf(PUBLIC)).toEqual({
      fusion_restricted: true,
      fusion_tier: "authoritative",
    });
    const e5 = await fusedOf("e5");
    expect(e5.map((r) => [r.source_id, r.fused_public])).toEqual([[FUSED_SOURCE_ID, false]]);
    expect((await boot(sources)).sources).toEqual([]);
  });

  test("a refresh that fails part-way resumes on the next boot", async () => {
    const sources = [source(PUBLIC, false), source(RESTRICTED, true), source(RELAY, false)];
    let batches = 0;
    const failing = boot(sources, {
      batchSize: 1,
      now: () => {
        if (++batches === 2) throw new Error("connection lost");
        return LATER;
      },
    });
    await expect(failing).rejects.toThrow("connection lost");
    // The failed batch rolled back with the register's basis.
    expect(await basisOf(PUBLIC)).toEqual({
      fusion_restricted: true,
      fusion_tier: "authoritative",
    });

    const resumed = await boot(sources);
    expect(resumed.sources).toEqual([PUBLIC]);
    expect(resumed).toMatchObject({ settled: [PUBLIC], features: 2, total: 2 });
    const [full, publicOnly] = await fusedOf("e5");
    expect(full).toMatchObject({ source_id: FUSED_SOURCE_ID, fused_public: false });
    expect(publicOnly).toMatchObject({ source_id: FUSED_PUBLIC_SOURCE_ID, fused_public: true });
    expect(amountOf(publicOnly!)).toBe("1.989");
  });
});

/**
 * A crowd price on the grade only the mirror sells. The relay, whose
 * upstream licence is not public, survives the cluster (smallest id), so a
 * crowd value must not sit at its station in the public scope.
 */
describe("where a crowd-won public fusion sits", () => {
  const STALE = "2026-09-22T11:00:00.000Z";
  const coordinatesOf = (row: FusedDbRow) =>
    ((row.record["location"] as Rec)["geometry"] as { coordinates: number[] }).coordinates;
  const at = (feature: Rec) =>
    ((feature["location"] as Rec)["geometry"] as { coordinates: number[] }).coordinates;
  const located = (rows: FusedDbRow[]) =>
    rows.map((r) => [r.source_id, r.fused_public, coordinatesOf(r)]);

  beforeAll(async () => {
    const canonical = await canonicalId();
    const [row] = await sql<{ survivor_id: string; components: Rec[] }[]>`
      SELECT survivor_id, components FROM conditions.feature_canonical
       WHERE canonical_feature_id = ${canonical}`;
    expect(row!.survivor_id).toBe(relay["id"]);
    const e10Key = row!.components.find((c) =>
      (c["members"] as Rec[]).some((m) => m["featureId"] === twin["id"] && m["key"] === "e10"),
    )!["key"] as string;
    const landed = landClaim(
      registry,
      {
        claim: {
          claimClass: "observation",
          subject: { featureId: canonical, componentKey: e10Key },
          property: "fuel.price",
          result: { type: "money", amount: "1.879", currency: "EUR", per: "L" },
          geometry: stationGeometry,
          reportedAt: "2026-09-22T12:00:00.000Z",
          nonce: "nonce-e10-price-0001",
        },
        keyId: "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY",
      },
      {
        instanceId: INSTANCE,
        now: LATER,
        attribution: { provider: `OpenConditions contributors at ${INSTANCE}`, license: "CC0-1.0" },
        resolveFeature: (featureId, componentKey) => ({
          featureId,
          ...(componentKey === undefined ? {} : { componentKey }),
          location: station["location"] as never,
        }),
      },
    );
    if (!landed.ok) throw new Error(JSON.stringify(landed.issues));
    const written = await writeRecord(
      sql,
      { draft: landed.draft },
      { registry, instanceId: INSTANCE, now: LATER },
    );
    expect(written.status).not.toBe("rejected");
    await sql`
      UPDATE conditions.observation_latest SET evidence_state = 'self_reported', confidence_score = 0.5
       WHERE crowd_record_id = ${landed.draft["id"] as string}`;
  }, 60_000);

  test("an all-public crowd fusion sits at a public member, not at the survivor", async () => {
    await syncSources(sql, [source(PUBLIC, false), source(RESTRICTED, true), source(RELAY, false)]);
    // The mirror's E10 price is stale: the crowd's wins alone.
    await polled(sql, RESTRICTED, STALE);
    await refresh();
    expect(located(await fusedOf("e10"))).toEqual([[FUSED_SOURCE_ID, true, at(station)]]);
  });

  test("a crowd-won fusion names the crowd as its contributor", async () => {
    const [row] = await sql<{ fused_sources: string[] }[]>`
      SELECT fused_sources FROM conditions.observation_latest
       WHERE source_id = ${FUSED_SOURCE_ID} AND feature_id = ${await canonicalId()}
         AND component_key IN (SELECT component_key FROM conditions.observation_latest
                                WHERE source_id = 'crowd')`;
    expect(row!.fused_sources).toEqual(["crowd"]);
    const latest = await latestOfFeatures(
      { execute: (q, p) => sql.unsafe(q, p as never[]) as never },
      {
        registry,
        features: [{ id: await canonicalId() }],
        canonical: true,
        scope: "public",
        at: new Date(LATER),
      },
    );
    const crowdWon = (latest.get(await canonicalId()) ?? []).find(
      (r) => (r.result as Rec)["amount"] === "1.879",
    );
    expect(crowdWon).toMatchObject({ source: FUSED_SOURCE_ID, contributors: ["crowd"] });
  });

  test("the public fusion a crowd value wins sits at a public member, the full one where it did", async () => {
    await polled(sql, RESTRICTED, LATER);
    await refresh();
    const rows = await fusedOf("e10");
    expect(located(rows)).toEqual([
      [FUSED_SOURCE_ID, false, at(twin)],
      [FUSED_PUBLIC_SOURCE_ID, true, at(station)],
    ]);
    expect(amountOf(rows[0]!)).toBe("1.899");
    expect(amountOf(rows[1]!)).toBe("1.879");
  });

  test("the first public member in member order is the one chosen", async () => {
    await syncSources(sql, [
      source(PUBLIC, false),
      source(RESTRICTED, false),
      source(RELAY, false),
    ]);
    await polled(sql, RESTRICTED, STALE);
    await refresh();
    expect(located(await fusedOf("e10"))).toEqual([[FUSED_SOURCE_ID, true, at(twin)]]);
  });

  test("a crowd fusion with no public member to sit at is not public", async () => {
    await syncSources(sql, [source(PUBLIC, true), source(RESTRICTED, true), source(RELAY, false)]);
    await refresh();
    expect(located(await fusedOf("e10"))).toEqual([[FUSED_SOURCE_ID, false, at(relay)]]);
  });

  test("with no public member to sit at, a public fusion is not written", async () => {
    await polled(sql, RESTRICTED, LATER);
    await refresh();
    expect(located(await fusedOf("e10"))).toEqual([[FUSED_SOURCE_ID, false, at(twin)]]);
  });

  test("a member source without readings there turning restricted moves the public fusion off its geometry", async () => {
    const refreshOutdated = () =>
      refreshOutdatedFusions(sql, { registry, instanceId: INSTANCE, now: () => LATER });
    // The register keeps the station but prices nothing there any more.
    await sql`
      DELETE FROM conditions.observation_latest
       WHERE source_id = ${PUBLIC} AND feature_id = ${station["id"] as string}`;
    await syncSources(sql, [source(PUBLIC, false), source(RESTRICTED, true), source(RELAY, false)]);
    await polled(sql, RESTRICTED, STALE);
    await refreshOutdated();
    await refresh();
    expect(located(await fusedOf("e10"))).toEqual([[FUSED_SOURCE_ID, true, at(station)]]);

    await syncSources(sql, [source(PUBLIC, true), source(RESTRICTED, true), source(RELAY, false)]);
    const counts = await refreshOutdated();
    expect(counts.sources).toEqual([PUBLIC]);
    expect(located(await fusedOf("e10"))).toEqual([[FUSED_SOURCE_ID, false, at(relay)]]);
  });
});

/** Counts actual rows returned by the two reconstruction queries without replacing them. */
function countFusionRows(tx: Sql) {
  const fetched = { candidates: 0, existing: 0, candidateQueries: 0, existingQueries: 0 };
  const measured = new Proxy(tx, {
    apply(target, thisArg, args) {
      const pending = Reflect.apply(target, thisArg, args);
      const fragments = args[0] as unknown;
      if (!Array.isArray(fragments) || !fragments.every((part) => typeof part === "string")) {
        return pending;
      }
      const shape = fragments.join(" ");
      const kind = /conditions\.observation_record/.test(shape)
        ? /l\.evidence_state/.test(shape)
          ? "candidates"
          : /since_at, fused_public/.test(shape)
            ? "existing"
            : undefined
        : undefined;
      if (kind === undefined) return pending;
      return new Proxy(pending, {
        get(query, key) {
          if (key === "then") {
            return (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
              query.then((rows: unknown[]) => {
                fetched[kind] += rows.length;
                if (kind === "candidates") fetched.candidateQueries++;
                else fetched.existingQueries++;
                return resolve(rows);
              }, reject);
          }
          const value = Reflect.get(query, key);
          return typeof value === "function" ? value.bind(query) : value;
        },
      });
    },
  });
  return { measured, fetched };
}

describe("property scopes in fusion reads", () => {
  const stock = (sourceId: string, feature: Rec, componentKey = "e5") =>
    priceDraft(sourceId, feature["id"] as string, componentKey, priceOf("e5"), {
      property: "fuel.product_available",
      result: { type: "boolean", value: sourceId === PUBLIC },
      location: feature["location"],
      freshness: { fetchedAt: LATER },
    });
  const other = minetur.features.find((f) => f["id"] !== station["id"])!;
  const toll: Rec = {
    id: `oc:feature:${PUBLIC}:scope-toll`,
    class: "feature",
    kind: "toll_point",
    temporality: "static",
    lifecycle: "operational",
    location: station["location"],
    provenance: provenanceOf(PUBLIC),
    freshness: { fetchedAt: LATER },
    details: { kind: "toll_point", v: 1 },
  };
  const tollPrice = (vehicleClass: string) => {
    const draft: Rec = {
      ...priceOf("e5"),
      property: "toll.price",
      subject: { kind: "feature", featureId: toll["id"] },
      result: {
        type: "money",
        amount: vehicleClass === "car" ? "2.00" : "4.00",
        currency: "EUR",
        per: "1",
      },
      qualifiers: { vehicleClass },
      freshness: { fetchedAt: LATER },
    };
    draft["id"] = observationId(PUBLIC, draft as never);
    return draft;
  };
  let crowdNonce = 0;

  beforeEach(async () => {
    await syncSources(sql, [source(PUBLIC, false), source(RESTRICTED, true), source(RELAY, false)]);
    for (const id of [PUBLIC, RESTRICTED, RELAY]) await polled(sql, id, LATER);
    const writes: [string, Rec][] = [
      [
        PUBLIC,
        {
          features: [...minetur.features, toll],
          observations: [
            ...minetur.observations,
            stock(PUBLIC, station),
            stock(PUBLIC, other),
            tollPrice("car"),
            tollPrice("hgv"),
          ],
        },
      ],
      [RESTRICTED, { features: [twin], observations: [twinE5, twinE10, stock(RESTRICTED, twin)] }],
      [RELAY, { features: [relay], observations: [relaySp98, stock(RELAY, relay, "sp98")] }],
    ];
    for (const [sourceId, drafts] of writes) {
      expect((await writeSnapshot(sql, sourceId, drafts, ctx)).rejected).toEqual([]);
    }
    const canonical = await canonicalId();
    await sql`DELETE FROM conditions.observation_latest WHERE source_id = 'crowd' AND feature_id = ${canonical}`;
    const [held] = await sql<{ components: Rec[] }[]>`
      SELECT components FROM conditions.feature_canonical WHERE canonical_feature_id = ${canonical}`;
    const componentKey = held!.components.find((component) =>
      (component["members"] as Rec[]).some(
        (member) => member["featureId"] === twin["id"] && member["key"] === "e10",
      ),
    )!["key"] as string;
    const claim = landClaim(
      registry,
      {
        claim: {
          claimClass: "observation",
          subject: { featureId: canonical, componentKey },
          property: "fuel.price",
          result: { type: "money", amount: "1.879", currency: "EUR", per: "L" },
          geometry: stationGeometry,
          reportedAt: NOW,
          nonce: `nonce-scope-price-${String(++crowdNonce).padStart(4, "0")}`,
        },
        keyId: "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY",
      },
      {
        instanceId: INSTANCE,
        now: LATER,
        attribution: { provider: `OpenConditions contributors at ${INSTANCE}`, license: "CC0-1.0" },
        resolveFeature: (featureId, key) => ({
          featureId,
          componentKey: key,
          location: station["location"] as never,
        }),
      },
    );
    if (!claim.ok) throw new Error(JSON.stringify(claim.issues));
    expect(
      (
        await writeRecord(
          sql,
          { draft: claim.draft },
          { registry, instanceId: INSTANCE, now: LATER },
        )
      ).status,
    ).not.toBe("rejected");
    await sql`UPDATE conditions.observation_latest SET evidence_state = 'self_reported', confidence_score = 0.5
      WHERE crowd_record_id = ${claim.draft["id"] as string}`;
    await refresh();
  }, 60_000);

  const canonicalFor = async (feature: Rec) => {
    const [row] = await sql<{ canonical_feature_id: string }[]>`
      SELECT canonical_feature_id FROM conditions.feature_canonical WHERE ${feature["id"] as string} = ANY(member_ids)`;
    return row!.canonical_feature_id;
  };
  const fusedSnapshot = (ids: string[]) => sql`
    SELECT series_id::text, source_id, feature_id, property, qualifier_key, template, reading,
           since_at, fused_public, fused_from, fused_sources
      FROM conditions.observation_latest
     WHERE source_id IN (${FUSED_SOURCE_ID}, ${FUSED_PUBLIC_SOURCE_ID}) AND feature_id = ANY(${ids}::text[])
     ORDER BY feature_id, source_id, subject_key, property, qualifier_key`;
  const measuredRefresh = async (
    scopes: FusedScope[],
    now = LATER,
    freshSources: string[] = [],
  ) => {
    let fetched!: ReturnType<typeof countFusionRows>["fetched"];
    const counts = await sql.begin(async (tx) => {
      const observer = countFusionRows(tx);
      fetched = observer.fetched;
      return refreshFused(observer.measured, registry, scopes, {
        instanceId: INSTANCE,
        now,
        freshSources,
      });
    });
    return { counts, fetched };
  };
  const expectedRows = async (canonical: string, property: string) => {
    const [row] = await sql<{ candidates: number; existing: number }[]>`
      SELECT
        (SELECT count(*)::int FROM conditions.observation_latest l
          WHERE l.property = ${property} AND l.source_id NOT IN (${FUSED_SOURCE_ID}, ${FUSED_PUBLIC_SOURCE_ID})
            AND ((l.source_id = 'crowd' AND l.feature_id = ${canonical})
              OR (l.source_id <> 'crowd' AND l.feature_id = ANY(
                SELECT unnest(member_ids) FROM conditions.feature_canonical WHERE canonical_feature_id = ${canonical})))) AS candidates,
        (SELECT count(*)::int FROM conditions.observation_latest
          WHERE property = ${property} AND feature_id = ${canonical}
            AND source_id IN (${FUSED_SOURCE_ID}, ${FUSED_PUBLIC_SOURCE_ID})) AS existing`;
    return row!;
  };

  test("fetches only requested properties from every member and crowd, without duplicate contributors", async () => {
    const canonical = await canonicalId();
    const before = await fusedSnapshot([canonical]);
    const expected = await expectedRows(canonical, "fuel.price");
    expect(expected.candidates).toBe(9);
    const result = await measuredRefresh([
      { featureId: station["id"] as string, properties: ["fuel.price", "fuel.price"] },
      { featureId: twin["id"] as string, properties: ["fuel.price"] },
      { featureId: canonical, properties: ["fuel.price"] },
    ]);
    expect(await fusedSnapshot([canonical])).toEqual(before);
    expect(result.counts.deleted).toBe(0);
    expect(result.counts.written + result.counts.unchanged).toBe(expected.existing);
    expect(result.fetched).toEqual({ ...expected, candidateQueries: 1, existingQueries: 1 });
  });

  test("uses different property scopes for different canonicals in one refresh", async () => {
    const canonical = await canonicalId();
    const second = await canonicalFor(other);
    const before = await fusedSnapshot([canonical, second]);
    const a = await expectedRows(canonical, "fuel.price");
    const b = await expectedRows(second, "fuel.product_available");
    const result = await measuredRefresh([
      { featureId: canonical, properties: ["fuel.price"] },
      { featureId: other["id"] as string, properties: ["fuel.product_available"] },
    ]);
    expect(await fusedSnapshot([canonical, second])).toEqual(before);
    expect(result.fetched.candidates).toBe(a.candidates + b.candidates);
    expect(result.fetched.existing).toBe(a.existing + b.existing);
    expect(result.counts.deleted).toBe(0);
    expect(result.counts.written + result.counts.unchanged).toBe(a.existing + b.existing);
  });

  test("an all-properties member overrides narrow scopes without broadening another canonical", async () => {
    const canonical = await canonicalId();
    const second = await canonicalFor(other);
    const before = await fusedSnapshot([canonical, second]);
    const price = await expectedRows(canonical, "fuel.price");
    const stockRows = await expectedRows(canonical, "fuel.product_available");
    const secondStock = await expectedRows(second, "fuel.product_available");
    const result = await measuredRefresh([
      { featureId: canonical, properties: ["fuel.price"] },
      { featureId: twin["id"] as string },
      { featureId: twin["id"] as string, properties: ["fuel.price"] },
      { featureId: second, properties: ["fuel.product_available"] },
    ]);
    expect(await fusedSnapshot([canonical, second])).toEqual(before);
    expect(result.fetched.candidates).toBe(
      price.candidates + stockRows.candidates + secondStock.candidates,
    );
    expect(result.fetched.existing).toBe(
      price.existing + stockRows.existing + secondStock.existing,
    );
  });

  test("an unscoped refresh still reconstructs all fusable properties", async () => {
    const canonical = await canonicalId();
    const before = await fusedSnapshot([canonical]);
    const price = await expectedRows(canonical, "fuel.price");
    const stockRows = await expectedRows(canonical, "fuel.product_available");
    const result = await measuredRefresh([{ featureId: canonical }]);
    expect(await fusedSnapshot([canonical])).toEqual(before);
    expect(result.fetched.candidates).toBe(price.candidates + stockRows.candidates);
    expect(result.fetched.existing).toBe(price.existing + stockRows.existing);
    expect(result.counts.deleted).toBe(0);
    expect(result.counts.written + result.counts.unchanged).toBe(before.length);
  });

  test("retains every qualifier series of an in-scope property", async () => {
    const canonical = await canonicalFor(toll);
    const before = await fusedSnapshot([canonical]);
    expect(before.map((row) => row.qualifier_key).sort()).toHaveLength(2);
    const expected = await expectedRows(canonical, "toll.price");
    const result = await measuredRefresh([
      { featureId: toll["id"] as string, properties: ["toll.price"] },
      { featureId: canonical, properties: ["toll.price"] },
    ]);
    expect(await fusedSnapshot([canonical])).toEqual(before);
    expect(result.counts.deleted).toBe(0);
    expect(result.counts.written + result.counts.unchanged).toBe(2);
    expect(result.fetched.candidates).toBe(expected.candidates);
    expect(result.fetched.existing).toBe(expected.existing);
  });

  test("ends only the in-scope rows when their contributors vanish", async () => {
    const canonical = await canonicalId();
    const before = await fusedSnapshot([canonical]);
    await sql`DELETE FROM conditions.observation_latest
      WHERE property = 'fuel.product_available' AND feature_id = ANY(
        SELECT unnest(member_ids) FROM conditions.feature_canonical WHERE canonical_feature_id = ${canonical})`;
    const counts = await measuredRefresh([
      { featureId: canonical, properties: ["fuel.product_available"] },
    ]);
    expect(counts.counts.deleted).toBeGreaterThan(0);
    expect(await fusedSnapshot([canonical])).toEqual(
      before.filter((row) => row.property !== "fuel.product_available"),
    );
    expect(counts.fetched.candidates).toBe(0);
    expect(counts.fetched.existing).toBe(
      before.filter((row) => row.property === "fuel.product_available").length,
    );
  });

  test("a narrow freshness refresh preserves unrelated fused rows and still honors freshSources", async () => {
    const canonical = await canonicalId();
    const before = await fusedSnapshot([canonical]);
    await polled(sql, RESTRICTED, "2026-09-22T11:00:00.000Z");
    const result = await measuredRefresh([{ featureId: canonical, properties: ["fuel.price"] }]);
    expect(amountOf((await fusedOf("e5")).find((row) => row.source_id === FUSED_SOURCE_ID)!)).toBe(
      "1.989",
    );
    const after = await fusedSnapshot([canonical]);
    expect(after.filter((row) => row.property !== "fuel.price")).toEqual(
      before.filter((row) => row.property !== "fuel.price"),
    );
    const expected = await expectedRows(canonical, "fuel.price");
    expect(result.fetched.candidates).toBe(expected.candidates);
    await measuredRefresh([{ featureId: canonical, properties: ["fuel.price"] }], LATER, [
      RESTRICTED,
    ]);
    expect(amountOf((await fusedOf("e5")).find((row) => row.source_id === FUSED_SOURCE_ID)!)).toBe(
      "1.999",
    );
  });

  test("empty and non-fusable scopes fetch nothing and leave every fused row intact", async () => {
    const canonical = await canonicalId();
    const before = await fusedSnapshot([canonical]);
    const result = await measuredRefresh([
      { featureId: canonical, properties: [] },
      { featureId: canonical, properties: ["traffic.speed", "not-a-property"] },
    ]);
    expect(result.counts).toEqual({ written: 0, unchanged: 0, deleted: 0 });
    expect(result.fetched).toEqual({
      candidates: 0,
      existing: 0,
      candidateQueries: 0,
      existingQueries: 0,
    });
    expect(await fusedSnapshot([canonical])).toEqual(before);
  });

  test("vanished subjects are removed even when every supplied property scope is empty", async () => {
    const canonical = await canonicalId();
    const second = await canonicalFor(other);
    const before = await fusedSnapshot([canonical, second]);
    const counts = await sql.begin((tx) =>
      refreshFused(tx, registry, [{ featureId: canonical, properties: [] }], {
        instanceId: INSTANCE,
        now: LATER,
        vanished: [canonical],
      }),
    );
    expect(counts.deleted).toBe(before.filter((row) => row.feature_id === canonical).length);
    expect(await fusedSnapshot([canonical, second])).toEqual(
      before.filter((row) => row.feature_id === second),
    );
  });
});

describe("a refresh of a whole register", () => {
  const BULK = "es-fuel-bulk";
  // Stations a kilometre apart, each one canonical feature with one price.
  const stations = Array.from({ length: 1_100 }, (_, i) => {
    const feature = {
      ...twinOf(BULK, [(i % 100) * 0.01 + 1, Math.floor(i / 100) * 0.01 + 1], [componentOf("e5")]),
      id: `oc:feature:${BULK}:bulk-${i}`,
      externalIds: [{ scheme: "provider", id: `bulk-${i}`, authority: BULK }],
    };
    const price = priceDraft(BULK, feature.id, "e5", priceOf("e5"), {
      location: feature.location,
      result: { type: "money", amount: (1.5 + i / 10_000).toFixed(4), currency: "EUR", per: "L" },
    });
    return { feature, price };
  });

  test("reads and writes it a share of its canonical features at a time, as it would at once", async () => {
    await syncSources(sql, [source(BULK, false)]);
    await polled(sql, BULK, LATER);
    const summary = await writeSnapshot(
      sql,
      BULK,
      {
        features: stations.map((s) => s.feature),
        observations: stations.map((s) => s.price),
      },
      ctx,
    );
    expect(summary.rejected).toEqual([]);
    const canonical = (
      await sql<{ canonical_feature_id: string }[]>`
        SELECT canonical_feature_id FROM conditions.feature_canonical
         WHERE member_ids && ${stations.map((s) => s.feature.id)}::text[]`
    ).map((r) => r.canonical_feature_id);
    expect(canonical).toHaveLength(stations.length);
    const fused = () => sql`
      SELECT feature_id, source_id, template, reading, since_at, fused_public, fused_from
        FROM conditions.observation_latest
       WHERE source_id IN (${FUSED_SOURCE_ID}, ${FUSED_PUBLIC_SOURCE_ID})
         AND feature_id = ANY(${canonical}::text[])
       ORDER BY feature_id, source_id`;
    const refreshAll = () => {
      let fetched!: ReturnType<typeof countFusionRows>["fetched"];
      return sql
        .begin(async (tx) => {
          const observer = countFusionRows(tx);
          fetched = observer.fetched;
          return refreshFused(
            observer.measured,
            registry,
            canonical.map((featureId) => ({ featureId })),
            { instanceId: INSTANCE, now: LATER },
          );
        })
        .then((counts) => ({ counts, fetched }));
    };
    const before = await fused();
    expect(before).toHaveLength(stations.length);

    const { counts, fetched } = await refreshAll();
    expect(counts.written + counts.unchanged).toBe(stations.length);
    expect(counts.deleted).toBe(0);
    expect(fetched).toEqual({
      candidates: stations.length,
      existing: stations.length,
      candidateQueries: 3,
      existingQueries: 3,
    });
    expect(await fused()).toEqual(before);
  }, 120_000);
});
