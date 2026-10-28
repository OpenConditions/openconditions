/**
 * One measure published by two sources: a city's roadworks and the state's
 * or the motorway operator's record of the same works. Two publishers of one
 * measure agree on its dates and draw it one on top of the other, but share
 * neither their own types, nor often the exact validity or wording, so the
 * traffic-meaning key (`situationCompatibilityKey`) never matches them.
 * Distance is no signal either: a street crossing a motorway lies at 0 m.
 *
 * The rules come from 1,442 candidate pairs of 34 live feeds labelled by hand
 * (2026-10-28). Records of different sources are one measure when:
 *
 * - their kinds agree, works and closures counting as one;
 * - both state a start and an end, both within a day of the other's, or one
 *   within a day and the other within a month when the headlines also agree;
 * - one lies along the other (at least 80 %, 60 % with agreeing headlines, of
 *   its length within {@link COVER_M}) and, unless one is a point, the smaller
 *   covers at least 30 % of the larger: a ramp or a short section inside a
 *   long corridor record of the same works is another element of it;
 * - a point, which covers nothing, also says what the other says (agreeing
 *   headlines) and is not on another named road than the other record;
 * - both state no effects, or the same kinds of effect (a closure for a
 *   closure), so the survivor's say as much;
 * - their dates' slack is at most half the shorter record: a night closure a
 *   day later is the next night's.
 *
 * On the labelled pairs this finds 96 of 140 duplicates and 84 of 192
 * records covering part of another, against 3 of 1,109 pairs describing
 * different measures. The record covering the other survives, so a section
 * folds into the whole; a record carrying restriction evidence (an effect not
 * completely read, or one whose vehicles are unknown) is never dropped, and
 * two such records are never one; nor is a record stating effects dropped for
 * one that states none.
 */
type Rec = Record<string, unknown>;

const COVER_M = 15;
const SAME_DAY_H = 25;
const SAME_MONTH_H = 31 * 24;
const SAMPLES = 64;
/** Shorter than this, a geometry is a point: it cannot cover a line. */
const POINT_M = 20;
const M_PER_DEG = 111_320;

type Part = [number, number][];

/** A record's place as lines, polygon rings and points, with its bounding box. */
export interface Shape {
  parts: Part[];
  bbox: [number, number, number, number];
}

const object = (value: unknown): Rec | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;

/** A record's geometry as a {@link Shape}, or undefined when it has no shape. */
export function shapeOf(record: Rec): Shape | undefined {
  const parts: Part[] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c) || c.length === 0) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      parts.push([[c[0], c[1]]]);
      return;
    }
    const first = c[0] as unknown;
    if (Array.isArray(first) && typeof first[0] === "number") {
      parts.push((c as [number, number][]).map(([x, y]) => [x, y]));
      return;
    }
    for (const x of c) walk(x);
  };
  const geometry = object(object(record["location"])?.["geometry"]);
  if (!geometry) return undefined;
  const nested = geometry["geometries"];
  if (Array.isArray(nested)) for (const g of nested) walk(object(g)?.["coordinates"]);
  else walk(geometry["coordinates"]);
  if (parts.length === 0) return undefined;
  // A coordinate that is no longitude/latitude makes the record no shape to compare.
  const valid = ([x, y]: [number, number]) =>
    Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90;
  if (!parts.every((part) => part.every(valid))) return undefined;
  const bbox: Shape["bbox"] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of parts)
    for (const [x, y] of part) {
      bbox[0] = Math.min(bbox[0], x);
      bbox[1] = Math.min(bbox[1], y);
      bbox[2] = Math.max(bbox[2], x);
      bbox[3] = Math.max(bbox[3], y);
    }
  return { parts, bbox };
}

const local = ([x, y]: [number, number], cos: number): [number, number] => [
  x * M_PER_DEG * cos,
  y * M_PER_DEG,
];

