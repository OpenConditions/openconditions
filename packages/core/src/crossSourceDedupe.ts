import type { Geometry } from "geojson";
import type { Attribution, MergedSource, Observation } from "./model.js";
import { bucketKey, clusterIndices, neighborKeys } from "./spatial.js";

/**
 * Cross-source ("aggregator-level") dedup.
 *
 * OpenConditions ingests many feeds, in many formats, into one model. Each
 * parser already dedups WITHIN its own feed before write, and every feed is
 * stored under its own source id (the atomic swap is source-scoped) — so the
 * store can hold the SAME real-world incident once per source (e.g. an A3 jam
 * reported by both the federal Autobahn feed and a regional German feed). As an
 * aggregator we must collapse those at read time so the same condition is not
 * emitted multiple times into any output format.
 *
 * This pass runs over the rows of one read (a bbox query) and merges only across
 * DIFFERENT sources. It is deliberately precision-first ("rather miss a real
 * duplicate than wrongly merge two distinct conditions"):
 *
 *   - only `event` observations are considered (flow `measurement`s are distinct
 *     readings, never merged — they pass through untouched);
 *   - both must be the same `type`;
 *   - they must come from different sources (same-source pairs are the in-parser
 *     dedup's job and must not be re-judged by this looser predicate);
 *   - if both name roads and share NONE, they are on different roads → never
 *     merge (the interchange guard);
 *   - geometries must be close: within {@link MERGE_DISTANCE_M} normally, widened
 *     to {@link ROAD_MATCH_DISTANCE_M} when a shared road ref corroborates the
 *     match (different sources place the same incident at different points along
 *     a road). Distance is the minimum vertex-to-segment distance both ways, so a
 *     Point near a LineString — or two overlapping lines — co-locate.
 *
 * Note it does NOT require similar headlines: different sources phrase the same
 * incident differently (the very Autobahn-vs-regional case this exists for), so
 * a headline gate would defeat it. The road-ref + same-type gates supply the
 * precision instead.
 *
 * The surviving (primary) observation is the richest in the cluster (most
 * geometry detail / populated fields), breaking ties by newest `dataUpdatedAt`.
 * Every other source folds into its {@link Observation.mergedSources} so no
 * attribution is lost.
 *
 * SAFETY: if a cluster mixes feed and crowd origins, the survivor is chosen from
 * the FEED rows only (richest/newest among them), so a feed-corroborated
 * condition keeps `origin.kind === "feed"` and the host routing gate never
 * withholds it. Without this, a co-located crowd report could win the survivor
 * tiebreak and, being crowd-origin + not routing-eligible, be dropped from
 * routing — erasing a real closure. Crowd-only clusters are unaffected.
 */

const MERGE_DISTANCE_M = 75;
const ROAD_MATCH_DISTANCE_M = 250;

const VERTEX_SAMPLE = 24;
const RAW_VERTEX_CAP = 512;
const M_PER_DEG = 111_320;

/** Every [lng,lat] vertex of a geometry, evenly downsampled to {@link VERTEX_SAMPLE}. */
function positions(geometry: Geometry): [number, number][] {
  const raw: [number, number][] = [];
  const walk = (c: unknown): void => {
    if (raw.length >= RAW_VERTEX_CAP || !Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      raw.push([c[0], c[1]]);
      return;
    }
    for (const x of c) {
      if (raw.length >= RAW_VERTEX_CAP) break;
      walk(x);
    }
  };
  const g = geometry as { coordinates?: unknown; geometries?: unknown[] };
  if (Array.isArray(g.geometries)) {
    for (const sub of g.geometries) walk((sub as { coordinates?: unknown }).coordinates);
  } else {
    walk(g.coordinates);
  }
  if (raw.length <= VERTEX_SAMPLE) return raw;
  const stride = raw.length / VERTEX_SAMPLE;
  const out: [number, number][] = [];
  for (let i = 0; i < VERTEX_SAMPLE; i++) out.push(raw[Math.floor(i * stride)]!);
  return out;
}

/** Project [lng,lat] to local equirectangular metres about a reference latitude. */
function toLocal(p: [number, number], cosRefLat: number): [number, number] {
  return [p[0] * M_PER_DEG * cosRefLat, p[1] * M_PER_DEG];
}

