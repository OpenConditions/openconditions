import type { SEVERITY_LABELS } from "@openconditions/model";
import { EVIDENCE, withEvidence } from "./db/records.js";
import type { QueryRunner } from "./query-runner.js";
import { binder, inBox, type Scope, scopeClauses } from "./record-filters.js";
import { haversineMeters } from "./spatial.js";

type Rec = Record<string, unknown>;

/** A severity label the reader filters by, mildest first (`unknown` is never at least anything). */
export type SeverityLabel = (typeof SEVERITY_LABELS)[number];
const SEVERITY_ORDER: readonly SeverityLabel[] = ["minor", "moderate", "major", "critical"];

export interface SituationQuery {
  scope: Scope;
  /** west, south, east, north. */
  bbox?: [number, number, number, number];
  kinds?: readonly string[];
  /** Every kind but these. */
  excludeKinds?: readonly string[];
  types?: readonly string[];
  subtypes?: readonly string[];
  domain?: string;
  sources?: readonly string[];
  origins?: readonly string[];
  /** Only situations at least this severe. */
  minSeverity?: SeverityLabel;
  /** The instant situations are current at: not yet ended or expired. Default now. */
  at?: Date;
  /** Only situations starting within this many days after `at`. */
  horizonDays?: number;
  /**
   * A time window instead of an instant: situations whose validity overlaps
   * `[from, to]`, ended ones included. `to` defaults to `at`.
   */
  from?: Date;
  to?: Date;
  /** Each geometry simplified with this tolerance in degrees, written with 6 decimals. */
  simplify?: number;
  /** The last id of the previous page. */
  cursor?: string;
  limit: number;
}

export interface SituationPage {
  records: Rec[];
  /** The cursor of the next page; null when this page is the last. */
  next: string | null;
}

/**
 * The live situations matching `q`, one keyset page ordered by id. A
 * situation is current at `at` when it is not tombstoned, its own expiry has
 * not passed, its declared validity has not ended and it is neither ended nor
 * cancelled. With a window (`from`, `to`), a situation is listed when its
 * validity overlaps the window, ended or not: an earthquake of last week,
 * a burn scar mapped yesterday. A cancelled one never is, nor one past its
 * own expiry at `at`. Each page is one statement, so a walk never returns a
 * record twice and never skips one that exists throughout it; a record
 * changed mid-walk may appear in either state.
 */
