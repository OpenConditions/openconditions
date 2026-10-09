import {
  FUSED_SOURCE_IDS,
  type PropertyEntry,
  qualifierKey,
  type Registry,
} from "@openconditions/model";
import { withEvidence } from "./db/records.js";
import { CROWD_SOURCE_ID, currentReadingClauses, readingColumns } from "./live-rows.js";
import { recordFromHistory } from "./observation-codec.js";
import type { QueryRunner } from "./query-runner.js";
import { type Scope, scopeClauses } from "./record-filters.js";
import { validWhilePolled, withPolledValidity } from "./validity.js";

type Rec = Record<string, unknown>;

/**
 * The properties that get a fused row: those a feature of a linkable kind
 * can carry, where several sources may describe one thing, and those the
 * crowd reports, whose rows sit beside a feed's. Anything else (traffic
 * readings of a measurement site, which never links) has exactly one source
 * per subject, so a fused row would only copy it.
 */
export function fusableProperties(registry: Registry): Set<string> {
  const linkable = new Set(
    registry
      .kinds("feature")
      .filter((k) => k.linking !== undefined)
      .map((k) => k.code),
  );
  const kindsOf = (spec: SubjectKinds) => subjectKinds(registry, spec);
  return new Set(
    registry
      .properties()
      .filter(
        (p) =>
          p.crowd !== undefined ||
          p.subjects.some(
            (s) => s.kind === "feature" && kindsOf(s).some((k) => linkable.has(k.code)),
          ),
      )
      .map((p) => p.code),
  );
}

type SubjectKinds = { featureKinds?: readonly string[]; traits?: readonly string[] };

const subjectKinds = (registry: Registry, spec: SubjectKinds) =>
  spec.featureKinds === undefined && spec.traits === undefined
    ? registry.kinds("feature")
    : registry
        .kinds("feature")
        .filter(
          (k) =>
            spec.featureKinds?.includes(k.code) || spec.traits?.some((t) => k.traits?.includes(t)),
        );

/**
 * The feature kinds a fusable property can be about: only their canonical
 * features ever hold a fused row, so a write of any other kind (a flow poll's
 * measurement sites) has none to refresh.
 */
export function fusableFeatureKinds(registry: Registry): Set<string> {
  const fusable = fusableProperties(registry);
  return new Set(
    registry
      .properties()
      .filter((p) => fusable.has(p.code))
      .flatMap((p) => p.subjects.filter((s) => s.kind === "feature"))
      .flatMap((s) => subjectKinds(registry, s).map((k) => k.code)),
  );
}

export interface LatestObservationQuery {
  scope: Scope;
  /** west, south, east, north. */
  bbox?: [number, number, number, number];
  properties?: readonly string[];
  /** Only properties of this domain. */
  domain?: string;
  sources?: readonly string[];
  origins?: readonly string[];
  /**
   * The canonical view: the fused row of every fusable property of a
   * feature (in public scope the public fusion, `fused_public`; for the
   * operator the fusion of every source, `@fused`) and the per-source rows
   * of the others, and every reading of a subject that is not a feature (a
   * place: fusion does not cover it). Otherwise per-source and crowd rows,
   * and no fused row.
   */
  canonical?: boolean;
  /** The instant readings are current at: not past their expiry. Default now. */
  at?: Date;
  /** Only readings in effect from this instant on (their phenomenon started then or later). */
  since?: Date;
  /** The series id the previous page ended at. */
  cursor?: number;
  limit: number;
}

export interface LatestObservationPage {
  records: Rec[];
  /** The cursor of the next page, a series id; null when this page is the last. */
  next: string | null;
}

/**
 * The reading in effect of every series matching `q`, one keyset page
 * ordered by series id. The series id is the cursor because a series keeps
 * it for life while its reading (and so the record id) moves on with every
 * poll: a walk never returns a series twice and never skips one that exists
 * throughout it, and a series that moved mid-walk may appear in either
 * state. A crowd reading carries its evidence summary; one whose evidence
 * expired or was negated is no longer current. A polled feed's reading of a
 * change-only property, and a fusion of such readings, carries the validity
 * its sources' polling gives it (`withPolledValidity`): their polling now,
 * whatever `at` the read asks for.
 */
