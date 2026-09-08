import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { GeoJsonGeometry } from "@openconditions/core";
import {
  BIND_DEFAULTS,
  RESOLVER_VERSION,
  bboxOf,
  bindEvent,
  expandBbox,
  toBindInput,
  type BindInput,
  type BindResult,
  type SpineSegment,
} from "@openconditions/roads";
import { loadOsmRegions } from "./osm-import.js";

type Sql = postgres.Sql;

export interface BindObservationsResult {
  attempted: number;
  bound: number;
  skippedUnchanged: number;
  /** Bindings dropped because their event is no longer an active road event. */
  cleared: number;
  /** Events whose resolved binding could not be persisted; counted, not thrown. */
  writeErrors: number;
  byStatus: Record<string, number>;
}

/** Default parallelism for resolving a swap's changed events. */
const DEFAULT_CONCURRENCY = 8;

/**
 * Reads the binding knobs per call (never cached), treating an empty string as
 * unset so Compose's `${VAR:-}` unset-injection behaves like an absent var.
 * `BIND_ENABLED` defaults to on; a non-positive or unparseable offset/
 * concurrency falls back to its default rather than disabling the stage.
 */
export function bindOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  maxOffsetM: number;
  concurrency: number;
} {
  const enabledRaw = env["BIND_ENABLED"];
  const enabled =
    enabledRaw == null || enabledRaw === "" ? true : enabledRaw.trim().toLowerCase() !== "false";
  const off = Number(env["BIND_MAX_OFFSET_M"]);
  const conc = Number(env["BIND_CONCURRENCY"]);
  return {
    enabled,
    maxOffsetM: Number.isFinite(off) && off > 0 ? off : BIND_DEFAULTS.maxOffsetM,
    concurrency: Number.isFinite(conc) && conc > 0 ? Math.floor(conc) : DEFAULT_CONCURRENCY,
  };
}

interface EventRow {
  id: string;
  type: string | null;
  geojson: string;
  attributes: Record<string, unknown> | null;
  existing_hash: string | null;
  existing_version: string | null;
}

/**
 * Identity of a binding's inputs: every {@link BindInput} field the resolver
 * reads. Unchanged hash + unchanged resolver version means the stored binding
 * is still the answer, so the event is skipped on rebind. `type` belongs in
 * here as much as the geometry does — `bindEvent` short-circuits on the
 * not-applicable types, so an event whose type flips to `weather` must lose
 * its old spans rather than be skipped as unchanged.
 */
function bindInputHash(input: BindInput): string {
  return createHash("md5")
    .update(JSON.stringify(input.geometry))
    .update("|")
    .update(input.refs.join(","))
    .update("|")
    .update(input.type)
    .update("|")
    .update(input.direction ?? "")
    .update("|")
    .update(input.roadState ?? "")
    .digest("hex");
}

/** Every vertex of any GeoJSON geometry, flattened — enough to take a bbox. */
function coordsOf(g: GeoJsonGeometry): [number, number][] {
  const out: [number, number][] = [];
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) visit(x);
  };
  visit((g as { coordinates?: unknown }).coordinates);
  return out;
}

function insideAnyRegion(
  b: [number, number, number, number],
  regions: { bbox: [number, number, number, number] }[]
): boolean {
  return regions.some(
    (r) => b[0] <= r.bbox[2] && b[2] >= r.bbox[0] && b[1] <= r.bbox[3] && b[3] >= r.bbox[1]
  );
}

/** A failed/short-circuited binding: no spans, no debug detail, just the why. */
function failure(status: BindResult["status"], reason: string): BindResult {
  return {
    status,
    confidence: null,
    directionMode: "unknown",
    candidateCount: 0,
    alternativeConfidence: null,
    reason,
    segments: [],
    debug: { samples: [], pathScore: null, coverage: null, meanOffsetM: null, ambiguity: null },
  };
}