export async function listSituations(db: QueryRunner, q: SituationQuery): Promise<SituationPage> {
  const at = (q.at ?? new Date()).toISOString();
  const params: unknown[] = [at];
  const p = binder(params);
  const clauses = [
    "s.tombstoned_at IS NULL",
    "(s.expires_at IS NULL OR s.expires_at > $1::timestamptz)",
    ...scopeClauses("s", q.scope),
  ];
  if (q.from !== undefined) {
    clauses.push(
      "s.validity_status <> 'cancelled'",
      `(s.valid_to IS NULL OR s.valid_to >= ${p(q.from.toISOString())}::timestamptz)`,
      `(s.valid_from IS NULL OR s.valid_from <= ${p((q.to ?? new Date(at)).toISOString())}::timestamptz)`,
    );
  } else {
    clauses.push(
      "(s.valid_to IS NULL OR s.valid_to > $1::timestamptz)",
      "s.validity_status NOT IN ('ended', 'cancelled')",
    );
  }
  if (q.bbox) {
    // An effect with its own place (a grouped record on another road) puts
    // its situation in the box too: the routing feed lists effects by their
    // own place, and a reader must find the situation each one belongs to.
    clauses.push(
      `(${inBox("s.geom", q.bbox, p)} OR EXISTS (SELECT 1 FROM conditions.situation_effect e
         WHERE e.situation_id = s.id AND ${inBox("e.geom", q.bbox, p)}))`,
    );
  }
  if (q.kinds?.length) clauses.push(`s.kind = ANY(${p([...q.kinds])}::text[])`);
  if (q.excludeKinds?.length) clauses.push(`s.kind <> ALL(${p([...q.excludeKinds])}::text[])`);
  if (q.types?.length) clauses.push(`s.type = ANY(${p([...q.types])}::text[])`);
  if (q.subtypes?.length) clauses.push(`s.subtype = ANY(${p([...q.subtypes])}::text[])`);
  if (q.domain) clauses.push(`s.domain = ${p(q.domain)}`);
  if (q.sources?.length) clauses.push(`s.source_id = ANY(${p([...q.sources])}::text[])`);
  if (q.origins?.length) clauses.push(`s.origin = ANY(${p([...q.origins])}::text[])`);
  if (q.minSeverity && q.minSeverity !== "unknown") {
    const allowed = SEVERITY_ORDER.slice(SEVERITY_ORDER.indexOf(q.minSeverity));
    clauses.push(`s.severity = ANY(${p(allowed)}::text[])`);
  }
  if (q.horizonDays !== undefined) {
    clauses.push(
      `(s.valid_from IS NULL OR s.valid_from <= $1::timestamptz + make_interval(days => ${p(q.horizonDays)}))`,
    );
  }
  if (q.cursor !== undefined) clauses.push(`s.id > ${p(q.cursor)}`);
  // A world of alert polygons is megabytes at full detail; a map drawing it
  // asks for fewer positions. The filters above read the stored geometry.
  const record =
    q.simplify === undefined
      ? "s.record"
      : `CASE WHEN s.geom IS NULL THEN s.record ELSE jsonb_set(s.record, '{location,geometry}',
           ST_AsGeoJSON(ST_SimplifyPreserveTopology(s.geom, ${p(q.simplify)}::float8), 6)::jsonb)
         END AS record`;
  const rows = await db.execute<Rec[]>(
    `SELECT s.id, ${record}${EVIDENCE.situation}
       FROM conditions.situation s
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.id
      LIMIT ${p(q.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  return {
    records: page.map(withEvidence),
    next: rows.length > q.limit ? String(page.at(-1)!["id"]) : null,
  };
}

/** Within this distance, two situations of one kind and type from different sources are one. */
const SAME_PLACE_M = 75;
/** Within this distance they are one when they also name a road in common. */
const SAME_ROAD_M = 250;

/** A geometry's representative point: the mean of its vertices. */
function pointOf(geometry: unknown): [number, number] | undefined {
  const coords: [number, number][] = [];
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") coords.push([c[0], c[1]]);
    else for (const x of c) visit(x);
  };
  const g = geometry as { coordinates?: unknown; geometries?: { coordinates?: unknown }[] } | null;
  visit(g?.coordinates);
  for (const part of g?.geometries ?? []) visit(part.coordinates);
  if (coords.length === 0) return undefined;
  return [
    coords.reduce((s, c) => s + c[0], 0) / coords.length,
    coords.reduce((s, c) => s + c[1], 0) / coords.length,
  ];
}

function roadRefs(record: Rec): Set<string> {
  const roads = ((record["location"] as Rec | undefined)?.["roads"] as Rec[] | undefined) ?? [];
  return new Set(
    roads
      .map((r) => r["ref"])
      .filter((ref): ref is string => typeof ref === "string")
      .map((ref) => ref.replace(/\s+/g, "").toUpperCase()),
  );
}

/**
 * Folds situations that describe one phenomenon from several sources: same
 * kind and type, different sources, within 75 m, or within 250 m on a road
 * both name. The first in order survives and lists the others in
 * `provenance.mergedSources`, so no source's attribution is dropped.
 *
 * It folds the records it is given, one keyset page: a fold across pages is
 * not offered, because whether a record survives depends on every earlier
 * record chained to it by distance, which can lie on any earlier page, and
 * reading those would turn each page into a scan of the walk so far.
 */
export function dedupeSituations(records: readonly Rec[]): Rec[] {
  const out: { record: Rec; point?: [number, number]; roads: Set<string> }[] = [];
  for (const record of records) {
    const provenance = record["provenance"] as Rec;
    const point = pointOf((record["location"] as Rec | undefined)?.["geometry"]);
    const roads = roadRefs(record);
    const survivor =
      point === undefined
        ? undefined
        : out.find((o) => {
            const p = o.record["provenance"] as Rec;
            if (o.point === undefined || p["sourceId"] === provenance["sourceId"]) return false;
            if (o.record["kind"] !== record["kind"] || o.record["type"] !== record["type"]) {
              return false;
            }
            const d = haversineMeters(o.point, point);
            return (
              d <= SAME_PLACE_M || (d <= SAME_ROAD_M && [...roads].some((r) => o.roads.has(r)))
            );
          });
    if (survivor === undefined) {
      out.push({ record, ...(point ? { point } : {}), roads });
      continue;
    }
    const kept = survivor.record["provenance"] as Rec;
    const merged = (kept["mergedSources"] as Rec[] | undefined) ?? [];
    survivor.record = {
      ...survivor.record,
      provenance: {
        ...kept,
        mergedSources: [
          ...merged,
          {
            source: provenance["sourceId"],
            recordId: provenance["recordId"],
            attribution: provenance["attribution"],
            link: "same_phenomenon",
          },
        ],
      },
    };
  }
  return out.map((o) => o.record);
}