function pointToSegmentMeters(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  cosRefLat: number
): number {
  const [px, py] = toLocal(p, cosRefLat);
  const [ax, ay] = toLocal(a, cosRefLat);
  const [bx, by] = toLocal(b, cosRefLat);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointToPolylineMeters(
  p: [number, number],
  verts: [number, number][],
  cosRefLat: number
): number {
  if (verts.length === 1) return pointToSegmentMeters(p, verts[0]!, verts[0]!, cosRefLat);
  let min = Infinity;
  for (let i = 0; i < verts.length - 1; i++) {
    const d = pointToSegmentMeters(p, verts[i]!, verts[i + 1]!, cosRefLat);
    if (d < min) min = d;
  }
  return min;
}

/** Minimum distance between two geometries' vertex sets, measured both ways. */
function geometryDistanceMeters(a: [number, number][], b: [number, number][]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  const cosRefLat = Math.cos((((a[0]![1] + b[0]![1]) / 2) * Math.PI) / 180);
  let min = Infinity;
  for (const p of a) {
    const d = pointToPolylineMeters(p, b, cosRefLat);
    if (d < min) min = d;
  }
  for (const p of b) {
    const d = pointToPolylineMeters(p, a, cosRefLat);
    if (d < min) min = d;
  }
  return min;
}

/** Letter+number road tokens within a string (A3, B51, M25, E45, I-5 → I5, US-101 → US101). */
const ROAD_TOKEN = /\b[A-Z]{1,3}[\s./-]?\d{1,4}[A-Z]?\b/g;

function normToken(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function addRoadTokens(keys: Set<string>, raw: string): void {
  const up = raw.toUpperCase();
  const matches = up.match(ROAD_TOKEN);
  if (matches) {
    for (const m of matches) keys.add(normToken(m));
    return;
  }
  const whole = normToken(raw);
  if (whole) keys.add(whole);
}

/**
 * Normalised road identifiers for an event. `roads` (carried in the model from
 * the `attributes` JSONB) may be `string[]` or `{ ref?, name? }[]`; both are
 * handled. A `ref` is taken verbatim; a `name` is mined for road tokens, falling
 * back to the whole normalised name (so descriptive street names still compare).
 */
function roadKeys(o: Observation): Set<string> {
  const keys = new Set<string>();
  const roads = (o as { roads?: unknown }).roads;
  if (!Array.isArray(roads)) return keys;
  for (const r of roads) {
    if (typeof r === "string") {
      addRoadTokens(keys, r);
    } else if (r && typeof r === "object") {
      const ref = (r as { ref?: unknown }).ref;
      const name = (r as { name?: unknown }).name;
      if (typeof ref === "string" && ref.trim()) keys.add(normToken(ref));
      if (typeof name === "string" && name.trim()) addRoadTokens(keys, name);
    }
  }
  return keys;
}

type RoadRelation = "match" | "conflict" | "unknown";

function roadRelation(a: Set<string>, b: Set<string>): RoadRelation {
  if (a.size === 0 || b.size === 0) return "unknown";
  for (const k of a) if (b.has(k)) return "match";
  return "conflict";
}

function typeOf(o: Observation): string {
  return (o as { type?: string }).type ?? "";
}

/** A heuristic "how useful a representative is this record" score. */
function richness(o: Observation, verts: [number, number][]): number {
  let s = verts.length;
  if (o.geometry.type !== "Point") s += 2;
  const e = o as {
    description?: unknown;
    roads?: unknown[];
    lanesAffected?: unknown;
    restrictions?: unknown[];
    detourGeometry?: unknown;
  };
  if (typeof e.description === "string" && e.description.length > 0) s += 2;
  if (Array.isArray(e.roads)) s += e.roads.length;
  if (e.lanesAffected != null) s += 2;
  if (Array.isArray(e.restrictions)) s += e.restrictions.length;
  if (e.detourGeometry != null) s += 2;
  return s;
}

function attributionOf(o: Observation): Attribution {
  return o.origin?.attribution ?? { provider: o.source, license: "unknown" };
}

export interface CrossSourceDedupeOpts {
  /** Merge radius (metres) when no shared road ref corroborates the match. */
  mergeDistanceM?: number;
  /** Wider merge radius (metres) allowed when a shared road ref corroborates it. */
  roadMatchDistanceM?: number;
}

/**
 * Collapse cross-source duplicate events in a set of observations (see the file
 * header for the full predicate). Measurements and unmatched events are returned
 * unchanged; input order is preserved (each surviving cluster takes the position
 * of its earliest member, so a severity-DESC query stays severity-DESC).
 */
export function dedupeAcrossSources(
  items: Observation[],
  opts?: CrossSourceDedupeOpts
): Observation[] {
  const n = items.length;
  if (n === 0) return [];

  const mergeDistanceM = opts?.mergeDistanceM ?? MERGE_DISTANCE_M;
  const roadMatchDistanceM = opts?.roadMatchDistanceM ?? ROAD_MATCH_DISTANCE_M;
  const candidateRadiusM = Math.max(mergeDistanceM, roadMatchDistanceM);

  const verts = items.map((o) => positions(o.geometry));
  const keys = items.map((o) => (o.kind === "event" ? roadKeys(o) : new Set<string>()));

  // Vertex-level spatial index over EVENTS only (two overlapping lines, whose
  // centroids may sit far apart, must still become candidates). Measurements are
  // never merged, so they are left out of the index entirely — this keeps a
  // dense cluster of co-located flow readings from inflating candidate lists.
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (items[i]!.kind !== "event") continue;
    for (const v of verts[i]!) {
      const key = bucketKey(v);
      const arr = buckets.get(key);
      if (arr) arr.push(i);
      else buckets.set(key, [i]);
    }
  }

  function neighborsOf(i: number): Set<number> {
    const out = new Set<number>();
    if (items[i]!.kind !== "event") return out;
    for (const v of verts[i]!) {
      for (const nKey of neighborKeys(bucketKey(v), v[1], candidateRadiusM)) {
        const cand = buckets.get(nKey);
        if (cand) for (const j of cand) if (j !== i) out.add(j);
      }
    }
    return out;
  }

  function shouldMerge(i: number, j: number): boolean {
    const a = items[i]!;
    const b = items[j]!;
    if (a.kind !== "event" || b.kind !== "event") return false;
    if (a.source === b.source) return false;
    if (typeOf(a) !== typeOf(b)) return false;
    const rel = roadRelation(keys[i]!, keys[j]!);
    if (rel === "conflict") return false;
    const limit = rel === "match" ? roadMatchDistanceM : mergeDistanceM;
    return geometryDistanceMeters(verts[i]!, verts[j]!) <= limit;
  }

  const clusters = clusterIndices(n, neighborsOf, shouldMerge);

  // Emit one observation per cluster, ordered by the cluster's earliest input index.
  const emitted: { order: number; obs: Observation }[] = [];
  for (const idxs of clusters.values()) {
    const order = Math.min(...idxs);
    if (idxs.length === 1) {
      emitted.push({ order, obs: items[idxs[0]!]! });
      continue;
    }
    // Feed-origin survivor safety: if ANY row in the cluster is feed-origin, the
    // survivor MUST be a feed row (pick the richest/newest among the FEED rows;
    // crowd rows fold into mergedSources). A feed-corroborated closure has to
    // keep origin.kind === "feed" so the host routing gate never withholds it —
    // otherwise a single co-located crowd report could win the richness/recency
    // tiebreak, become a crowd survivor, and be dropped from routing, erasing a
    // real closure (an adversary could do this deliberately). Only a cluster
    // with NO feed row lets a crowd row survive. This is a targeted change to
    // mixed crowd+feed clusters; feed+feed and crowd+crowd clusters are unchanged.
    const feedIdxs = idxs.filter((k) => items[k]!.origin?.kind === "feed");
    const candidates = feedIdxs.length > 0 ? feedIdxs : idxs;

    let primary = candidates[0]!;
    let bestRich = richness(items[primary]!, verts[primary]!);
    let bestTime = Date.parse(items[primary]!.dataUpdatedAt);
    for (const k of candidates.slice(1)) {
      const r = richness(items[k]!, verts[k]!);
      const t = Date.parse(items[k]!.dataUpdatedAt);
      if (r > bestRich || (r === bestRich && t > bestTime)) {
        primary = k;
        bestRich = r;
        bestTime = t;
      }
    }
    const merged: MergedSource[] = idxs
      .filter((k) => k !== primary)
      .map((k) => ({
        source: items[k]!.source,
        id: items[k]!.id,
        attribution: attributionOf(items[k]!),
      }));
    emitted.push({ order, obs: { ...items[primary]!, mergedSources: merged } });
  }

  emitted.sort((a, b) => a.order - b.order);
  return emitted.map((e) => e.obs);
}