async function fetchSubgraph(
  sql: Sql,
  bbox: [number, number, number, number]
): Promise<SpineSegment[]> {
  const rows = await sql<
    {
      segment_id: string;
      way_id: number;
      dir: "f" | "b";
      highway: string;
      ref: string | null;
      geojson: string;
      length_m: number;
    }[]
  >`
    SELECT segment_id, way_id::int AS way_id, dir, highway, ref, ST_AsGeoJSON(geom) AS geojson, length_m
    FROM conditions.road_segment
    WHERE geom && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)
    LIMIT ${BIND_DEFAULTS.maxSubgraphSegments + 1}`;
  return rows.map((r) => ({
    segmentId: r.segment_id,
    wayId: Number(r.way_id),
    dir: r.dir,
    highway: r.highway,
    ref: r.ref,
    coords: (JSON.parse(r.geojson) as { coordinates: [number, number][] }).coordinates,
    lengthM: r.length_m,
  }));
}

/**
 * Replaces one event's binding: the summary row and its ordered spans always
 * move together, so a reader never sees the new status with the old path.
 * `direction_mode` is written explicitly on every status (the column defaults
 * to `single`, which would be a lie for anything that did not bind).
 *
 * Both inserts upsert: the boot-time rebind pass and a feed poll can reach the
 * same id at once, and the loser of that race must overwrite rather than raise
 * a duplicate key.
 */
async function writeResult(
  sql: Sql,
  id: string,
  hash: string,
  r: BindResult,
  now: string
): Promise<void> {
  await sql.begin(async (tx) => {
    // One writer per id at a time. Without this, two concurrent replacements
    // each delete the spans they can see and then upsert their own: the one
    // with fewer spans leaves the other's tail rows behind, and a later run
    // skips the id as unchanged, so the stale spans would never be cleaned up.
    await tx`SELECT pg_advisory_xact_lock(hashtext('observation_binding'), hashtext(${id}))`;
    await tx`DELETE FROM conditions.observation_segment WHERE observation_id = ${id}`;
    await tx`
      INSERT INTO conditions.observation_binding
        (observation_id, status, confidence, direction_mode, candidate_count, alternative_confidence, reason, resolver_version, geom_hash, bound_at)
      VALUES (${id}, ${r.status}, ${r.confidence}, ${r.directionMode}, ${r.candidateCount}, ${r.alternativeConfidence}, ${r.reason ?? null}, ${RESOLVER_VERSION}, ${hash}, ${now})
      ON CONFLICT (observation_id) DO UPDATE SET
        status = excluded.status, confidence = excluded.confidence, direction_mode = excluded.direction_mode,
        candidate_count = excluded.candidate_count, alternative_confidence = excluded.alternative_confidence,
        reason = excluded.reason, resolver_version = excluded.resolver_version, geom_hash = excluded.geom_hash, bound_at = excluded.bound_at`;
    if (r.segments.length > 0) {
      const rows = r.segments.map((s, seq) => ({
        observation_id: id,
        seq,
        segment_id: s.segmentId,
        way_id: s.wayId,
        dir: s.dir,
        start_fraction: s.startFraction,
        end_fraction: s.endFraction,
      }));
      await tx`
        INSERT INTO conditions.observation_segment ${tx(rows)}
        ON CONFLICT (observation_id, seq) DO UPDATE SET
          segment_id = excluded.segment_id, way_id = excluded.way_id, dir = excluded.dir,
          start_fraction = excluded.start_fraction, end_fraction = excluded.end_fraction`;
    }
  });
}

/**
 * Drops the bindings of ids that are no longer active road events. A swap can
 * deactivate a row in place (`status` -> `inactive`/`archived`/`cancelled`)
 * instead of deleting it, and the observations FK cascade only fires on a real
 * delete — without this an ended closure would keep its `exact` binding and
 * spans forever. A binding exists only for an active event, so a later flip
 * back to active simply re-binds from scratch.
 */
async function clearInactive(sql: Sql, ids: string[], keep: Set<string>): Promise<number> {
  const stale = ids.filter((id) => !keep.has(id));
  if (stale.length === 0) return 0;
  return sql.begin(async (tx) => {
    // Same per-id lock as writeResult, taken in id order so two clearing
    // passes cannot deadlock; a writer racing this batch then sees either the
    // binding it wrote or none at all, never a header without its spans.
    await tx`
      SELECT pg_advisory_xact_lock(hashtext('observation_binding'), hashtext(id))
      FROM (SELECT unnest(${sql.array(stale)}::text[]) AS id ORDER BY id) AS ids`;
    await tx`DELETE FROM conditions.observation_segment WHERE observation_id = ANY(${sql.array(stale)}::text[])`;
    const removed = await tx<{ observation_id: string }[]>`
      DELETE FROM conditions.observation_binding
      WHERE observation_id = ANY(${sql.array(stale)}::text[])
      RETURNING observation_id`;
    return removed.length;
  });
}