export async function listLatestObservations(
  db: QueryRunner,
  registry: Registry,
  q: LatestObservationQuery,
): Promise<LatestObservationPage> {
  const at = (q.at ?? new Date()).toISOString();
  const params: unknown[] = [at];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses = currentReadingClauses("l", "$1", q.scope);
  if (q.canonical) {
    // Fusion covers features only: a place's readings, crowd ones among
    // them, have no fused row to stand for them and are served as they are.
    // The scope's clauses leave the one fused row the scope reads.
    const fusable = [...fusableProperties(registry)];
    clauses.push(
      `(l.source_id = ANY(${p([...FUSED_SOURCE_IDS])}::text[]) OR l.subject_kind <> 'feature'
         OR (l.property <> ALL(${p(fusable)}::text[]) AND l.source_id <> ${p(CROWD_SOURCE_ID)}))`,
    );
  } else {
    clauses.push(`l.source_id <> ALL(${p([...FUSED_SOURCE_IDS])}::text[])`);
  }
  if (q.bbox) {
    const [w, s, e, n] = q.bbox;
    clauses.push(`l.geom && ST_MakeEnvelope(${p(w)}, ${p(s)}, ${p(e)}, ${p(n)}, 4326)`);
  }
  let properties = q.properties?.length ? [...q.properties] : undefined;
  if (q.domain !== undefined) {
    const inDomain = registry
      .properties()
      .filter((e) => e.domain === q.domain)
      .map((e) => e.code);
    properties = properties ? properties.filter((c) => inDomain.includes(c)) : inDomain;
  }
  if (properties) clauses.push(`l.property = ANY(${p(properties)}::text[])`);
  if (q.sources?.length) clauses.push(`l.source_id = ANY(${p([...q.sources])}::text[])`);
  if (q.origins?.length) {
    clauses.push(`l.template #>> '{provenance,origin}' = ANY(${p([...q.origins])}::text[])`);
  }
  if (q.since !== undefined) {
    clauses.push(`l.effective_from >= ${p(q.since.toISOString())}::timestamptz`);
  }
  if (q.cursor !== undefined) clauses.push(`l.series_id > ${p(q.cursor)}`);
  const rows = await db.execute<Rec[]>(
    `SELECT l.series_id::text AS series_id, ${readingColumns("l")}
       FROM conditions.observation_latest l
      WHERE ${clauses.join(" AND ")}
      ORDER BY l.series_id
      LIMIT ${p(q.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  return {
    records: await withPolledValidity(db, registry, page.map(withEvidence)),
    next: rows.length > q.limit ? String(page.at(-1)!["series_id"]) : null,
  };
}

/** The most cells a grid read may cover: past it, a coarser cell is asked for. */
export const MAX_GRID_CELLS = 50_000;

/** The cells, aligned on multiples of `cellDeg` from 0°, that `bbox` touches. */
export function gridCellCount(bbox: readonly [number, number, number, number], cellDeg: number) {
  const [w, s, e, n] = bbox;
  const span = (lo: number, hi: number) => Math.floor(hi / cellDeg) - Math.floor(lo / cellDeg) + 1;
  return span(w, e) * span(s, n);
}

/** The provenance a grid read judges a source's readings by: the licences they carry. */
export interface GridProvenance {
  attribution: { license: string };
  upstream?: { license?: string }[];
}

export interface GridQuery {
  scope: Scope;
  property: string;
  /** west, south, east, north. */
  bbox: [number, number, number, number];
  /** The cell size in degrees. */
  cellDeg: number;
  /** Only readings in effect from this instant on. */
  since: Date;
  sources?: readonly string[];
  /** The instant readings are current at. Default now. */
  at?: Date;
  /** Whether readings of this provenance may be counted (the licence egress); default all. */
  admits?: (provenance: GridProvenance) => boolean;
}

export interface Grid {
  /** Each cell with a reading: its centre's longitude and latitude, the count, sum and maximum. */
  cells: [number, number, number, number, number][];
  /** The sources counted, sorted. */
  sources: string[];
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * The current numeric readings of one property in `bbox`, counted, summed
 * and maximised per cell of `cellDeg` degrees: a world of fire pixels as a
 * few thousand cells instead of hundreds of thousands of readings. A reading
 * falls in the cell of its geometry's point on surface. The scope's sources
 * and `admits` decide what is counted, as they would decide what is served.
 */
export async function readGrid(db: QueryRunner, q: GridQuery): Promise<Grid> {
  const params: unknown[] = [(q.at ?? new Date()).toISOString()];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const [w, s, e, n] = q.bbox;
  const cell = `${p(q.cellDeg)}::float8`;
  const clauses = [
    ...currentReadingClauses("l", "$1", q.scope),
    `l.source_id <> ALL(${p([...FUSED_SOURCE_IDS])}::text[])`,
    `l.property = ${p(q.property)}`,
    "l.value_num IS NOT NULL",
    `l.effective_from >= ${p(q.since.toISOString())}::timestamptz`,
    `l.geom && ST_MakeEnvelope(${p(w)}, ${p(s)}, ${p(e)}, ${p(n)}, 4326)`,
  ];
  if (q.sources?.length) clauses.push(`l.source_id = ANY(${p([...q.sources])}::text[])`);
  const rows = await db.execute<
    {
      x: number;
      y: number;
      source_id: string;
      provenance: GridProvenance;
      n: number;
      sum: number;
      max: number;
    }[]
  >(
    `SELECT floor(ST_X(pt.g) / ${cell})::int AS x, floor(ST_Y(pt.g) / ${cell})::int AS y,
            l.source_id,
            jsonb_build_object(
              'attribution', l.template #> '{provenance,attribution}',
              'upstream', COALESCE(l.template #> '{provenance,upstream}', '[]'::jsonb)
            ) AS provenance,
            count(*)::int AS n, sum(l.value_num)::float8 AS sum, max(l.value_num)::float8 AS max
       FROM conditions.observation_latest l
       CROSS JOIN LATERAL (SELECT ST_PointOnSurface(l.geom) AS g) pt
      WHERE ${clauses.join(" AND ")}
      GROUP BY 1, 2, 3, 4`,
    params,
  );
  const cells = new Map<string, [number, number, number, number, number]>();
  const sources = new Set<string>();
  for (const r of rows) {
    if (q.admits !== undefined && !q.admits(r.provenance)) continue;
    sources.add(r.source_id);
    const key = `${r.x},${r.y}`;
    const held = cells.get(key);
    if (held === undefined) {
      cells.set(key, [
        round6((r.x + 0.5) * q.cellDeg),
        round6((r.y + 0.5) * q.cellDeg),
        r.n,
        r.sum,
        r.max,
      ]);
    } else {
      held[2] += r.n;
      held[3] += r.sum;
      held[4] = Math.max(held[4], r.max);
    }
  }
  return {
    cells: [...cells.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    sources: [...sources].sort(),
  };
}

/** How a series read is resolved: raw readings, or hourly or daily rollups. */
export type SeriesResolution = "raw" | "hourly" | "daily";

const DAY_MS = 86_400_000;

/**
 * The resolution a series read uses: the one asked for, if the property
 * keeps it; otherwise raw readings while `from` is within the property's raw
 * retention (or the property keeps raw readings for good), else its rollup.
 * One read is one resolution, so a range that starts before the retention
 * reads rollups throughout. Undefined when the property keeps no rollup of
 * the period asked for.
 */
export function seriesResolution(
  entry: Pick<PropertyEntry, "retention">,
  opts: { from: Date; now: Date; requested?: SeriesResolution },
): SeriesResolution | undefined {
  const rollup = entry.retention?.rollup?.period;
  if (opts.requested !== undefined) {
    return opts.requested === "raw" || opts.requested === rollup ? opts.requested : undefined;
  }
  const rawDays = entry.retention?.rawDays;
  if (rawDays === undefined || rollup === undefined) return "raw";
  return opts.from.getTime() >= opts.now.getTime() - rawDays * DAY_MS ? "raw" : rollup;
}

/** What names one series: a subject key, a property, its qualifiers and, where needed, the source. */
export interface SeriesSelector {
  scope: Scope;
  subjectKey: string;
  property: string;
  qualifiers?: Rec;
  /** Needed only where several sources report on one subject. */
  sourceId?: string;
}

export interface SeriesQuery {
  from: Date;
  to: Date;
  resolution?: SeriesResolution;
  /** The `next` of the previous page. */
  cursor?: string;
  limit: number;
  /** The clock retention is measured from. Default now. */
  now?: Date;
}

/** One hourly or daily aggregate of a series. */
export interface SeriesRollup {
  start: string;
  end: string;
  sampleCount: number;
  min: number;
  max: number;
  mean: number;
  unit?: string;
  histogram?: { binWidth: number; bins: number[]; counts: number[] };
}

export interface SeriesFound {
  status: "found";
  series: {
    subjectKey: string;
    property: string;
    qualifierKey: string;
    sourceId: string;
    /** The series' provenance (without what varies per reading), for licence egress. */
    provenance: Rec;
  };
  resolution: SeriesResolution;
  /** Raw readings, oldest first, rebuilt as the records they were written from. */
  records?: Rec[];
  rollups?: SeriesRollup[];
  next: string | null;
}

export type SeriesRead =
  | SeriesFound
  | { status: "none" }
  | { status: "ambiguous"; sources: string[] }
  | { status: "no_rollup"; property: string }
  /** A series kept as its reading in effect only (a lane's, say): it has no range to read. */
  | { status: "no_history"; property: string };

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

/**
 * One series over [from, to): its raw readings, oldest first, or its hourly
 * or daily rollups (see {@link seriesResolution}), a page at a time. A raw
 * page's cursor is the last reading's phenomenon start and issue time, a
 * rollup page's the last period's start. A fused row keeps no history, so it
 * is never a series here. A polled feed's raw reading of a change-only
 * property is valid until the next change of its series, the one in effect
 * as long as its source's polling gives it (`withPolledValidity`).
 */
export async function readSeries(
  db: QueryRunner,
  registry: Registry,
  selector: SeriesSelector,
  q: SeriesQuery,
): Promise<SeriesRead> {
  const entry = registry.property(selector.property);
  if (entry === undefined) return { status: "none" };
  const qualifiers = qualifierKey(selector.qualifiers);
  const candidates = await db.execute<
    { series_id: string; source_id: string; template: Rec; retention_days: number | null }[]
  >(
    `SELECT l.series_id::text AS series_id, l.source_id, l.template, l.retention_days
       FROM conditions.observation_latest l
      WHERE l.subject_key = $1 AND l.property = $2 AND l.qualifier_key = $3
        AND l.source_id <> ALL($4::text[]) AND ($5::text IS NULL OR l.source_id = $5)
        ${scopeClauses("l", selector.scope)
          .map((c) => `AND ${c}`)
          .join(" ")}
      ORDER BY l.source_id`,
    [
      selector.subjectKey,
      selector.property,
      qualifiers,
      [...FUSED_SOURCE_IDS],
      selector.sourceId ?? null,
    ],
  );
  if (candidates.length === 0) return { status: "none" };
  if (candidates.length > 1) {
    return { status: "ambiguous", sources: candidates.map((c) => c.source_id) };
  }
  const [series] = candidates as [(typeof candidates)[number]];
  // A series without a retention keeps no readings beyond the one in effect.
  if (series.retention_days === null) return { status: "no_history", property: entry.code };
  const resolution = seriesResolution(entry, {
    from: q.from,
    now: q.now ?? new Date(),
    ...(q.resolution !== undefined ? { requested: q.resolution } : {}),
  });
  if (resolution === undefined) return { status: "no_rollup", property: entry.code };
  const found: SeriesFound = {
    status: "found",
    series: {
      subjectKey: selector.subjectKey,
      property: entry.code,
      qualifierKey: qualifiers,
      sourceId: series.source_id,
      provenance: series.template["provenance"] as Rec,
    },
    resolution,
    next: null,
  };
  const from = q.from.toISOString();
  const to = q.to.toISOString();
  if (resolution === "raw") {
    const [start, issued] = q.cursor === undefined ? [] : q.cursor.split("|");
    // The cursor binds as text: a client serialising a timestamptz parameter
    // through a Date cannot carry the `-infinity` of a reading that is no forecast.
    const rows = await db.execute<
      (Rec & { payload_hashes: string[] | null; superseded_at: Date | string | null })[]
    >(
      `SELECT o.*, a.payload_hashes,
              (SELECT min(n.phenomenon_start) FROM conditions.observation n
                WHERE n.series_id = o.series_id AND n.retention_days = o.retention_days
                  AND n.phenomenon_start > o.phenomenon_start)
                AS superseded_at
         FROM conditions.observation o
         LEFT JOIN conditions.source_poll_attempt a ON a.id = o.fetch_id
        WHERE o.series_id = $1 AND o.phenomenon_start >= $2 AND o.phenomenon_start < $3
          AND ($4::text IS NULL
            OR (o.phenomenon_start, o.issued_at) > ($4::text::timestamptz, $5::text::timestamptz))
        ORDER BY o.phenomenon_start, o.issued_at
        LIMIT $6`,
      [series.series_id, from, to, start ?? null, issued ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    // A polled feed's change-only reading held until the next change; the
    // one in effect, while its source polls.
    found.records = await withPolledValidity(
      db,
      registry,
      page.map(({ superseded_at, ...row }) => {
        const record = recordFromHistory(registry, series.template, row, row.payload_hashes ?? []);
        return superseded_at !== null &&
          record["validUntil"] === undefined &&
          validWhilePolled(registry, record)
          ? { ...record, validUntil: iso(superseded_at) }
          : record;
      }),
    );
    if (rows.length > q.limit) {
      const last = page.at(-1)!;
      found.next = `${iso(last["phenomenon_start"])}|${issuedOf(last["issued_at"])}`;
    }
    return found;
  }
  const hourly = resolution === "hourly";
  const rows = await db.execute<Rec[]>(
    hourly
      ? `SELECT hour_utc AS start, sample_count, bins, counts, min, max, mean
           FROM conditions.observation_rollup_hourly
          WHERE series_id = $1 AND hour_utc >= $2 AND hour_utc < $3
            AND ($4::timestamptz IS NULL OR hour_utc > $4)
          ORDER BY hour_utc LIMIT $5`
      : `SELECT day_utc::text AS start, sample_count, min, max, mean
           FROM conditions.observation_rollup_daily
          WHERE series_id = $1 AND day_utc >= $2::timestamptz::date AND day_utc < $3::timestamptz::date
            AND ($4::timestamptz IS NULL OR day_utc > $4::timestamptz::date)
          ORDER BY day_utc LIMIT $5`,
    [series.series_id, from, to, q.cursor ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  const period = hourly ? 3_600_000 : DAY_MS;
  const unit = entry.result.type === "quantity" ? entry.result.unit : undefined;
  const histogram = entry.retention?.rollup;
  const binWidth = histogram && "histogram" in histogram ? histogram.histogram.binWidth : undefined;
  found.rollups = page.map((r) => {
    const start = new Date(hourly ? iso(r["start"]) : `${String(r["start"])}T00:00:00.000Z`);
    return {
      start: start.toISOString(),
      end: new Date(start.getTime() + period).toISOString(),
      sampleCount: Number(r["sample_count"]),
      min: Number(r["min"]),
      max: Number(r["max"]),
      mean: Number(r["mean"]),
      ...(unit !== undefined ? { unit } : {}),
      ...(binWidth !== undefined && r["bins"] != null
        ? {
            histogram: {
              binWidth,
              bins: (r["bins"] as number[]).map(Number),
              counts: (r["counts"] as number[]).map(Number),
            },
          }
        : {}),
    };
  });
  if (rows.length > q.limit) found.next = found.rollups.at(-1)!.start;
  return found;
}

/** An issue time as a cursor part: `-infinity` for a reading that is not a forecast. */
function issuedOf(v: unknown): string {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "-infinity";
  return String(v);
}
