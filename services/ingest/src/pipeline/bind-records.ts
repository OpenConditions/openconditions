import { createHash } from "node:crypto";
import type { GeoJsonGeometry } from "@openconditions/core";
import {
  BIND_DEFAULTS,
  type BindInput,
  type BindResult,
  bboxOf,
  bindEvent,
  expandBbox,
  RESOLVER_VERSION,
  type SpineSegment,
  toBindInput,
} from "@openconditions/roads";
import type postgres from "postgres";
import { loadOsmRegions } from "./osm-import.js";

type Sql = postgres.Sql;

export interface BindRecordsResult {
  attempted: number;
  bound: number;
  skippedUnchanged: number;
  /** Bindings dropped because their record or effect is no longer live. */
  cleared: number;
  /** Bindings whose resolved result could not be persisted; counted, not thrown. */
  writeErrors: number;
  byStatus: Record<string, number>;
}

/** Default parallelism for resolving a poll's changed records. */
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

/** Every vertex of any GeoJSON geometry, flattened — enough to take a bbox. */
export function coordsOf(g: GeoJsonGeometry): [number, number][] {
  const out: [number, number][] = [];
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) visit(x);
  };
  if (g.type === "GeometryCollection") for (const part of g.geometries) out.push(...coordsOf(part));
  else visit((g as { coordinates?: unknown }).coordinates);
  return out;
}

export function insideAnyRegion(
  b: [number, number, number, number],
  regions: { bbox: [number, number, number, number] }[],
): boolean {
  return regions.some(
    (r) => b[0] <= r.bbox[2] && b[2] >= r.bbox[0] && b[1] <= r.bbox[3] && b[3] >= r.bbox[1],
  );
}