/**
 * Binds the given event observations to the segment spine. Never throws for a
 * single event: a resolver error is recorded as `unresolved`/`resolver_error`.
 * Rows whose resolver inputs and resolver version are unchanged are skipped;
 * ids that are no longer active road events have their binding dropped.
 *
 * `no_coverage` is decided here, not by the resolver: an event outside every
 * imported region has no spine to bind to, which is an operator's region-list
 * choice rather than a failure of the maths.
 */
export async function bindObservations(
  sql: Sql,
  ids: string[],
  deps: { now: () => string; env?: NodeJS.ProcessEnv }
): Promise<BindObservationsResult> {
  const result: BindObservationsResult = {
    attempted: 0,
    bound: 0,
    skippedUnchanged: 0,
    cleared: 0,
    writeErrors: 0,
    byStatus: {},
  };
  const opts = bindOptionsFromEnv(deps.env);
  if (!opts.enabled || ids.length === 0) return result;
  const regions = loadOsmRegions(deps.env ?? process.env);

  const rows = await sql<EventRow[]>`
    SELECT o.id, o.type, ST_AsGeoJSON(o.geom) AS geojson, o.attributes,
           b.geom_hash AS existing_hash, b.resolver_version AS existing_version
    FROM conditions.observations o
    LEFT JOIN conditions.observation_binding b ON b.observation_id = o.id
    WHERE o.id = ANY(${sql.array(ids)}::text[]) AND o.kind = 'event' AND o.domain = 'roads' AND o.status = 'active'`;

  result.cleared = await clearInactive(sql, ids, new Set(rows.map((r) => r.id)));

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const row = rows[cursor++]!;
      const geometry = JSON.parse(row.geojson) as GeoJsonGeometry;
      const attrs = row.attributes ?? {};
      const input = toBindInput({
        id: row.id,
        geometry,
        type: row.type ?? "other",
        roads: (attrs["roads"] as Array<{ ref?: string; name?: string }> | undefined) ?? [],
        direction: attrs["direction"] as string | undefined,
        roadState: attrs["roadState"] as string | undefined,
      });
      const hash = bindInputHash(input);
      if (row.existing_hash === hash && row.existing_version === RESOLVER_VERSION) {
        result.skippedUnchanged++;
        continue;
      }
      result.attempted++;
      let r: BindResult;
      try {
        const coords = coordsOf(geometry);
        const b = bboxOf(coords);
        if (!insideAnyRegion(b, regions)) {
          r = failure("no_coverage", "outside_regions");
        } else {
          // Widen the subgraph beyond the event's own extent so a long event
          // still sees the segments just past its endpoints.
          const diag = Math.hypot(
            (b[2] - b[0]) * 111_320 * Math.cos((b[1] * Math.PI) / 180),
            (b[3] - b[1]) * 111_320
          );
          const segments = await fetchSubgraph(sql, expandBbox(b, Math.max(500, 0.2 * diag)));
          r = bindEvent(input, { segments }, { maxOffsetM: opts.maxOffsetM });
        }
      } catch (err) {
        console.warn(`[bind] ${row.id}: resolver error`, err);
        r = failure("unresolved", "resolver_error");
      }
      try {
        await writeResult(sql, row.id, hash, r, deps.now());
      } catch (err) {
        // One event's write must not take the whole pass down with it: a
        // concurrent binder or a transient database error leaves this id on
        // its old binding, to be redone on the next run.
        console.warn(`[bind] ${row.id}: write error`, err);
        result.writeErrors++;
        continue;
      }
      result.byStatus[r.status] = (result.byStatus[r.status] ?? 0) + 1;
      if (r.segments.length > 0) result.bound++;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, rows.length) }, () => worker())
  );
  return result;
}
