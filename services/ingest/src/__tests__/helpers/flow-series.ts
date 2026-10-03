/**
 * Readings of measurement sites for the speed-pipeline suites, written the way a
 * flow poll writes them, and the rollup rows the nightly derivations read.
 */
import { observationId } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  writeSnapshot,
} from "@openconditions/storage";
import type postgres from "postgres";

type Rec = Record<string, unknown>;
type Geometry =
  | { type: "Point"; coordinates: number[] }
  | { type: "LineString"; coordinates: number[][] }
  | { type: "MultiLineString"; coordinates: number[][][] };

const registry = productionRegistry();

/** The subject key of a site's series, as the baselines and snaps key it. */
export const siteKey = (source: string, site: string) => `feature:oc:feature:${source}:${site}`;

/** Registers a flow source in the catalogue table, as boot does. */
export async function seedFlowSource(sql: postgres.Sql, id: string): Promise<void> {
  await sql`
    INSERT INTO conditions.source (id, domain, format, produces, access_mode, tier, country,
      operator, license, attribution, cadence_sec, freshness_window_sec)
    VALUES (${id}, 'roads', 'datex2', 'flow', 'bulk', 'authoritative', 'NL', 'test',
      'CC0-1.0', 'Test', 60, 300)
    ON CONFLICT (id) DO NOTHING`;
}

export interface SiteReading {
  site: string;
  geometry: Geometry;
  /** The reading's instant, or its period's start when `until` is given. */
  at: string;
  /** The end of a reading over a period (a 15-minute mean, say). */
  until?: string;
  speed?: number;
  /** A level of service the source states. */
  los?: string;
  /** The free-flow speed the reading's baseline carries. */
  freeFlowKph?: number;
  /** A lane or class channel of the site. */
  componentKey?: string;
}

function draft(source: string, r: SiteReading, property: string, result: Rec): Rec {
  const d: Rec = {
    class: "observation",
    kind: "observation",
    temporality: "live",
    property,
    subject: {
      kind: "feature",
      featureId: `oc:feature:${source}:${r.site}`,
      ...(r.componentKey !== undefined ? { componentKey: r.componentKey } : {}),
    },
    result,
    phenomenonTime: r.until !== undefined ? { start: r.at, end: r.until } : { instant: r.at },
    aggregation: property === "traffic.speed" ? "mean" : "instantaneous",
    location: {
      geometry: r.geometry,
      extent: r.geometry.type === "Point" ? "point" : "linear",
      geometryOrigin: "site_table",
      fuzziness: "exact",
    },
    provenance: {
      origin: "feed",
      sourceId: source,
      sourceFormat: "datex2",
      accessMode: "bulk",
      recordId: r.site,
      attribution: { provider: "Test", license: "CC0-1.0" },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: r.at },
    ...(property === "traffic.speed" && r.freeFlowKph !== undefined
      ? {
          baseline: {
            freeFlow: { value: r.freeFlowKph, unit: "km/h" },
            source: "native",
          },
        }
      : {}),
  };
  d["id"] = observationId(source, d as Parameters<typeof observationId>[1]);
  return d;
}

/**
 * Writes one poll's site readings of `source` (speed and stated level of
 * service) as of `now`, with the history partitions that time needs. The
 * source is registered as a flow feed unless `catalogued` is false.
 */
export async function writeSiteReadings(
  sql: postgres.Sql,
  source: string,
  readings: readonly SiteReading[],
  now: string,
  { catalogued = true }: { catalogued?: boolean } = {},
): Promise<void> {
  if (catalogued) await seedFlowSource(sql, source);
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(now),
  });
  const observations = readings.flatMap((r) => [
    ...(r.speed !== undefined
      ? [draft(source, r, "traffic.speed", { type: "quantity", value: r.speed, unit: "km/h" })]
      : []),
    ...(r.los !== undefined
      ? [draft(source, r, "traffic.los", { type: "category", value: r.los, vocabulary: "los" })]
      : []),
  ]);
  const summary = await writeSnapshot(
    sql,
    source,
    { observations },
    { registry, instanceId: "test.local", now, complete: { situation: true } },
  );
  if (summary.rejected.length > 0) {
    throw new Error(`readings rejected: ${JSON.stringify(summary.rejected[0])}`);
  }
}

