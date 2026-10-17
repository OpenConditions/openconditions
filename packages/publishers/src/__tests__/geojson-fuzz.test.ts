import { Geometry as ModelGeometry } from "@openconditions/model";
import type { Feature, Geometry, Position } from "geojson";
import { describe, expect, it } from "vitest";
import { featuresToGeoJSON } from "../feature-geojson.js";
import { segmentsToGeoJSON } from "../segments.js";
import { situationsToGeoJSON } from "../situation-geojson.js";
import { rfc7946Violations, signedArea } from "./rfc7946-checks.js";

/**
 * Random geometries of every type the model holds, many of them near a pole
 * or across the antimeridian, through the GeoJSON emitters. The generator is
 * seeded (mulberry32), so a failure reproduces from the seed it names.
 */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (lon: number) => (lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon);
const clampLat = (lat: number) => Math.max(-90, Math.min(90, lat));

function generator(rand: () => number) {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const centre = (): [number, number] => {
    const lon = pick([
      () => between(-180, 180),
      () => between(175, 180),
      () => between(-180, -175),
      () => pick([180, -180]),
    ])();
    const lat = pick([
      () => between(-80, 80),
      () => between(85, 89.999),
      () => between(-89.999, -85),
    ])();
    return [lon, lat];
  };
  const withZ = rand() < 0.3;
  const pos = (lon: number, lat: number): Position => {
    const p = [wrap(lon), clampLat(lat)];
    return withZ ? [...p, Math.round(between(-50, 4000))] : p;
  };
  const line = (): Position[] => {
    let [lon, lat] = centre();
    const out = [pos(lon, lat)];
    for (let i = 0, n = 1 + Math.floor(rand() * 8); i < n; i++) {
      lon += between(-4, 4);
      lat += between(-2, 2);
      if (rand() < 0.1) lon = Math.sign(lon) * 180;
      if (rand() < 0.05) lat = Math.sign(lat || 1) * 90;
      out.push(pos(lon, lat));
    }
    return out;
  };
  /**
   * A polygon star-shaped round its centre: six or more vertices, one in
   * each equal sector, so it is simple and no two neighbours are more than
   * 120° apart round the centre, which keeps a hole within 0.15 of the
   * radius inside it. Its latitude reach stays inside the poles. Either
   * winding, at random.
   */
  const polygon = (): Position[][] => {
    const [lon, lat] = centre();
    const r = between(0.01, 5);
    const rLat = Math.min(r, 90 - Math.abs(lat));
    const ring = (lo: number, hi: number): Position[] => {
      const n = 6 + Math.floor(rand() * 8);
      const angles = Array.from(
        { length: n },
        (_, i) => ((i + between(0, 0.99)) * 2 * Math.PI) / n,
      );
      const open = angles.map((a) => {
        const k = between(lo, hi);
        return pos(lon + k * r * Math.cos(a), lat + k * rLat * Math.sin(a));
      });
      const closed = [...open, open[0]!];
      return rand() < 0.5 ? closed.toReversed() : closed;
    };
    const holes = rand() < 0.3 ? [ring(0.05, 0.15)] : [];
    return [ring(0.6, 1), ...holes];
  };
  const simple = (): Geometry =>
    pick<() => Geometry>([
      () => ({ type: "Point", coordinates: pos(...centre()) }),
      () => ({ type: "MultiPoint", coordinates: [pos(...centre()), pos(...centre())] }),
      () => ({ type: "LineString", coordinates: line() }),
      () => ({ type: "MultiLineString", coordinates: [line(), line()] }),
      () => ({ type: "Polygon", coordinates: polygon() }),
      () => ({ type: "MultiPolygon", coordinates: [polygon(), polygon()] }),
    ])();
  return {
    line,
    geometry: (): Geometry =>
      rand() < 0.1 ? { type: "GeometryCollection", geometries: [simple(), simple()] } : simple(),
  };
}

/** A ring's area with longitudes unwrapped edge by edge, as the shape was drawn. */
function drawnArea(ring: readonly Position[]): number {
  let x = ring[0]![0]!;
  const unwrapped = ring.map((p, i) => {
    if (i > 0) {
      const d = p[0]! - ring[i - 1]![0]!;
      x += d > 180 ? d - 360 : d < -180 ? d + 360 : d;
    }
    return [x, p[1]!];
  });
  return Math.abs(signedArea(unwrapped));
}

/** The area a polygon covers: its exterior's less its holes'. */
const covered = (polygon: readonly Position[][]) =>
  polygon.reduce((sum, ring, i) => sum + (i === 0 ? 1 : -1) * drawnArea(ring), 0);

function polygonsOf(g: Geometry | null): Position[][][] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  if (g.type === "GeometryCollection") return g.geometries.flatMap(polygonsOf);
  return [];
}

function positionsOf(g: Geometry | null): Position[] {
  if (!g) return [];
  if (g.type === "GeometryCollection") return g.geometries.flatMap(positionsOf);
  const walk = (c: unknown): Position[] =>
    typeof (c as unknown[])[0] === "number" ? [c as Position] : (c as unknown[]).flatMap(walk);
  return walk(g.coordinates);
}

/** A position as a key on the globe, reading 180° and -180° as the same meridian. */
const key = (p: Position) => `${Math.abs(p[0]!) === 180 ? 180 : p[0]},${p[1]},${p[2] ?? ""}`;

const SEEDS = Array.from({ length: 20 }, (_, i) => 7946 + i);

describe("GeoJSON emitters over random geometries", () => {
  it.for(SEEDS)("seed %i: every emitted collection keeps RFC 7946", (seed) => {
    const gen = generator(random(seed));
    const inputs = Array.from({ length: 50 }, () => gen.geometry());
    for (const g of inputs)
      expect(ModelGeometry.safeParse(g).success, JSON.stringify(g)).toBe(true);
    const records = inputs.map((geometry, i) => ({
      id: `oc:situation:fuzz:${seed}-${i}`,
      validity: { status: "active", start: "2026-09-06T08:00:00Z" },
      effects: [],
      location: { geometry },
    }));
    const before = JSON.stringify(records);
    const docs = [
      situationsToGeoJSON(records, {}, { at: new Date("2026-09-06T10:00:00Z") }),
      featuresToGeoJSON(records),
      segmentsToGeoJSON(
        Array.from({ length: 20 }, (_, i) => ({
          segmentId: `${seed}-${i}:f`,
          dir: "f" as const,
          highway: "primary",
          geojson: JSON.stringify({ type: "LineString", coordinates: gen.line() }),
        })),
      ) as { type: "FeatureCollection"; features: Feature[] },
    ];
    expect(JSON.stringify(records)).toBe(before);
    for (const doc of docs) {
      const json = JSON.parse(JSON.stringify(doc)) as { features: Feature[] };
      expect(rfc7946Violations(json)).toEqual([]);
      for (const f of json.features) {
        expect(ModelGeometry.safeParse(f.geometry).success, JSON.stringify(f.geometry)).toBe(true);
      }
    }

    docs[0]!.features.forEach((f, i) => {
      const input = inputs[i]!;
      const output = f.geometry;
      // No vertex is lost or moved; a cut only adds points on the antimeridian.
      const out = new Set(positionsOf(output).map(key));
      for (const p of positionsOf(input)) expect(out.has(key(p)), key(p)).toBe(true);
      // Cutting and rewinding keep the area each polygon covers.
      const area = (g: Geometry | null) => polygonsOf(g).reduce((s, p) => s + covered(p), 0);
      expect(area(output)).toBeCloseTo(area(input), 6);
    });
  });
});
