/**
 * The RFC 7946 rules a GeoJSON text must keep that its JSON Schemas cannot
 * express, checked over an emitted document. Each violation names the JSON
 * pointer it was found at and the section it breaks.
 */

type Json = Record<string, unknown>;

const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Twice the signed area of a closed ring, positive when it runs counterclockwise. */
export function signedArea(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    sum += ring[i - 1]![0]! * ring[i]![1]! - ring[i]![0]! * ring[i - 1]![1]!;
  }
  return sum;
}

/** Whether an edge crosses the antimeridian rather than following it or staying on one side. */
export function crossesAntimeridian(a: readonly number[], b: readonly number[]): boolean {
  const on = (p: readonly number[]) => Math.abs(p[0]!) === 180;
  return Math.abs(b[0]! - a[0]!) > 180 && !(on(a) && on(b));
}

function position(p: unknown, at: string, out: string[]): p is number[] {
  if (!Array.isArray(p) || p.length < 2 || p.length > 3) {
    out.push(`${at}: a position has two or three elements (3.1.1)`);
    return false;
  }
  if (!p.every((n) => typeof n === "number" && Number.isFinite(n))) {
    out.push(`${at}: a position holds finite numbers (3.1.1)`);
    return false;
  }
  const [lon, lat] = p as number[];
  if (lon! < -180 || lon! > 180 || lat! < -90 || lat! > 90) {
    out.push(`${at}: ${lon},${lat} is not a WGS 84 longitude and latitude (4)`);
  }
  return true;
}

function line(coords: unknown, at: string, out: string[], min: number): number[][] {
  if (!Array.isArray(coords) || coords.length < min) {
    out.push(`${at}: needs ${min} or more positions (3.1.4, 3.1.6)`);
    return [];
  }
  const ok = coords.every((p, i) => position(p, `${at}/${i}`, out));
  if (!ok) return [];
  const positions = coords as number[][];
  positions.forEach((p, i) => {
    if (i > 0 && crossesAntimeridian(positions[i - 1]!, p)) {
      out.push(`${at}/${i}: the edge crosses the antimeridian uncut (3.1.9)`);
    }
  });
  return positions;
}

function polygon(coords: unknown, at: string, out: string[]): void {
  if (!Array.isArray(coords) || coords.length === 0) {
    out.push(`${at}: a polygon has at least its exterior ring (3.1.6)`);
    return;
  }
  coords.forEach((r, i) => {
    const ring = line(r, `${at}/${i}`, out, 4);
    if (ring.length === 0) return;
    const first = ring[0]!;
    const last = ring.at(-1)!;
    if (first.length !== last.length || first.some((v, j) => v !== last[j])) {
      out.push(`${at}/${i}: a linear ring is closed with identical values (3.1.6)`);
      return;
    }
    const area = signedArea(ring);
    if (i === 0 ? area < 0 : area > 0) {
      out.push(
        `${at}/${i}: ${i === 0 ? "an exterior ring runs counterclockwise" : "a hole runs clockwise"} (3.1.6)`,
      );
    }
  });
}

function bbox(value: unknown, at: string, out: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length % 2 !== 0 || value.length < 4) {
    out.push(`${at}/bbox: has 2*n numbers (5)`);
    return;
  }
  const n = value.length / 2;
  const [west, south] = value as number[];
  const [east, north] = (value as number[]).slice(n);
  if (south! > north!) out.push(`${at}/bbox: south above north (5)`);
  if (west! > east! && !(west! > 0 && east! < 0)) {
    out.push(`${at}/bbox: west east of east without spanning the antimeridian (5.2)`);
  }
}

function geometry(g: unknown, at: string, out: string[]): void {
  if (!isObject(g) || !GEOMETRY_TYPES.has(g["type"] as string)) {
    out.push(`${at}: not a geometry (3.1)`);
    return;
  }
  if ("crs" in g) out.push(`${at}: a crs member (4)`);
  for (const member of ["geometry", "properties", "features"]) {
    if (member in g) out.push(`${at}: a geometry with "${member}" (7.1)`);
  }
  bbox(g["bbox"], at, out);
  const c = g["coordinates"];
  const each = (f: (item: unknown, path: string) => void) => {
    if (!Array.isArray(c) || c.length === 0) out.push(`${at}/coordinates: empty (3.1)`);
    else for (const [i, item] of c.entries()) f(item, `${at}/coordinates/${i}`);
  };
  switch (g["type"]) {
    case "Point":
      position(c, `${at}/coordinates`, out);
      break;
    case "MultiPoint":
      each((p, path) => position(p, path, out));
      break;
    case "LineString":
      line(c, `${at}/coordinates`, out, 2);
      break;
    case "MultiLineString":
      each((l, path) => line(l, path, out, 2));
      break;
    case "Polygon":
      polygon(c, `${at}/coordinates`, out);
      break;
    case "MultiPolygon":
      each((p, path) => polygon(p, path, out));
      break;
    case "GeometryCollection": {
      if ("coordinates" in g) out.push(`${at}: a GeometryCollection with coordinates (7.1)`);
      const members = g["geometries"];
      if (!Array.isArray(members)) out.push(`${at}/geometries: not an array (3.1.8)`);
      else for (const [i, m] of members.entries()) geometry(m, `${at}/geometries/${i}`, out);
    }
  }
}

/** A Feature's violations. */
export function featureViolations(f: unknown, at = ""): string[] {
  const out: string[] = [];
  if (!isObject(f) || f["type"] !== "Feature") return [`${at}: not a Feature (3.2)`];
  if ("id" in f && typeof f["id"] !== "string" && typeof f["id"] !== "number") {
    out.push(`${at}/id: a string or number (3.2)`);
  }
  if (!("geometry" in f)) out.push(`${at}: has a geometry member (3.2)`);
  else if (f["geometry"] !== null) geometry(f["geometry"], `${at}/geometry`, out);
  const props = f["properties"];
  if (!("properties" in f) || (props !== null && !isObject(props))) {
    out.push(`${at}/properties: an object or null (3.2)`);
  }
  for (const member of ["coordinates", "geometries", "features"]) {
    if (member in f) out.push(`${at}: a Feature with "${member}" (7.1)`);
  }
  if ("crs" in f) out.push(`${at}: a crs member (4)`);
  bbox(f["bbox"], at, out);
  return out;
}

/** A FeatureCollection's violations, its features' included. */
export function rfc7946Violations(doc: unknown): string[] {
  if (!isObject(doc) || doc["type"] !== "FeatureCollection") return ["/: not a FeatureCollection"];
  const out: string[] = [];
  for (const member of ["coordinates", "geometries", "geometry", "properties"]) {
    if (member in doc) out.push(`/: a FeatureCollection with "${member}" (7.1)`);
  }
  if ("crs" in doc) out.push("/: a crs member (4)");
  bbox(doc["bbox"], "", out);
  const features = doc["features"];
  if (!Array.isArray(features)) return [...out, "/features: not an array (3.3)"];
  for (const [i, f] of features.entries()) out.push(...featureViolations(f, `/features/${i}`));
  return out;
}