/** A failed/short-circuited binding: no spans, no debug detail, just the why. */
export function failure(status: BindResult["status"], reason: string): BindResult {
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

export async function fetchSubgraph(
  sql: Sql,
  bbox: [number, number, number, number],
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

/** Resolves one input against the spine around it; `no_coverage` outside every imported region. */
export async function resolveBinding(
  sql: Sql,
  input: BindInput,
  regions: { bbox: [number, number, number, number] }[],
  maxOffsetM: number,
): Promise<BindResult> {
  const b = bboxOf(coordsOf(input.geometry as GeoJsonGeometry));
  if (!insideAnyRegion(b, regions)) return failure("no_coverage", "outside_regions");
  // Widen the subgraph beyond the input's own extent so a long one still sees
  // the segments just past its endpoints.
  const diag = Math.hypot(
    (b[2] - b[0]) * 111_320 * Math.cos((b[1] * Math.PI) / 180),
    (b[3] - b[1]) * 111_320,
  );
  const segments = await fetchSubgraph(sql, expandBbox(b, Math.max(500, 0.2 * diag)));
  return bindEvent(input, { segments }, { maxOffsetM });
}

type Rec = Record<string, unknown>;

/** One location of a situation the resolver places: its own (`effectId` '') or an effect's. */
interface Target {
  recordId: string;
  effectId: string;
  revision: number;
  input: BindInput;
  hash: string;
}

interface SituationRow {
  id: string;
  kind: string;
  revision: number;
  geojson: string | null;
  location: Rec | null;
  effect_kinds: string[];
  overrides: { effectId: string; geojson: GeoJsonGeometry }[];
}

interface ExistingRow {
  record_id: string;
  effect_id: string;
  geom_hash: string;
  resolver_version: string;
  status: string;
  record_revision: number;
  graph_generation: string | null;
}

/** The road refs and names a location gives, for the resolver's ref match. */
function roadsOf(location: Rec | null): { ref?: string; name?: string }[] {
  const roads = (location?.["roads"] as Rec[] | undefined) ?? [];
  return roads.map((r) => ({
    ...(typeof r["ref"] === "string" ? { ref: r["ref"] } : {}),
    ...(Array.isArray(r["name"]) && typeof (r["name"][0] as Rec | undefined)?.["text"] === "string"
      ? { name: (r["name"][0] as Rec)["text"] as string }
      : {}),
  }));
}

/** The location's direction as the resolver reads it: the axis value, else the source's text. */
function directionOf(location: Rec | null): string | undefined {
  const d = location?.["direction"] as Rec | undefined;
  if (d === undefined) return undefined;
  return d["value"] === "positive" || d["value"] === "negative"
    ? (d["value"] as string)
    : ((d["text"] as string | undefined) ?? (d["value"] as string));
}

/**
 * Identity of a binding's inputs: everything the resolver reads, plus the
 * kinds of the situation's effects (what the location means for traffic).
 * Unchanged hash and resolver version mean the stored binding still answers,
 * so the target is skipped on rebind.
 */
function inputHash(input: BindInput, effectKinds: readonly string[]): string {
  return createHash("md5")
    .update(JSON.stringify(input.geometry))
    .update("|")
    .update(input.refs.join(","))
    .update("|")
    .update(input.type)
    .update("|")
    .update(input.direction ?? "")
    .update("|")
    .update([...effectKinds].sort().join(","))
    .digest("hex");
}

/** A situation's binding targets: its own location, then each effect that names its own geometry. */
function targetsOf(row: SituationRow): Target[] {
  const roads = roadsOf(row.location);
  const direction = directionOf(row.location);
  const target = (effectId: string, geometry: GeoJsonGeometry): Target => {
    const input = toBindInput({
      id: effectId === "" ? row.id : `${row.id}#${effectId}`,
      geometry,
      type: row.kind,
      roads,
      ...(direction !== undefined ? { direction } : {}),
    });
    return {
      recordId: row.id,
      effectId,
      revision: row.revision,
      input,
      hash: inputHash(input, row.effect_kinds),
    };
  };
  const own = row.geojson === null ? [] : [target("", JSON.parse(row.geojson) as GeoJsonGeometry)];
  return [...own, ...row.overrides.map((o) => target(o.effectId, o.geojson))];
}

const key = (recordId: string, effectId: string) => `${recordId}\u0000${effectId}`;

/**
 * Replaces one target's binding: the summary row and its ordered spans always
 * move together, so a reader never sees the new status with the old path.
 * Written only while the situation is still live at the revision the result
 * was computed from, and the graph still the generation it was computed on.
 */
async function writeResult(
  sql: Sql,
  t: Target,
  r: BindResult,
  now: string,
  graphGeneration: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    // One writer per record at a time: two concurrent replacements would each
    // delete the spans they can see and leave the other's tail rows behind.
    await tx`SELECT pg_advisory_xact_lock(hashtext('record_binding'), hashtext(${t.recordId}))`;
    const [current] = await tx<{ revision: number }[]>`
      SELECT revision FROM conditions.situation
       WHERE id = ${t.recordId} AND tombstoned_at IS NULL FOR UPDATE`;
    if (!current || current.revision !== t.revision) return false;
    const [graph] = await tx<{ generation: string; status: string }[]>`
      SELECT generation, status FROM conditions.road_graph_state WHERE singleton`;
    if (graph?.generation !== graphGeneration || graph.status !== "ready") return false;
    await tx`
      DELETE FROM conditions.record_segment
       WHERE record_class = 'situation' AND record_id = ${t.recordId} AND effect_id = ${t.effectId}`;
    await tx`
      INSERT INTO conditions.record_binding
        (record_class, record_id, effect_id, status, confidence, direction_mode, candidate_count,
         alternative_confidence, reason, resolver_version, geom_hash, record_revision,
         graph_generation, bound_at)
      VALUES ('situation', ${t.recordId}, ${t.effectId}, ${r.status}, ${r.confidence},
              ${r.directionMode}, ${r.candidateCount}, ${r.alternativeConfidence},
              ${r.reason ?? null}, ${RESOLVER_VERSION}, ${t.hash}, ${t.revision},
              ${graphGeneration}, ${now})
      ON CONFLICT (record_class, record_id, effect_id) DO UPDATE SET
        status = excluded.status, confidence = excluded.confidence,
        direction_mode = excluded.direction_mode, candidate_count = excluded.candidate_count,
        alternative_confidence = excluded.alternative_confidence, reason = excluded.reason,
        resolver_version = excluded.resolver_version, geom_hash = excluded.geom_hash,
        record_revision = excluded.record_revision, graph_generation = excluded.graph_generation,
        bound_at = excluded.bound_at`;
    if (r.segments.length > 0) {
      const rows = r.segments.map((s, seq) => ({
        record_class: "situation",
        record_id: t.recordId,
        effect_id: t.effectId,
        seq,
        segment_id: s.segmentId,
        way_id: s.wayId,
        dir: s.dir,
        start_fraction: s.startFraction,
        end_fraction: s.endFraction,
      }));
      await tx`INSERT INTO conditions.record_segment ${tx(rows)}`;
    }
    return true;
  });
}

