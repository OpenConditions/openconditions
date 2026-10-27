import { haversineMeters } from "@openconditions/core";
import type { Geometry } from "geojson";
import type { RoadEvent } from "./model.js";
import { bucketKey, clusterIndices, neighborKeys } from "./spatial-cluster.js";

/** Within this distance, two events of one type from one feed may be one. */
const MERGE_DISTANCE_M = 60;
/** Their texts must overlap this much (Jaccard over word tokens) to be one. */
const LABEL_JACCARD_MIN = 0.5;

function representativePoint(geometry: Geometry): [number, number] {
  if (geometry.type === "Point") {
    const [lng, lat] = geometry.coordinates as [number, number];
    return [lng, lat];
  }
  if (geometry.type === "LineString") {
    const coords = geometry.coordinates as [number, number][];
    const lng = coords.reduce((s, c) => s + c[0]!, 0) / coords.length;
    const lat = coords.reduce((s, c) => s + c[1]!, 0) / coords.length;
    return [lng, lat];
  }
  if (geometry.type === "Polygon") {
    const ring = (geometry.coordinates[0] as [number, number][]).slice(0, -1);
    const n = ring.length;
    const lng = ring.reduce((s, c) => s + c[0]!, 0) / n;
    const lat = ring.reduce((s, c) => s + c[1]!, 0) / n;
    return [lng, lat];
  }
  if (geometry.type === "MultiPoint") {
    const coords = geometry.coordinates as [number, number][];
    const lng = coords.reduce((s, c) => s + c[0]!, 0) / coords.length;
    const lat = coords.reduce((s, c) => s + c[1]!, 0) / coords.length;
    return [lng, lat];
  }
  if (geometry.type === "MultiLineString") {
    const all = (geometry.coordinates as [number, number][][]).flat();
    const lng = all.reduce((s, c) => s + c[0]!, 0) / all.length;
    const lat = all.reduce((s, c) => s + c[1]!, 0) / all.length;
    return [lng, lat];
  }
  if (geometry.type === "MultiPolygon") {
    const all = (geometry.coordinates as [number, number][][][]).flatMap((poly) =>
      (poly[0] ?? []).slice(0, -1),
    );
    const lng = all.reduce((s, c) => s + c[0]!, 0) / all.length;
    const lat = all.reduce((s, c) => s + c[1]!, 0) / all.length;
    return [lng, lat];
  }
  if (geometry.type === "GeometryCollection") {
    if (geometry.geometries.length > 0) {
      return representativePoint(geometry.geometries[0]!);
    }
  }
  return [0, 0];
}

function tokenize(label: string): Set<string> {
  return new Set((label.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2));
}

function jaccardOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  const union = ta.size + tb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Road events carry their text in `headline`; comparing it keeps two
 * unrelated same-type works at one coordinate apart. A missing text is a pass.
 */
function textsCompatible(a: RoadEvent, b: RoadEvent): boolean {
  const la = (a.headline ?? a.label)?.trim();
  const lb = (b.headline ?? b.label)?.trim();
  if (!la || !lb) return true;
  return jaccardOverlap(la, lb) >= LABEL_JACCARD_MIN;
}

const norm = (s: string | undefined) => s?.trim().toLowerCase() || undefined;

/** A description as text to compare, whatever its spacing and case. */
const descriptionKey = (s: string | undefined) => norm(s?.replace(/\s+/g, " "));

/** The direction an event states, on itself or, failing that, on its roads. */
function directionOf(e: RoadEvent): string | undefined {
  const own = norm(e.direction);
  if (own !== undefined) return own;
  const onRoads = [...new Set(e.roads.map((r) => norm(r.direction)).filter((d) => d))];
  return onRoads.length > 0 ? onRoads.sort().join("|") : undefined;
}

/** An instant as epoch milliseconds when it parses, else as its text. */
const instantKey = (s: string | null | undefined) => {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? String(ms) : s;
};

/** The road names and numbers an event names, normalised. */
const roadKeys = (e: RoadEvent) =>
  new Set(
    e.roads
      .flatMap((r) => [r.name, r.ref])
      .map((s) => s?.replace(/\s+/g, "").toUpperCase())
      .filter((s): s is string => !!s),
  );

const json = (v: unknown) => JSON.stringify(v);

/**
 * Whether two events say different things about the road, so are two events
 * even at one place with one text: opposite directions of a carriageway, two
 * occurrences of a recurring closure, different lanes, vehicles, limits or
 * roads, or descriptions that say different things. A fact only one of them
 * states is no difference: the other may simply be the sparser copy.
 *
 * Descriptions must match, not merely resemble: an on-ramp and an off-ramp
 * closure of one junction differ by a word, while a copy's text can differ
 * wholesale, so no similarity measure separates them. A follow-up that
 * rewrites its incident's text therefore stays apart from it too, unless the
 * feed marks its follow-ups ({@link dropSupersededRoadEvents}): a second
 * marker costs less than a dropped closure.
 */
