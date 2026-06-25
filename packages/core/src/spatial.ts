/**
 * Shared spatial primitives for the dedup passes: great-circle distance, a
 * lat-aware bucket grid for candidate generation, a union-find, and the
 * cluster-merge driver with an all-pairs guard. Both the same-source
 * (`dedupeObservations`) and cross-source (`dedupeAcrossSources`) dedup build on
 * these so the clustering semantics stay identical.
 */

export const BUCKET_DEG = 0.002;
export const METERS_PER_DEG_LAT = 111_320;
const MIN_LAT_COS = 0.01;

export function haversineMeters(a: [number, number], b: [number, number]): number {
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

export function bucketKey(pt: [number, number]): string {
  const bx = Math.floor(pt[0] / BUCKET_DEG);
  const by = Math.floor(pt[1] / BUCKET_DEG);
  return `${bx},${by}`;
}

function lngNeighborRange(lat: number, mergeDistanceM: number): number {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), MIN_LAT_COS);
  const maxLngDiffDeg = mergeDistanceM / (METERS_PER_DEG_LAT * cosLat);
  return Math.ceil(maxLngDiffDeg / BUCKET_DEG) + 1;
}

/**
 * Bucket keys within `mergeDistanceM` of `key` (at the given latitude). The
 * latitude widens the longitude span so the grid neighbourhood always covers the
 * merge radius even near the poles.
 */
export function neighborKeys(key: string, lat: number, mergeDistanceM: number): string[] {
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

export class UnionFind {
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

/**
 * Single-linkage clustering with an all-pairs guard. Two clusters merge only when
 * EVERY cross pair between them satisfies `shouldMerge`, so a transitive A–B–C
 * chain whose ends don't themselves match (or whose ends must stay apart) never
 * collapses into one cluster.
 *
 * @param n           number of items (indices 0..n-1)
 * @param neighborsOf candidate partner indices for item i (cheap blocking; may
 *                    include i itself or j<=i, which are skipped)
 * @param shouldMerge symmetric predicate deciding whether two items may merge
 * @returns map of cluster-root index → member indices
 */
export function clusterIndices(
  n: number,
  neighborsOf: (i: number) => Iterable<number>,
  shouldMerge: (i: number, j: number) => boolean
): Map<number, number[]> {
  const uf = new UnionFind(n);
  const clusterMembers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) clusterMembers.set(i, [i]);

  for (let i = 0; i < n; i++) {
    for (const j of neighborsOf(i)) {
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

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const existing = clusters.get(root);
    if (existing) existing.push(i);
    else clusters.set(root, [i]);
  }
  return clusters;
}
