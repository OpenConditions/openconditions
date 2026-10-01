import { jcs } from "../kernel/identity.js";
import type { Result } from "../kernel/result.js";
import type { Validity } from "../kernel/validity.js";
import { representativePoint } from "../linking/link.js";
import type { Registry } from "../registry/build.js";
import { isValidityInEffectAt } from "../schedule/in-effect.js";
import { crowdRulesFor } from "./rules.js";

type Position = [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Every ring or line of a geometry, with whether it bounds an area. */
function partsOf(geometry: unknown): { lines: Position[][]; polygons: Position[][][] } {
  const g = geometry as { type: string; coordinates?: unknown; geometries?: unknown[] };
  const out = { lines: [] as Position[][], polygons: [] as Position[][][] };
  const c = g.coordinates as never;
  switch (g.type) {
    case "Point":
      out.lines.push([c]);
      break;
    case "MultiPoint":
      for (const p of c as Position[]) out.lines.push([p]);
      break;
    case "LineString":
      out.lines.push(c);
      break;
    case "MultiLineString":
      out.lines.push(...(c as Position[][]));
      break;
    case "Polygon":
      out.polygons.push(c);
      break;
    case "MultiPolygon":
      out.polygons.push(...(c as Position[][][]));
      break;
    case "GeometryCollection":
      for (const member of g.geometries ?? []) {
        const inner = partsOf(member);
        out.lines.push(...inner.lines);
        out.polygons.push(...inner.polygons);
      }
      break;
  }
  return out;
}

/** Whether a projected point lies inside a ring (ray casting). */
function inside(x: number, y: number, ring: readonly Position[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Distance from the origin to the segment a–b, in the projected plane. */
function toSegment(a: Position, b: Position): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len));
  return Math.hypot(a[0] + t * dx, a[1] + t * dy);
}

/**
 * Metres from a point to the nearest part of a geometry, zero inside a
 * polygon. Positions are projected onto a plane tangent at the point, which
 * is exact enough over the few hundred metres a match spans.
 */
export function distanceToGeometryMetres(point: Position, geometry: unknown): number {
  const [lon0, lat0] = point;
  const kx = Math.cos(lat0 * RAD) * EARTH_RADIUS_M * RAD;
  const ky = EARTH_RADIUS_M * RAD;
  const project = (ring: readonly Position[]): Position[] =>
    ring.map(([lon, lat]) => {
      let d = lon - lon0;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return [d * kx, (lat - lat0) * ky];
    });
  const { lines, polygons } = partsOf(geometry);
  let best = Infinity;
  const measure = (ring: Position[]) => {
    if (ring.length === 1) best = Math.min(best, Math.hypot(ring[0]![0], ring[0]![1]));
    for (let i = 1; i < ring.length; i++) best = Math.min(best, toSegment(ring[i - 1]!, ring[i]!));
  };
  for (const line of lines) measure(project(line));
  for (const polygon of polygons) {
    const rings = polygon.map(project);
    const [outer, ...holes] = rings;
    if (outer !== undefined && inside(0, 0, outer) && !holes.some((h) => inside(0, 0, h))) return 0;
    for (const ring of rings) measure(ring);
  }
  return best;
}

/** The point a report stands for: itself when it is one, else the mean of its vertices. */
function anchorOf(geometry: unknown): Position | undefined {
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g?.type === "Point") return g.coordinates as Position;
  const mean = representativePoint(geometry);
  if (mean !== undefined) return mean;
  const first = partsOf(geometry).lines[0]?.[0];
  return first === undefined ? undefined : [first[0], first[1]];
}

/** The parts of a situation agreement reads. */
export interface AgreeingSituation {
  kind: string;
  type: string;
  location: { geometry: unknown };
  validity: Validity;
}

/**
 * Whether `other` describes the phenomenon a crowd situation `report`
 * reports: the same kind and type, in effect when the report was made, and
 * within the kind's match distance of where it was reported. This decides
 * both corroboration (another reporter's report) and external resolution (a
 * feed's situation); which of the two it is, and that the two come from
 * different reporters or sources, is the caller's to say.
 */
export function situationsAgree(
  registry: Registry,
  report: AgreeingSituation,
  other: AgreeingSituation,
): boolean {
  if (report.kind !== other.kind || report.type !== other.type) return false;
  const rules = crowdRulesFor(registry, {
    class: "situation",
    kind: report.kind,
    type: report.type,
  });
  if (rules === undefined || other.location.geometry === null) return false;
  const reportedAt = report.validity.start;
  if (reportedAt === undefined || !isValidityInEffectAt(other.validity, new Date(reportedAt))) {
    return false;
  }
  const anchor = anchorOf(report.location.geometry);
  if (anchor === undefined) return false;
  return distanceToGeometryMetres(anchor, other.location.geometry) <= rules.matchMetres!;
}

/**
 * Whether two results of one property agree: the same value, or for a
 * quantity or price with an agreement tolerance, the same unit (currency and
 * sale unit) and a difference within the tolerance.
 */
export function resultsAgree(registry: Registry, property: string, a: Result, b: Result): boolean {
  if (a.type !== b.type) return false;
  const tolerance = registry.property(property)?.crowd?.agreement?.tolerance ?? 0;
  if (a.type === "quantity" && b.type === "quantity") {
    return a.unit === b.unit && Math.abs(a.value - b.value) <= tolerance + 1e-9;
  }
  if (a.type === "money" && b.type === "money") {
    return (
      a.currency === b.currency &&
      a.per === b.per &&
      Math.abs(Number(a.amount) - Number(b.amount)) <= tolerance + 1e-9
    );
  }
  return jcs(a) === jcs(b);
}

/** The parts of an observation agreement reads. */
export interface AgreeingObservation {
  property: string;
  qualifiers?: Record<string, unknown>;
  result: Result;
  phenomenonTime: { instant: string } | { start: string; end: string };
}

const startOf = (t: AgreeingObservation["phenomenonTime"]) =>
  Date.parse("instant" in t ? t.instant : t.start);

/**
 * Whether an authoritative reading confirms a crowd reading of the same
 * subject: the same property and qualifiers, agreeing results, and a reading
 * that either was in force when the report was made — the source's latest
 * reading of the series then, which the caller picks, since a status or a
 * price holds from when it was stated until it changes — or arrived within
 * the report's lifetime after it. A reading that disagrees resolves nothing:
 * the authoritative feed may be what is wrong, which is why the crowd
 * reports.
 */
export function observationConfirms(
  registry: Registry,
  report: AgreeingObservation,
  authoritative: AgreeingObservation & { validUntil?: string },
): boolean {
  if (report.property !== authoritative.property) return false;
  if (jcs(report.qualifiers ?? null) !== jcs(authoritative.qualifiers ?? null)) return false;
  const rules = crowdRulesFor(registry, { class: "observation", property: report.property });
  if (rules === undefined) return false;
  const at = startOf(report.phenomenonTime);
  const t = authoritative.phenomenonTime;
  const start = startOf(t);
  const end = "end" in t ? Date.parse(t.end) : Date.parse(authoritative.validUntil ?? "");
  const inForce = start <= at && !(end <= at);
  const after = start > at && start - at <= rules.ttlSec * 1000;
  if (!inForce && !after) return false;
  return resultsAgree(registry, report.property, report.result, authoritative.result);
}