/**
 * Drops bindings that no longer have a live target: the situation was
 * tombstoned or purged, or the effect that named its own location is gone.
 * A binding exists only for a live target, so a target that comes back binds
 * from scratch.
 */
async function clearStale(
  sql: Sql,
  existing: readonly ExistingRow[],
  live: ReadonlySet<string>,
): Promise<number> {
  const stale = existing.filter((e) => !live.has(key(e.record_id, e.effect_id)));
  if (stale.length === 0) return 0;
  const ids = [...new Set(stale.map((s) => s.record_id))].sort();
  return sql.begin(async (tx) => {
    // Same per-record lock as writeResult, taken in id order so two clearing
    // passes cannot deadlock.
    await tx`
      SELECT pg_advisory_xact_lock(hashtext('record_binding'), hashtext(id))
        FROM unnest(${ids}::text[]) AS id ORDER BY id`;
    let removed = 0;
    for (const s of stale) {
      await tx`
        DELETE FROM conditions.record_segment
         WHERE record_class = 'situation' AND record_id = ${s.record_id}
           AND effect_id = ${s.effect_id}`;
      const gone = await tx`
        DELETE FROM conditions.record_binding
         WHERE record_class = 'situation' AND record_id = ${s.record_id}
           AND effect_id = ${s.effect_id}
        RETURNING record_id`;
      removed += gone.length;
    }
    return removed;
  });
}

/**
 * Binds the given road situations to the segment spine: each one's own
 * location, and each effect that names a location of its own. Never throws
 * for a single target: a resolver error is recorded as `unresolved` /
 * `resolver_error`. Targets whose inputs, resolver version, record revision
 * and graph generation are unchanged are skipped; bindings of situations that
 * are no longer live are dropped.
 */
export async function bindRecords(
  sql: Sql,
  ids: readonly string[],
  deps: { now: () => string; env?: NodeJS.ProcessEnv },
): Promise<BindRecordsResult> {
  const result: BindRecordsResult = {
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
  const [graph] = await sql<{ generation: string; status: string }[]>`
    SELECT generation, status FROM conditions.road_graph_state WHERE singleton`;
  if (!graph || graph.status !== "ready") return result;
  const graphGeneration = graph.generation;

  const rows = await sql<SituationRow[]>`
    SELECT s.id, s.kind, s.revision, ST_AsGeoJSON(s.geom) AS geojson,
           s.record -> 'location' AS location,
           COALESCE((SELECT jsonb_agg(e.kind) FROM conditions.situation_effect e
                      WHERE e.situation_id = s.id), '[]'::jsonb) AS effect_kinds,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'effectId', e.effect_id, 'geojson', ST_AsGeoJSON(e.geom)::jsonb)
                            ORDER BY e.effect_id)
                       FROM conditions.situation_effect e
                      WHERE e.situation_id = s.id AND e.geom IS NOT NULL
                        AND jsonb_typeof(e.value #> '{location,geometry}') = 'object'),
                    '[]'::jsonb) AS overrides
      FROM conditions.situation s
     WHERE s.id = ANY(${ids as string[]}::text[]) AND s.tombstoned_at IS NULL
       AND s.domain = 'roads'`;
  const existing = await sql<ExistingRow[]>`
    SELECT record_id, effect_id, geom_hash, resolver_version, status, record_revision,
           graph_generation
      FROM conditions.record_binding
     WHERE record_class = 'situation' AND record_id = ANY(${ids as string[]}::text[])`;
  const targets = rows.flatMap(targetsOf);
  result.cleared = await clearStale(
    sql,
    existing,
    new Set(targets.map((t) => key(t.recordId, t.effectId))),
  );
  const current = new Map(existing.map((e) => [key(e.record_id, e.effect_id), e]));

  // Records whose work must stay queued: a resolver error retries with backoff,
  // a failed write is simply redone by the next pass.
  const retry = new Set<string>();
  const unfinished = new Set<string>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const t = targets[cursor++]!;
      const before = current.get(key(t.recordId, t.effectId));
      if (
        before?.geom_hash === t.hash &&
        before.resolver_version === RESOLVER_VERSION &&
        before.status !== "obsolete" &&
        before.record_revision === t.revision &&
        before.graph_generation === graphGeneration
      ) {
        result.skippedUnchanged++;
        continue;
      }
      result.attempted++;
      let r: BindResult;
      try {
        r = await resolveBinding(sql, t.input, regions, opts.maxOffsetM);
      } catch (err) {
        console.warn(`[bind] ${t.input.id}: resolver error`, err);
        r = failure("unresolved", "resolver_error");
      }
      if (r.reason === "resolver_error") retry.add(t.recordId);
      try {
        if (!(await writeResult(sql, t, r, deps.now(), graphGeneration))) {
          result.writeErrors++;
          unfinished.add(t.recordId);
          continue;
        }
      } catch (err) {
        // One target's write must not take the whole pass down with it: a
        // concurrent binder or a transient database error leaves it on its old
        // binding, to be redone on the next run.
        console.warn(`[bind] ${t.input.id}: write error`, err);
        result.writeErrors++;
        unfinished.add(t.recordId);
        continue;
      }
      result.byStatus[r.status] = (result.byStatus[r.status] ?? 0) + 1;
      if (r.segments.length > 0) result.bound++;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, targets.length) }, () => worker()),
  );
  await settleQueue(sql, ids, retry, unfinished);
  return result;
}