function toSegmentM(p: [number, number], a: [number, number], b: [number, number], cos: number) {
  const [px, py] = local(p, cos);
  const [ax, ay] = local(a, cos);
  const [bx, by] = local(b, cos);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** A line's consecutive vertex pairs; a point is one pair of itself. */
function* segments(part: Part): Generator<[[number, number], [number, number]]> {
  let previous: [number, number] | undefined;
  for (const vertex of part) {
    if (previous) yield [previous, vertex];
    previous = vertex;
  }
  if (part.length === 1 && previous) yield [previous, previous];
}

function toPartM(p: [number, number], part: Part, cos: number): number {
  let min = Infinity;
  for (const [a, b] of segments(part)) min = Math.min(min, toSegmentM(p, a, b, cos));
  return min;
}

function lengthM(parts: Part[], cos: number): number {
  let sum = 0;
  for (const part of parts)
    for (const [a, b] of segments(part)) {
      const [ax, ay] = local(a, cos);
      const [bx, by] = local(b, cos);
      sum += Math.hypot(bx - ax, by - ay);
    }
  return sum;
}

/** Points spread evenly along a shape's lines, about {@link SAMPLES} of them. */
function samplesAlong(parts: Part[], cos: number): [number, number][] {
  const step = lengthM(parts, cos) / SAMPLES;
  const out: [number, number][] = [];
  for (const part of parts) {
    for (const [a, b] of segments(part)) {
      const [lx, ly] = local(a, cos);
      const [mx, my] = local(b, cos);
      const n = step > 0 ? Math.max(1, Math.ceil(Math.hypot(mx - lx, my - ly) / step)) : 1;
      for (let k = 0; k < n; k++)
        out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    const last = part.at(-1);
    if (last && part.length > 1) out.push(last);
  }
  return out;
}

/** The share of `a`'s length lying within {@link COVER_M} of `b`. */
function coverage(a: Part[], b: Part[], cos: number): number {
  const samples = samplesAlong(a, cos);
  if (samples.length === 0) return 0;
  let near = 0;
  for (const p of samples) if (b.some((part) => toPartM(p, part, cos) <= COVER_M)) near++;
  return near / samples.length;
}

/** Whether two shapes' bounding boxes come within {@link COVER_M} of each other. */
export function shapesNear(a: Shape, b: Shape): boolean {
  const dLat = COVER_M / M_PER_DEG;
  const dLon = dLat / Math.max(0.1, Math.cos((((a.bbox[1] + a.bbox[3]) / 2) * Math.PI) / 180));
  return (
    a.bbox[0] - dLon <= b.bbox[2] &&
    b.bbox[0] - dLon <= a.bbox[2] &&
    a.bbox[1] - dLat <= b.bbox[3] &&
    b.bbox[1] - dLat <= a.bbox[3]
  );
}

const hours = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 3_600_000 : undefined;
};

const WORKS_OR_CLOSURE = new Set(["roadworks", "closure"]);
const kindsAgree = (a: unknown, b: unknown) =>
  a === b || (WORKS_OR_CLOSURE.has(a as string) && WORKS_OR_CLOSURE.has(b as string));

/** An effect not completely read, or binding vehicles it does not name. */
function restrictionEvidence(record: Rec): boolean {
  const effects = record["effects"];
  return (
    Array.isArray(effects) &&
    effects.some((value) => {
      const effect = object(value);
      return (
        effect !== undefined &&
        (object(effect["applicability"])?.["kind"] === "unknown" ||
          effect["normalization"] !== "complete")
      );
    })
  );
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Whether two records' headlines say the same, in any language they share. */
function headlinesAgree(a: Rec, b: Rec): boolean {
  const texts = (r: Rec) =>
    (Array.isArray(r["headline"]) ? (r["headline"] as unknown[]) : [])
      .map(object)
      .filter((t): t is Rec => typeof t?.["text"] === "string");
  return texts(a).some((ta) =>
    texts(b).some((tb) => {
      const wa = words(ta["text"] as string);
      const wb = words(tb["text"] as string);
      if (wa.size === 0 || wb.size === 0) return false;
      let shared = 0;
      for (const w of wa) if (wb.has(w)) shared++;
      return shared / (wa.size + wb.size - shared) >= 0.5;
    }),
  );
}

/** The road names and numbers a record states, normalised. */
function roadKeys(record: Rec): Set<string> {
  const roads = object(record["location"])?.["roads"];
  const keys = new Set<string>();
  for (const value of Array.isArray(roads) ? roads : []) {
    const road = object(value);
    if (typeof road?.["ref"] === "string") keys.add(road["ref"].replace(/\s+/g, "").toLowerCase());
    const names = road?.["name"];
    for (const name of Array.isArray(names) ? names : [names]) {
      const text = typeof name === "string" ? name : object(name)?.["text"];
      if (typeof text === "string" && text.trim()) keys.add(text.replace(/\s+/g, "").toLowerCase());
    }
  }
  return keys;
}

function roadsConflict(a: Rec, b: Rec): boolean {
  const ka = roadKeys(a);
  const kb = roadKeys(b);
  return ka.size > 0 && kb.size > 0 && ![...ka].some((k) => kb.has(k));
}

const sourceOf = (record: Rec) => object(record["provenance"])?.["sourceId"];
const stated = (effects: unknown) => Array.isArray(effects) && effects.length > 0;
/** The kinds of effect a record states, as one comparable key. */
const effectKinds = (record: Rec) =>
  [
    ...new Set(
      (Array.isArray(record["effects"]) ? (record["effects"] as unknown[]) : []).map(
        (e) => object(e)?.["kind"],
      ),
    ),
  ]
    .map(String)
    .sort()
    .join(",");

/**
 * Whether `a` and `b`, of different sources, are one measure: undefined when
 * not, else the record that survives (the one covering the other).
 */
export function sameMeasureAcrossSources(a: Rec, sa: Shape, b: Rec, sb: Shape): Rec | undefined {
  if (sourceOf(a) === sourceOf(b) || !kindsAgree(a["kind"], b["kind"])) return undefined;
  if (stated(a["effects"]) && stated(b["effects"]) && effectKinds(a) !== effectKinds(b))
    return undefined;
  const evidenceA = restrictionEvidence(a);
  const evidenceB = restrictionEvidence(b);
  if (evidenceA && evidenceB) return undefined;
  const va = object(a["validity"]);
  const vb = object(b["validity"]);
  const [startA, endA, startB, endB] = [
    hours(va?.["start"]),
    hours(va?.["end"]),
    hours(vb?.["start"]),
    hours(vb?.["end"]),
  ];
  if (startA === undefined || endA === undefined || startB === undefined || endB === undefined)
    return undefined;
  const dStart = Math.abs(startA - startB);
  const dEnd = Math.abs(endA - endB);
  // A day's slack absorbs dates written as days; a night closure a day later
  // is the next night's, so the slack is at most half the shorter record.
  const day = Math.min(SAME_DAY_H, Math.min(endA - startA, endB - startB) / 2);
  const sameDays = dStart <= day && dEnd <= day;
  const oneDay = (dStart <= day && dEnd <= SAME_MONTH_H) || (dEnd <= day && dStart <= SAME_MONTH_H);
  if (!sameDays && !(oneDay && headlinesAgree(a, b))) return undefined;
  if (!shapesNear(sa, sb)) return undefined;
  const cos = Math.cos((((sa.bbox[1] + sa.bbox[3]) / 2) * Math.PI) / 180);
  const aInB = coverage(sa.parts, sb.parts, cos);
  const bInA = coverage(sb.parts, sa.parts, cos);
  const point = lengthM(sa.parts, cos) < POINT_M || lengthM(sb.parts, cos) < POINT_M;
  if (Math.max(aInB, bInA) < (sameDays ? 0.8 : 0.6)) return undefined;
  if (!point && Math.min(aInB, bInA) < 0.3) return undefined;
  // A point near a line or another point may be another report, or on a crossing road.
  if (point && (!headlinesAgree(a, b) || roadsConflict(a, b))) return undefined;
  if (evidenceA) return a;
  if (evidenceB) return b;
  // Stated effects (a closure, a limit) are what routing reads: their record stays.
  if (stated(a["effects"])) return a;
  if (stated(b["effects"])) return b;
  // `b` lies further along `a` than `a` along `b`: `a` covers it. Equal, the earlier stays.
  return aInB > bInA ? b : a;
}
