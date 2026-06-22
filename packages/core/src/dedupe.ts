import type { Geometry } from "geojson";
import type { Observation } from "./model.js";

const MERGE_DISTANCE_M_DEFAULT = 60;
const LABEL_JACCARD_MIN = 0.5;

const BUCKET_DEG = 0.002;
const METERS_PER_DEG_LAT = 111_320;
const MIN_LAT_COS = 0.01;

function haversineMeters(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

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
    const all = (geometry.coordinates as [number, number][][][]).flatMap(
      (poly) => (poly[0] ?? []).slice(0, -1),
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

function bucketKey(pt: [number, number]): string {
  const bx = Math.floor(pt[0] / BUCKET_DEG);
  const by = Math.floor(pt[1] / BUCKET_DEG);
  return `${bx},${by}`;
}

function lngNeighborRange(lat: number, mergeDistanceM: number): number {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), MIN_LAT_COS);
  const maxLngDiffDeg = mergeDistanceM / (METERS_PER_DEG_LAT * cosLat);
  return Math.ceil(maxLngDiffDeg / BUCKET_DEG) + 1;
}

function neighborKeys(key: string, lat: number, mergeDistanceM: number): string[] {
  const [bx, by] = key.split(",").map(Number);
  const lngRange = lngNeighborRange(lat, mergeDistanceM);
  const out: string[] = [];
  for (let dx = -lngRange; dx <= lngRange; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      out.push(`${bx! + dx},${by! + dy}`);
    }
  }
  return out;
}

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]!);
    return this.parent[x]!;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra]! < this.rank[rb]!) this.parent[ra] = rb;
    else if (this.rank[ra]! > this.rank[rb]!) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]!++;
    }
  }
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
  },
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

  const uf = new UnionFind(n);
  const clusterMembers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) clusterMembers.set(i, [i]);

  function shouldMerge(i: number, j: number): boolean {
    if (!sameType(items[i]!, items[j]!)) return false;
    const d = haversineMeters(pts[i]!, pts[j]!);
    if (d > mergeDistanceM) return false;
    if (!labelsCompatible(items[i]!, items[j]!)) return false;
    return true;
  }

  for (let i = 0; i < n; i++) {
    const lat = pts[i]![1]!;
    const selfKey = bucketKey(pts[i]!);
    for (const nKey of neighborKeys(selfKey, lat, mergeDistanceM)) {
      const candidates = buckets.get(nKey);
      if (!candidates) continue;
      for (const j of candidates) {
        if (j <= i) continue;
        if (!shouldMerge(i, j)) continue;
        const ri = uf.find(i);
        const rj = uf.find(j);
        if (ri === rj) continue;
        const ma = clusterMembers.get(ri)!;
        const mb = clusterMembers.get(rj)!;
        let ok = true;
        outer: for (const a of ma) {
          for (const b of mb) {
            if (!shouldMerge(a, b)) {
              ok = false;
              break outer;
            }
          }
        }
        if (!ok) continue;
        uf.union(i, j);
        const newRoot = uf.find(i);
        const merged = [...ma, ...mb];
        if (newRoot !== ri) clusterMembers.delete(ri);
        if (newRoot !== rj) clusterMembers.delete(rj);
        clusterMembers.set(newRoot, merged);
      }
    }
  }

  const clusters = new Map<number, Observation[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const existing = clusters.get(root);
    if (existing) existing.push(items[i]!);
    else clusters.set(root, [items[i]!]);
  }

  const out: Observation[] = [];
  for (const cluster of clusters.values()) {
    out.push(cluster.length === 1 ? cluster[0]! : newestByDataUpdatedAt(cluster));
  }
  return out;
}