function distinct(a: RoadEvent, b: RoadEvent): boolean {
  const differ = <T>(x: T | undefined, y: T | undefined) =>
    x !== undefined && y !== undefined && x !== y;
  if (differ(descriptionKey(a.description), descriptionKey(b.description))) return true;
  if (differ(directionOf(a), directionOf(b))) return true;
  if (differ(instantKey(a.validFrom), instantKey(b.validFrom))) return true;
  if (differ(instantKey(a.validTo), instantKey(b.validTo))) return true;
  if (a.schedule?.length && b.schedule?.length && differ(json(a.schedule), json(b.schedule)))
    return true;
  if ((a.isForecast === true) !== (b.isForecast === true)) return true;
  if (differ(a.subtype, b.subtype)) return true;
  if (differ(a.roadState, b.roadState)) return true;
  if (differ(a.speedLimitKph, b.speedLimitKph)) return true;
  if (differ(a.lanesAffected && json(a.lanesAffected), b.lanesAffected && json(b.lanesAffected)))
    return true;
  const vehicles = (e: RoadEvent) =>
    e.vehiclesAffected?.length ? json([...e.vehiclesAffected].sort()) : undefined;
  if (differ(vehicles(a), vehicles(b))) return true;
  if (differ(a.restrictions && json(a.restrictions), b.restrictions && json(b.restrictions)))
    return true;
  if (
    differ(
      a.restrictionDetails && json(a.restrictionDetails.facts),
      b.restrictionDetails && json(b.restrictionDetails.facts),
    )
  )
    return true;
  const ra = roadKeys(a);
  const rb = roadKeys(b);
  return ra.size > 0 && rb.size > 0 && ![...ra].some((r) => rb.has(r));
}

/** The event updated last; of events updated at once, the one with the lowest id, whatever their order. */
function newestByDataUpdatedAt(cluster: RoadEvent[]): RoadEvent {
  let best = cluster[0]!;
  let bestTime = Date.parse(best.dataUpdatedAt);
  for (let i = 1; i < cluster.length; i++) {
    const t = Date.parse(cluster[i]!.dataUpdatedAt);
    if (t > bestTime || (t === bestTime && cluster[i]!.id < best.id)) {
      best = cluster[i]!;
      bestTime = t;
    }
  }
  return best;
}

/** When an event was last updated, as epoch milliseconds, or NaN when it does not say. */
const updatedMs = (e: RoadEvent) => Date.parse(e.situation?.sourceUpdatedAt ?? e.dataUpdatedAt);

/**
 * Drops the events a feed's follow-ups replace. Some publishers write an
 * incident's progress ("the car was moved") as a new record beside the
 * original rather than revising it, so its text differs and the fold keeps
 * both. A follow-up replaces every event of its type (and the source's own
 * type, where both state one) within the fold distance that was updated
 * before it, earlier follow-ups included, so only the latest word on an
 * incident stays; an original updated at the same instant is replaced too,
 * a follow-up is not. An event that does not say when it was updated is
 * never replaced, nor replaces one.
 */
export function dropSupersededRoadEvents(
  events: RoadEvent[],
  isFollowUp: (event: RoadEvent) => boolean,
): RoadEvent[] {
  const followUps = events.filter(isFollowUp);
  if (followUps.length === 0) return events;
  const replaced = (e: RoadEvent) => {
    const at = updatedMs(e);
    if (!Number.isFinite(at)) return false;
    const pt = representativePoint(e.geometry);
    const ownFollowUp = isFollowUp(e);
    return followUps.some((f) => {
      if (f === e || f.type !== e.type) return false;
      // A feed's own types are finer than the coarse type many of them map to.
      if (f.subtype !== undefined && e.subtype !== undefined && f.subtype !== e.subtype) {
        return false;
      }
      const fAt = updatedMs(f);
      if (!Number.isFinite(fAt) || fAt < at || (fAt === at && ownFollowUp)) return false;
      return haversineMeters(representativePoint(f.geometry), pt) <= MERGE_DISTANCE_M;
    });
  };
  return events.filter((e) => !replaced(e));
}

/**
 * Folds the duplicates one feed publishes for one event: same type, within
 * 60 m, with compatible text, and nothing either states that the other
 * contradicts (see {@link distinct}). Clusters merge only when every pair
 * across them qualifies, so a chain of neighbours never collapses into one;
 * the event updated last survives, the same one whichever order the feed
 * lists them in.
 */
export function dedupeRoadEvents(events: RoadEvent[]): RoadEvent[] {
  const n = events.length;
  if (n === 0) return [];

  const pts = events.map((event) => representativePoint(event.geometry));

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = bucketKey(pts[i]!);
    const arr = buckets.get(key);
    if (arr) arr.push(i);
    else buckets.set(key, [i]);
  }

  function shouldMerge(i: number, j: number): boolean {
    if (events[i]!.type !== events[j]!.type) return false;
    if (haversineMeters(pts[i]!, pts[j]!) > MERGE_DISTANCE_M) return false;
    return textsCompatible(events[i]!, events[j]!) && !distinct(events[i]!, events[j]!);
  }

  function neighborsOf(i: number): number[] {
    const lat = pts[i]![1]!;
    const out: number[] = [];
    for (const nKey of neighborKeys(bucketKey(pts[i]!), lat, MERGE_DISTANCE_M)) {
      const candidates = buckets.get(nKey);
      if (candidates) out.push(...candidates);
    }
    return out;
  }

  const clusters = clusterIndices(n, neighborsOf, shouldMerge);
  const out: RoadEvent[] = [];
  for (const idxs of clusters.values()) {
    out.push(
      idxs.length === 1 ? events[idxs[0]!]! : newestByDataUpdatedAt(idxs.map((k) => events[k]!)),
    );
  }
  return out;
}