/** Writes a site's `measurement_site` feature, naming the roads its location is on. */
export async function writeSiteFeature(
  sql: postgres.Sql,
  source: string,
  site: string,
  geometry: Geometry,
  roads: readonly { ref: string }[],
  now: string,
): Promise<void> {
  const feature: Rec = {
    id: `oc:feature:${source}:${site}`,
    class: "feature",
    kind: "measurement_site",
    type: "traffic",
    temporality: "static",
    lifecycle: "operational",
    location: {
      geometry,
      extent: geometry.type === "Point" ? "point" : "linear",
      geometryOrigin: "site_table",
      fuzziness: "exact",
      roads,
    },
    provenance: {
      origin: "feed",
      sourceId: source,
      sourceFormat: "datex2",
      accessMode: "bulk",
      recordId: site,
      attribution: { provider: "Test", license: "CC0-1.0" },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: now },
    details: { kind: "measurement_site", v: 1, measuredProperties: ["traffic.speed"] },
  };
  const summary = await writeSnapshot(
    sql,
    source,
    { features: [feature] },
    { registry, instanceId: "test.local", now, complete: false },
  );
  if (summary.rejected.length > 0) {
    throw new Error(`feature rejected: ${JSON.stringify(summary.rejected[0])}`);
  }
}

/** The series id of a site's `traffic.speed` series. */
export async function speedSeriesId(sql: postgres.Sql, subjectKey: string): Promise<number> {
  const [row] = await sql<{ series_id: string }[]>`
    SELECT series_id FROM conditions.observation_latest
     WHERE subject_key = ${subjectKey} AND property = 'traffic.speed'`;
  if (row === undefined) throw new Error(`no speed series for ${subjectKey}`);
  return Number(row.series_id);
}

/** One hour of a speed series' rollup: a sparse histogram of 2 km/h bins. */
export async function seedHourly(
  sql: postgres.Sql,
  seriesId: number,
  hour: string | Date,
  bins: readonly number[],
  counts: readonly number[],
): Promise<void> {
  const total = counts.reduce((a, b) => a + b, 0);
  const mean = bins.reduce((a, b, i) => a + (b * 2 + 1) * counts[i]!, 0) / Math.max(1, total);
  await sql`
    INSERT INTO conditions.observation_rollup_hourly
      (series_id, hour_utc, sample_count, bins, counts, min, max, mean)
    VALUES (${seriesId}, ${hour instanceof Date ? hour.toISOString() : hour}, ${total},
      ${sql.array(bins as number[])}::smallint[], ${sql.array(counts as number[])}::int[],
      ${Math.min(...bins) * 2}, ${Math.max(...bins) * 2 + 2}, ${mean})
    ON CONFLICT (series_id, hour_utc) DO UPDATE SET
      sample_count = excluded.sample_count, bins = excluded.bins, counts = excluded.counts`;
}

/**
 * A site with a speed series, and one hour of its rollup holding `speeds`
 * (binned as the hourly rollup bins them). Returns the site's subject key.
 */
export async function seedSpeedHour(
  sql: postgres.Sql,
  source: string,
  site: string,
  speeds: readonly number[],
  hour: Date,
  geometry: Geometry = { type: "Point", coordinates: [0, 0] },
): Promise<string> {
  const key = siteKey(source, site);
  const [held] = await sql`SELECT 1 FROM conditions.observation_latest
    WHERE subject_key = ${key} AND property = 'traffic.speed'`;
  if (held === undefined) {
    const now = new Date().toISOString();
    await writeSiteReadings(sql, source, [{ site, geometry, at: now, speed: speeds[0] ?? 0 }], now);
  }
  const histogram = new Map<number, number>();
  for (const v of speeds) {
    const bin = Math.max(0, Math.floor(v / 2));
    histogram.set(bin, (histogram.get(bin) ?? 0) + 1);
  }
  const bins = [...histogram.keys()].sort((a, b) => a - b);
  await seedHourly(
    sql,
    await speedSeriesId(sql, key),
    hour,
    bins,
    bins.map((b) => histogram.get(b)!),
  );
  return key;
}
