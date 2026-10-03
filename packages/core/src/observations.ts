import {
  FUSED_SOURCE_ID,
  type PropertyEntry,
  qualifierKey,
  type Registry,
} from "@openconditions/model";
import { withEvidence } from "./db/records.js";
import { recordFromHistory } from "./observation-codec.js";
import type { QueryRunner } from "./query-runner.js";

type Rec = Record<string, unknown>;

/** The source id of every crowd row, local or a peer's. */
const CROWD_SOURCE_ID = "crowd";

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
  /** west, south, east, north. */
  bbox?: [number, number, number, number];
  properties?: readonly string[];
  /** Only properties of this domain. */
  domain?: string;
  sources?: readonly string[];
  origins?: readonly string[];
  /**
   * The canonical view: the fused row of every fusable property and the
   * per-source rows of the others. Otherwise per-source and crowd rows, and
   * no fused row.
   */
  canonical?: boolean;
  /** The instant readings are current at: not past their expiry. Default now. */
  at?: Date;
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
 * expired or was negated is no longer current.
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
  const clauses = [
    "(l.expires_at IS NULL OR l.expires_at > $1::timestamptz)",
    "(l.evidence_state IS NULL OR l.evidence_state NOT IN ('expired', 'negated'))",
  ];
  if (q.canonical) {
    const fusable = [...fusableProperties(registry)];
    clauses.push(
      `(l.source_id = ${p(FUSED_SOURCE_ID)} OR (l.property <> ALL(${p(fusable)}::text[])
         AND l.source_id <> ${p(CROWD_SOURCE_ID)}))`,
    );
  } else {
    clauses.push(`l.source_id <> ${p(FUSED_SOURCE_ID)}`);
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
  if (q.cursor !== undefined) clauses.push(`l.series_id > ${p(q.cursor)}`);
  const rows = await db.execute<Rec[]>(
    `SELECT l.series_id::text AS series_id,
            conditions.observation_record(l.template, l.reading) AS record,
            l.evidence_state, l.confidence_score,
            false AS routing_eligible, l.corroborations
       FROM conditions.observation_latest l
      WHERE ${clauses.join(" AND ")}
      ORDER BY l.series_id
      LIMIT ${p(q.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  return {
    records: page.map(withEvidence),
    next: rows.length > q.limit ? String(page.at(-1)!["series_id"]) : null,
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
  | { status: "no_rollup"; property: string };

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

/**
 * One series over [from, to): its raw readings, oldest first, or its hourly
 * or daily rollups (see {@link seriesResolution}), a page at a time. A raw
 * page's cursor is the last reading's phenomenon start and issue time, a
 * rollup page's the last period's start. A fused row keeps no history, so it
 * is never a series here.
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
  const candidates = await db.execute<{ series_id: string; source_id: string; template: Rec }[]>(
    `SELECT series_id::text AS series_id, source_id, template FROM conditions.observation_latest
      WHERE subject_key = $1 AND property = $2 AND qualifier_key = $3 AND source_id <> $4
        AND ($5::text IS NULL OR source_id = $5)
      ORDER BY source_id`,
    [
      selector.subjectKey,
      selector.property,
      qualifiers,
      FUSED_SOURCE_ID,
      selector.sourceId ?? null,
    ],
  );
  if (candidates.length === 0) return { status: "none" };
  if (candidates.length > 1) {
    return { status: "ambiguous", sources: candidates.map((c) => c.source_id) };
  }
  const [series] = candidates as [(typeof candidates)[number]];
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
    const rows = await db.execute<(Rec & { payload_hashes: string[] | null })[]>(
      `SELECT o.*, a.payload_hashes
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
    found.records = page.map((row) =>
      recordFromHistory(registry, series.template, row, row.payload_hashes ?? []),
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