/**
 * Settles the queued work of a pass: a record with a resolver error stays
 * queued with backoff; every other record's work is acknowledged up to the
 * revision now stored, so work queued for a newer revision meanwhile stays.
 * A record whose write failed stays as it is, to be redone. The rows are
 * locked in key order, as every writer of the queue locks them: a pass and a
 * poll settling overlapping records never wait on each other in a cycle.
 */
export async function settleQueue(
  sql: Sql,
  ids: readonly string[],
  retry: ReadonlySet<string>,
  unfinished: ReadonlySet<string>,
): Promise<void> {
  const done = ids.filter((id) => !retry.has(id) && !unfinished.has(id));
  if (done.length > 0) {
    await sql`
      DELETE FROM conditions.binding_queue q
       USING (SELECT k.record_class, k.record_id, k.effect_id
                FROM conditions.binding_queue k
               WHERE k.record_class = 'situation' AND k.record_id = ANY(${done as string[]}::text[])
                 AND k.record_revision <= COALESCE(
                   (SELECT s.revision FROM conditions.situation s WHERE s.id = k.record_id),
                   k.record_revision)
               ORDER BY k.record_id, k.effect_id
                 FOR UPDATE) acknowledged
       WHERE (q.record_class, q.record_id, q.effect_id)
           = (acknowledged.record_class, acknowledged.record_id, acknowledged.effect_id)`;
  }
  if (retry.size > 0) {
    await sql`
      UPDATE conditions.binding_queue q
         SET attempts = q.attempts + 1, last_error = 'resolver_error', updated_at = now(),
             next_attempt_at = now() + make_interval(secs => LEAST(3600,
               30 * power(2, LEAST(q.attempts, 7))::int))
        FROM (SELECT k.record_class, k.record_id, k.effect_id
                FROM conditions.binding_queue k
               WHERE k.record_class = 'situation' AND k.record_id = ANY(${[...retry]}::text[])
               ORDER BY k.record_id, k.effect_id
                 FOR UPDATE) failed
       WHERE (q.record_class, q.record_id, q.effect_id)
           = (failed.record_class, failed.record_id, failed.effect_id)`;
  }
}

/** Binds the situations whose queued work is due; failures stay queued with bounded backoff. */
export async function drainBindingQueue(
  sql: Sql,
  deps: { now: () => string; env?: NodeJS.ProcessEnv; limit?: number },
): Promise<BindRecordsResult> {
  // With binding off the queued work waits for it to be turned on again,
  // rather than being re-read on every drain.
  if (!bindOptionsFromEnv(deps.env).enabled) return bindRecords(sql, [], deps);
  const limit = Math.max(1, Math.min(deps.limit ?? 500, 2_000));
  const rows = await sql<{ record_id: string }[]>`
    SELECT record_id FROM conditions.binding_queue
     WHERE record_class = 'situation' AND next_attempt_at <= now()
     GROUP BY record_id
     ORDER BY min(next_attempt_at), record_id
     LIMIT ${limit}`;
  return bindRecords(
    sql,
    rows.map((row) => row.record_id),
    deps,
  );
}
