import type { Geometry } from "geojson";
import type { Observation } from "./model.js";
import { bucketKey, clusterIndices, haversineMeters, neighborKeys } from "./spatial.js";

const MERGE_DISTANCE_M_DEFAULT = 60;
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
      (poly[0] ?? []).slice(0, -1)
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

function labelsCompatible(a: Observation, b: Observation): boolean {
  const la = a.label?.trim();
  const lb = b.label?.trim();
  if (!la || !lb) return true;
  return jaccardOverlap(la, lb) >= LABEL_JACCARD_MIN;
}

function newestByDataUpdatedAt(cluster: Observation[]): Observation {
  let best = cluster[0]!;
  let bestTime = Date.parse(best.dataUpdatedAt);
  for (let i = 1; i < cluster.length; i++) {
    const t = Date.parse(cluster[i]!.dataUpdatedAt);
    if (t > bestTime) {
      best = cluster[i]!;
      bestTime = t;
    }
  }
  return best;
}

export function dedupeObservations(
  items: Observation[],
  opts?: {
    mergeDistanceM?: number;
    sameType?: (a: Observation, b: Observation) => boolean;
  }
): Observation[] {
  const n = items.length;
  if (n === 0) return [];

  const mergeDistanceM = opts?.mergeDistanceM ?? MERGE_DISTANCE_M_DEFAULT;
  const sameType = opts?.sameType ?? (() => true);

  const pts = items.map((item) => representativePoint(item.geometry));

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = bucketKey(pts[i]!);
    const arr = buckets.get(key);
    if (arr) arr.push(i);
    else buckets.set(key, [i]);
  }

  function shouldMerge(i: number, j: number): boolean {
    if (!sameType(items[i]!, items[j]!)) return false;
    const d = haversineMeters(pts[i]!, pts[j]!);
    if (d > mergeDistanceM) return false;
    if (!labelsCompatible(items[i]!, items[j]!)) return false;
    return true;
  }

  function neighborsOf(i: number): number[] {
    const lat = pts[i]![1]!;
    const out: number[] = [];
    for (const nKey of neighborKeys(bucketKey(pts[i]!), lat, mergeDistanceM)) {
      const candidates = buckets.get(nKey);
      if (candidates) out.push(...candidates);
    }
    return out;
  }

  const clusters = clusterIndices(n, neighborsOf, shouldMerge);

  const out: Observation[] = [];
  for (const idxs of clusters.values()) {
    out.push(
      idxs.length === 1 ? items[idxs[0]!]! : newestByDataUpdatedAt(idxs.map((k) => items[k]!))
    );
  }
  return out;
}
