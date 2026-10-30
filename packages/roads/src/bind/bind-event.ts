/**
 * The pure resolver: an event's geometry plus its stated road references
 * against a spine subgraph, producing ordered directed spans. No I/O and no
 * database — SQL only fetches the subgraph and stores the outcome, so the
 * whole resolver is testable and reproducible offline.
 *
 * Three geometry shapes are handled: a single point (best candidate only, both
 * directions when the way is bidirectional), an endpoint pair (bounded
 * Dijkstra between the two projections) and a line (per-sample best candidate,
 * walked in order with shortest paths filling the gaps).
 */

import type { BindingStatus, DirectionMode, SegmentSpan } from "@openconditions/core";
import type { Geometry, LineString, MultiLineString, MultiPoint, Point } from "geojson";
import type { TravelDirection } from "./direction.js";
import {
  bearingDeg,
  bearingDelta,
  densify,
  type LngLat,
  polylineLengthM,
  projectOntoPolyline,
} from "./geo.js";
import { nodeKey, SegmentGraph } from "./graph.js";
import { identityScore, roadIdentity } from "./identity.js";
import { scoreCandidate } from "./score.js";
import { SegmentGrid } from "./segment-grid.js";
import {
  BIND_DEFAULTS,
  type BindDebug,
  type BindInput,
  type BindOptions,
  type BindResult,
  type Candidate,
  type SpineSegment,
  type SpineSubgraph,
} from "./types.js";

/** Situation kinds that describe an area or a non-road subject and never bind to a carriageway. */
export const NOT_APPLICABLE_TYPES: ReadonlySet<string> = new Set([
  "weather_condition",
  "public_event",
  "authority",
  "security",
]);

/** Hard ceiling on a reconstructed endpoint-pair path, in metres. */
const MAX_ENDPOINT_PATH_M = 30_000;
/** Start × end candidate pairs tried when reconstructing an endpoint pair. */
const ENDPOINT_CANDIDATES = 3;
/** Confidence ceiling for a binding whose carriageway could not be decided. */
const UNKNOWN_DIRECTION_CONFIDENCE = 0.69;
/**
 * How much better the chosen segment's heading must fit than the best rival's
 * before the direction counts as decided, in degrees.
 */
const MIN_BEARING_MARGIN_DEG = 30;

/** Build a resolver input from a road event, normalizing its refs and names. */
export function toBindInput(ev: {
  id: string;
  geometry: Geometry;
  type: string;
  roads?: Array<{ ref?: string; name?: string }>;
  /** The record's headline and description, read for street names where its roads state none. */
  text?: string[];
  direction?: string;
  travel?: TravelDirection;
  roadState?: string;
  slipRoadOnly?: boolean;
  slipRoad?: "exit" | "entry";
}): BindInput {
  const { refs, names, prose } = roadIdentity(ev.roads ?? [], ev.text);
  return {
    id: ev.id,
    geometry: ev.geometry,
    type: ev.type,
    refs,
    ...(names.length > 0 ? { names } : {}),
    ...(prose !== undefined ? { prose } : {}),
    ...(ev.direction ? { direction: ev.direction } : {}),
    ...(ev.travel ? { travel: ev.travel } : {}),
    ...(ev.roadState ? { roadState: ev.roadState } : {}),
    ...(ev.slipRoadOnly ? { slipRoadOnly: true } : {}),
    ...(ev.slipRoadOnly && ev.slipRoad ? { slipRoad: ev.slipRoad } : {}),
  };
}

type Shape =
  | { kind: "point"; point: LngLat }
  | { kind: "line"; coords: LngLat[] }
  | { kind: "endpoints"; start: LngLat; end: LngLat }
  | { kind: "disconnected" };

/** Reduce GeoJSON to the three shapes the resolver understands; areas return null. */
function shapeOf(g: Geometry): Shape | null {
  switch (g.type) {
    case "Point":
      return { kind: "point", point: (g as Point).coordinates as LngLat };
    case "LineString":
      return { kind: "line", coords: (g as LineString).coordinates as LngLat[] };
    case "MultiLineString": {
      const parts = (g as MultiLineString).coordinates as LngLat[][];
      // Concatenate components only where each one ends exactly where the next
      // begins. Flattening a gap would invent a connector across whatever road
      // lies between the components, and then bind the event to it.
      for (let i = 1; i < parts.length; i++) {
        const previous = parts[i - 1];
        const next = parts[i];
        if (!previous || previous.length === 0 || !next || next.length === 0) {
          return { kind: "disconnected" };
        }
        const end = previous[previous.length - 1]!;
        const start = next[0]!;
        if (end[0] !== start[0] || end[1] !== start[1]) return { kind: "disconnected" };
      }
      return { kind: "line", coords: parts.flat() };
    }
    case "MultiPoint": {
      const pts = (g as MultiPoint).coordinates as LngLat[];
      if (pts.length === 1) return { kind: "point", point: pts[0]! };
      if (pts.length === 2) return { kind: "endpoints", start: pts[0]!, end: pts[1]! };
      return { kind: "line", coords: pts };
    }
    default:
      return null;
  }
}

/** Whether two segments meet at a node, comparing both ends of each. */
function nodeAdjacent(a: SpineSegment, b: SpineSegment): boolean {
  if (a.coords.length === 0 || b.coords.length === 0) return false;
  const aStart = nodeKey(a.coords[0]!);
  const aEnd = nodeKey(a.coords[a.coords.length - 1]!);
  const bStart = nodeKey(b.coords[0]!);
  const bEnd = nodeKey(b.coords[b.coords.length - 1]!);
  return aStart === bStart || aStart === bEnd || aEnd === bStart || aEnd === bEnd;
}

/**
 * A candidate genuinely competing with the chosen one. The next way along a
 * carriageway is a continuation, not a competitor — consecutive ways share a
 * node, while opposite carriageways never do. A parallel road is settled only
 * when the event's own number or street name picked the winner: a match on
 * both, or a location that names neither, leaves the choice open, so the
 * candidate stays a rival.
 */
function isRival(c: Candidate, chosen: Candidate): boolean {
  return (
    c.segment.wayId !== chosen.segment.wayId &&
    !nodeAdjacent(c.segment, chosen.segment) &&
    chosen.identity <= c.identity
  );
}

/** Every spine segment within `maxOffsetM` of `p` that survives scoring, best first. */
function candidatesFor(
  p: LngLat,
  bearing: number | null,
  input: BindInput,
  grid: SegmentGrid,
  maxOffsetM: number,
  vetoes?: { count: number },
): Candidate[] {
  const out: Candidate[] = [];
  for (const s of grid.near(p)) {
    if (s.coords.length === 0) continue;
    const pr = projectOntoPolyline(p, s.coords);
    if (pr.offsetM > maxOffsetM) continue;
    const delta = bearing == null ? null : bearingDelta(bearing, pr.bearing);
    const rs = identityScore(input, s);
    // A road the location's stated number or street name contradicts is
    // another road, however near: the side street's roadworks are not on the
    // main road beside it.
    if (rs === 0) {
      if (vetoes) vetoes.count++;
      continue;
    }
    const score = scoreCandidate(
      { offsetM: pr.offsetM, bearingDelta: delta, identity: rs, highway: s.highway },
      maxOffsetM,
    );
    // Only a heading beyond 90° scores 0, and that means the wrong carriageway.
    if (score <= 0) continue;
    out.push({
      segment: s,
      offsetM: pr.offsetM,
      fraction: pr.fraction,
      bearingDelta: delta,
      identity: rs,
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Why nothing bound: `road_mismatch` when roads lay near but each contradicts
 * the stated number or street name (the location's road is not in the spine),
 * else `no_candidates`.
 */
function unmatched(vetoes: { count: number }): string {
  return vetoes.count > 0 ? "road_mismatch" : "no_candidates";
}

function fractionOn(s: SpineSegment, p: LngLat): number {
  return projectOntoPolyline(p, s.coords).fraction;
}

function span(s: SpineSegment, startFraction: number, endFraction: number): SegmentSpan {
  return {
    segmentId: s.segmentId,
    wayId: s.wayId,
    dir: s.dir,
    startFraction: Math.min(startFraction, endFraction),
    endFraction: Math.max(startFraction, endFraction),
  };
}

/** First and last segment are clipped to the event's endpoints; the rest are fully covered. */
function spansAlong(path: SpineSegment[], start: LngLat, end: LngLat): SegmentSpan[] {
  return path.map((s, i) =>
    span(s, i === 0 ? fractionOn(s, start) : 0, i === path.length - 1 ? fractionOn(s, end) : 1),
  );
}

/** Share of samples the path explains, and their mean offset from it. */
function pathFit(
  path: SpineSegment[],
  samples: LngLat[],
  maxOffsetM: number,
): { coverage: number; meanOffsetM: number } {
  if (samples.length === 0) return { coverage: 0, meanOffsetM: maxOffsetM };
  let covered = 0;
  let sum = 0;
  for (const p of samples) {
    let best = Infinity;
    for (const s of path) best = Math.min(best, projectOntoPolyline(p, s.coords).offsetM);
    if (best <= maxOffsetM) covered++;
    sum += Math.min(best, maxOffsetM);
  }
  return { coverage: covered / samples.length, meanOffsetM: sum / samples.length };
}

function confidenceOf(
  a: {
    coverage: number;
    meanOffsetM: number;
    identity: number;
    directionMode: DirectionMode;
    ambiguity: number;
  },
  maxOffsetM: number,
): number {
  const direction = a.directionMode === "single" ? 1 : a.directionMode === "both" ? 0.5 : 0;
  const raw =
    0.4 * a.coverage +
    0.2 * (1 - a.meanOffsetM / maxOffsetM) +
    0.2 * a.identity +
    0.1 * direction +
    0.1 * (1 - a.ambiguity);
  // An undecided carriageway must never reach a routing-relevant status.
  return a.directionMode === "unknown" ? Math.min(raw, UNKNOWN_DIRECTION_CONFIDENCE) : raw;
}

/** Ambiguity from which a well-supported binding is no longer `exact`. */
const EXACT_MAX_AMBIGUITY = 0.8;
/**
 * Ambiguity from which a binding is no longer `likely` either. A runner-up
 * scoring this close to the winner makes the choice a coin flip, and a coin
 * flip must not close a road for routing however well the winner fits.
 */
const LIKELY_MAX_AMBIGUITY = 0.9;

/** Share of a line's samples its path must lie near for the line to be bound at all. */
const MIN_LINE_COVERAGE = 0.5;

function statusOf(confidence: number, ambiguity: number): BindingStatus {
  if (confidence >= 0.9 && ambiguity < EXACT_MAX_AMBIGUITY) return "exact";
  if (confidence >= 0.7 && ambiguity < LIKELY_MAX_AMBIGUITY) return "likely";
  return "ambiguous";
}

function failure(
  status: BindingStatus,
  reason: string,
  candidateCount = 0,
  samples: BindDebug["samples"] = [],
): BindResult {
  return {
    status,
    confidence: null,
    directionMode: "unknown",
    candidateCount,
    alternativeConfidence: null,
    reason,
    segments: [],
    debug: { samples, pathScore: null, coverage: null, meanOffsetM: null, ambiguity: null },
  };
}

/**
 * A single point: the nearest carriageway wins. A bidirectional way binds both
 * of its directions; a rival way leaves the direction unknown and caps
 * confidence, so routing never closes a guessed carriageway.
 */
function bindPoint(
  point: LngLat,
  input: BindInput,
  grid: SegmentGrid,
  maxOffsetM: number,
): BindResult {
  const vetoes = { count: 0 };
  const candidates = candidatesFor(point, null, input, grid, maxOffsetM, vetoes);
  const samples = [{ point, candidates }];
  if (candidates.length === 0) return failure("unresolved", unmatched(vetoes), 0, samples);

  const best = candidates[0]!;
  const twin = candidates.find(
    (c) => c.segment.wayId === best.segment.wayId && c.segment.dir !== best.segment.dir,
  );
  const rival = candidates.find((c) => isRival(c, best));
  const ambiguity = rival ? rival.score / best.score : 0;
  const directionMode: DirectionMode = twin ? "both" : rival ? "unknown" : "single";

  const segments = [best, ...(twin ? [twin] : [])].map((c) =>
    span(c.segment, c.fraction, c.fraction),
  );
  const confidence = confidenceOf(
    { coverage: 1, meanOffsetM: best.offsetM, identity: best.identity, directionMode, ambiguity },
    maxOffsetM,
  );

  return {
    status: statusOf(confidence, ambiguity),
    confidence,
    directionMode,
    candidateCount: candidates.length,
    alternativeConfidence: rival ? ambiguity * confidence : null,
    segments,
    debug: { samples, pathScore: best.score, coverage: 1, meanOffsetM: best.offsetM, ambiguity },
  };
}

/**
 * A DATEX-style start/end pair: reconstruct the road between the two
 * projections with a bounded Dijkstra, trying the best few candidates on each
 * end and keeping the highest-scoring path.
 */
function bindEndpoints(
  start: LngLat,
  end: LngLat,
  input: BindInput,
  grid: SegmentGrid,
  graph: SegmentGraph,
  onRef: (s: SpineSegment) => boolean,
  maxOffsetM: number,
): BindResult {
  const straightM = polylineLengthM([start, end]);
  // Coincident endpoints carry no travel direction; use the point rules,
  // including both directions on a bidirectional way.
  if (straightM === 0) return bindPoint(start, input, grid, maxOffsetM);
  const cap = Math.min(MAX_ENDPOINT_PATH_M, 2.5 * straightM + 500);
  const vetoes = { count: 0 };
  const starts = candidatesFor(start, null, input, grid, maxOffsetM, vetoes).slice(
    0,
    ENDPOINT_CANDIDATES,
  );
  const ends = candidatesFor(end, null, input, grid, maxOffsetM, vetoes).slice(
    0,
    ENDPOINT_CANDIDATES,
  );
  const samples = [
    { point: start, candidates: starts },
    { point: end, candidates: ends },
  ];
  const candidateCount = starts.length + ends.length;
  if (starts.length === 0 || ends.length === 0)
    return failure("unresolved", unmatched(vetoes), candidateCount, samples);

  const routes: EndpointRoute[] = [];
  for (const s of starts) {
    for (const e of ends) {
      // The graph's singleton path knows only the segment ID. Its projected
      // endpoints must also run in travel direction before that shortcut is
      // admissible; sorting the output fractions must never hide reversal.
      if (s.segment.segmentId === e.segment.segmentId && s.fraction > e.fraction) continue;
      const path = graph.shortestPath(s.segment.segmentId, e.segment.segmentId, cap, onRef);
      if (!path) continue;
      const rs = path.reduce((m, p) => Math.min(m, identityScore(input, p)), 1);
      const score = ((s.score + e.score) / 2) * (0.8 + 0.2 * rs);
      const lengthM = [...coveredM(path, start, end).values()].reduce((sum, m) => sum + m, 0);
      routes.push({ path, score, lengthM, identity: rs, from: s, to: e });
    }
  }
  const best = routes.reduce<EndpointRoute | null>(
    // A directed twin can also be reached by travelling to the end of the way
    // and turning back. Equal endpoint scores must prefer the direct route.
    (m, r) => (!m || r.score > m.score || (r.score === m.score && r.lengthM < m.lengthM) ? r : m),
    null,
  );
  if (!best) return failure("unresolved", "no_path", candidateCount, samples);

  // A runner-up competes only to the extent it runs over other road. The same
  // path entered from the previous way is a continuation, a parallel road a
  // genuine rival, and a detour sharing part of the winner sits in between.
  const bestCovered = coveredM(best.path, start, end);
  let ambiguity = 0;
  for (const r of routes) {
    if (r === best) continue;
    const rivalry =
      (r.score / best.score) * (1 - overlapOf(bestCovered, coveredM(r.path, start, end)));
    ambiguity = Math.max(ambiguity, rivalry);
  }
  // The offsets that matter are the ends of the path that won, not the best
  // candidates overall — the winning path may not start or end on those.
  const meanOffsetM = (best.from.offsetM + best.to.offsetM) / 2;
  const confidence = confidenceOf(
    { coverage: 1, meanOffsetM, identity: best.identity, directionMode: "single", ambiguity },
    maxOffsetM,
  );
  return {
    status: statusOf(confidence, ambiguity),
    confidence,
    directionMode: "single",
    candidateCount,
    alternativeConfidence: ambiguity > 0 ? ambiguity * confidence : null,
    segments: spansAlong(best.path, start, end),
    debug: { samples, pathScore: best.score, coverage: 1, meanOffsetM, ambiguity },
  };
}

interface EndpointRoute {
  path: SpineSegment[];
  score: number;
  lengthM: number;
  identity: number;
  from: Candidate;
  to: Candidate;
}

/** Metres of road a path covers between the event's endpoints, per segment. */
function coveredM(path: SpineSegment[], start: LngLat, end: LngLat): Map<string, number> {
  const spans = spansAlong(path, start, end);
  return new Map(
    path.map((s, i) => [
      s.segmentId,
      (spans[i]!.endFraction - spans[i]!.startFraction) * polylineLengthM(s.coords),
    ]),
  );
}

/** Share of road two covered paths have in common, by length: 1 = the same road, 0 = disjoint. */
function overlapOf(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0;
  let union = 0;
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id) ?? 0;
    const y = b.get(id) ?? 0;
    shared += Math.min(x, y);
    union += Math.max(x, y);
  }
  return union > 0 ? shared / union : 1;
}

/**
 * A line (or ordered points): densify, take the best candidate per sample and
 * walk them in order, bridging consecutive samples that land on different
 * segments with a bounded shortest path.
 */
function bindLine(
  coords: LngLat[],
  input: BindInput,
  spine: SpineSubgraph,
  grid: SegmentGrid,
  graph: SegmentGraph,
  onRef: (s: SpineSegment) => boolean,
  maxOffsetM: number,
  spacingM: number,
): BindResult {
  const lengthM = polylineLengthM(coords);
  // Too short to have a trustworthy heading, so the bearing test is skipped.
  const hasBearing = lengthM >= BIND_DEFAULTS.minBearingLengthM;
  const points = densify(coords, spacingM);
  const vetoes = { count: 0 };
  const samples = points.map((point, i) => {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    const bearing = hasBearing ? bearingDeg(prev, next) : null;
    return { point, candidates: candidatesFor(point, bearing, input, grid, maxOffsetM, vetoes) };
  });
  const candidateCount = new Set(
    samples.flatMap((s) => s.candidates.map((c) => c.segment.segmentId)),
  ).size;
  const matched = samples.filter((s) => s.candidates.length > 0);
  if (matched.length === 0) return failure("unresolved", unmatched(vetoes), 0, samples);

  const cap = 1.5 * lengthM + 200;
  const path: SpineSegment[] = [];
  const onPath = new Set<string>();
  const push = (s: SpineSegment): void => {
    if (onPath.has(s.segmentId)) return;
    path.push(s);
    onPath.add(s.segmentId);
  };
  // A sample's best candidate that the path cannot reach (a mainline beside
  // the ramp the line follows) gives way to the segment the path is on while
  // that still explains the sample, then to the best reachable candidate.
  for (const sample of matched) {
    const best = sample.candidates[0]!.segment;
    const last = path[path.length - 1];
    if (!last) {
      push(best);
      continue;
    }
    if (last.segmentId === best.segmentId) continue;
    const bridge = graph.shortestPath(last.segmentId, best.segmentId, cap, onRef);
    if (bridge) {
      for (const s of bridge.slice(1)) push(s);
      continue;
    }
    if (sample.candidates.some((c) => c.segment.segmentId === last.segmentId)) continue;
    let reached: SpineSegment[] | null = null;
    for (const c of sample.candidates.slice(1)) {
      reached = graph.shortestPath(last.segmentId, c.segment.segmentId, cap, onRef);
      if (reached) break;
    }
    if (reached) for (const s of reached.slice(1)) push(s);
    else push(best);
  }

  // Rivals are the segments the chosen path left behind: a neighbour on the
  // same path explains the sample just as well and is not a competitor. The
  // worst ratio and the worst heading margin are tracked separately, so a
  // well-angled rival cannot mask a parallel one at another sample.
  let ambiguity = 0;
  let contested = false;
  let minMarginDeg = Infinity;
  for (const sample of matched) {
    const chosen = sample.candidates[0]!;
    const rivals = sample.candidates.filter(
      (c) => !onPath.has(c.segment.segmentId) && isRival(c, chosen),
    );
    if (rivals.length === 0) continue;
    contested = true;
    // Candidates are score-sorted, so the first rival is the strongest.
    ambiguity = Math.max(ambiguity, rivals[0]!.score / chosen.score);
    const nearestDelta = Math.min(...rivals.map((r) => r.bearingDelta ?? 0));
    minMarginDeg = Math.min(minMarginDeg, nearestDelta - (chosen.bearingDelta ?? 0));
  }

  const { coverage, meanOffsetM } = pathFit(path, points, maxOffsetM);
  // A path near only a sliver of the line follows some other road (one the
  // spine lacks, such as a road under construction), not this one.
  if (coverage < MIN_LINE_COVERAGE) {
    return failure("unresolved", "low_coverage", candidateCount, samples);
  }
  const rs = path.reduce((m, p) => Math.min(m, identityScore(input, p)), 1);
  const twins = new Map<string, SpineSegment>();
  if (!hasBearing) {
    for (const p of path) {
      const twin = spine.segments.find((o) => o.wayId === p.wayId && o.dir !== p.dir);
      if (twin) twins.set(twin.segmentId, twin);
    }
  }

  let directionMode: DirectionMode = twins.size > 0 ? "both" : "single";
  if (directionMode === "single" && contested) {
    // Without a heading the carriageway is a guess; with one it is only
    // decided when the chosen segment fits the heading clearly better than
    // every rival, at every sample.
    const margin = hasBearing ? minMarginDeg : 0;
    if (margin < MIN_BEARING_MARGIN_DEG) directionMode = "unknown";
  }

  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  const segments = spansAlong(path, first, last);
  // A bidirectional way with no usable heading is occupied in both directions.
  for (const twin of twins.values()) segments.push(...spansAlong([twin], last, first));

  const confidence = confidenceOf(
    { coverage, meanOffsetM, identity: rs, directionMode, ambiguity },
    maxOffsetM,
  );
  return {
    status: statusOf(confidence, ambiguity),
    confidence,
    directionMode,
    candidateCount,
    alternativeConfidence: ambiguity > 0 ? ambiguity * confidence : null,
    segments,
    debug: { samples, pathScore: confidence, coverage, meanOffsetM, ambiguity },
  };
}

/** How far a carriageway's heading may lie from a stated heading and still run along it, in degrees. */
const HEADING_TOLERANCE_DEG = 60;
/** How far a drawn line's heading must lie from a stated heading to contradict it, in degrees. */
const HEADING_CONFLICT_DEG = 120;
/** A drawn line shorter than this, in metres, has no order a heading can be read from. */
const MIN_DRAWN_HEADING_M = 5;

const DIRECTION_WEIGHT: Readonly<Record<DirectionMode, number>> = {
  single: 1,
  both: 0.5,
  unknown: 0,
};

/**
 * The heading a shape is drawn in, first point to last. `null` for a point,
 * a line too short to have an order, or one that bends back so far that its
 * ends say little about where it runs.
 */
function drawnHeading(shape: Shape): number | null {
  const coords =
    shape.kind === "endpoints"
      ? [shape.start, shape.end]
      : shape.kind === "line"
        ? shape.coords
        : [];
  if (coords.length < 2) return null;
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  const straightM = polylineLengthM([first, last]);
  if (straightM < MIN_DRAWN_HEADING_M || straightM < 0.5 * polylineLengthM(coords)) return null;
  return bearingDeg(first, last);
}

function anchorOf(shape: Shape): LngLat | undefined {
  switch (shape.kind) {
    case "point":
      return shape.point;
    case "endpoints":
      return shape.start;
    case "line":
      return shape.coords[0];
    default:
      return undefined;
  }
}

/** A binding whose stated direction contradicts its geometry: reported, never bound. */
function conflicting(r: BindResult): BindResult {
  return failure("unresolved", "conflicting_direction", r.candidateCount, r.debug.samples);
}

/** The same binding with another direction mode and spans, rescored for it. */
function redirected(
  r: BindResult,
  directionMode: DirectionMode,
  segments: SegmentSpan[],
  reason?: string,
): BindResult {
  const ambiguity = r.debug.ambiguity ?? 0;
  const raw =
    (r.confidence ?? 0) +
    0.1 * (DIRECTION_WEIGHT[directionMode] - DIRECTION_WEIGHT[r.directionMode]);
  const confidence =
    directionMode === "unknown" ? Math.min(raw, UNKNOWN_DIRECTION_CONFIDENCE) : raw;
  return {
    ...r,
    status: statusOf(confidence, ambiguity),
    confidence,
    directionMode,
    alternativeConfidence: r.alternativeConfidence === null ? null : ambiguity * confidence,
    ...(reason !== undefined ? { reason } : {}),
    segments,
  };
}

/**
 * Holds a binding against the direction its record states. A drawn line or
 * endpoint pair already runs one way; it stays unless a stated heading points
 * the other way, or the record says the opposite of what the location
 * states, and either contradiction is reported instead of bound. Where the
 * geometry has no heading and both directions of a way were bound, a stated
 * heading (or, for a line drawn in the stated order, its own) keeps the
 * carriageway running that way. A single direction that cannot be placed
 * on either carriageway leaves the direction unknown, so routing never
 * closes a guessed side. A direction on an axis nobody identified cannot be
 * placed whatever the geometry, a drawn line's order included.
 */
function oriented(
  r: BindResult,
  travel: TravelDirection | undefined,
  shape: Shape,
  spine: SpineSubgraph,
): BindResult {
  if (travel === undefined || r.segments.length === 0) return r;
  if (travel.kind === "against") return conflicting(r);
  if (travel.kind === "unplaced") {
    return redirected(r, "unknown", r.segments, "direction_undecided");
  }
  if (r.directionMode === "unknown") return r;
  if (r.directionMode === "single") {
    if (travel.kind !== "heading") return r;
    const drawn = drawnHeading(shape);
    return drawn !== null && bearingDelta(drawn, travel.bearingDeg) > HEADING_CONFLICT_DEG
      ? conflicting(r)
      : r;
  }
  const target =
    travel.kind === "heading"
      ? travel.bearingDeg
      : travel.kind === "along"
        ? drawnHeading(shape)
        : null;
  if (target === null) return redirected(r, "unknown", r.segments, "direction_undecided");
  // Where the location starts: each carriageway's heading is read there.
  const at = anchorOf(shape);
  const byId = new Map(spine.segments.map((s) => [s.segmentId, s]));
  const kept = r.segments.filter((span) => {
    const s = byId.get(span.segmentId);
    return (
      at !== undefined &&
      s !== undefined &&
      s.coords.length > 1 &&
      bearingDelta(projectOntoPolyline(at, s.coords).bearing, target) <= HEADING_TOLERANCE_DEG
    );
  });
  // Every way must keep exactly one of its directions; a way none of whose
  // directions runs the stated way says the heading does not fit this road.
  const dirs = new Map<number, Set<string>>();
  for (const span of kept) dirs.set(span.wayId, (dirs.get(span.wayId) ?? new Set()).add(span.dir));
  const decided =
    kept.length > 0 &&
    new Set(r.segments.map((span) => span.wayId)).size === dirs.size &&
    [...dirs.values()].every((d) => d.size === 1);
  return decided
    ? redirected(r, "single", kept)
    : redirected(r, "unknown", r.segments, "direction_undecided");
}

/** Whether a spine segment is a slip road: an OSM `*_link` way. */
function isSlipRoad(s: SpineSegment): boolean {
  return s.highway.endsWith("_link");
}

/**
 * A binding narrowed to the slip roads of its path. The path is found as for
 * any location, over the carriageways too: those tell the ramp apart from its
 * neighbours, and a source draws a ramp's location on into the carriageway it
 * merges with or leaves, through the acceleration or deceleration lane. That
 * carriageway stays open, so only the `*_link` spans are kept, wherever they
 * lie in the path. Confidence is the path's own: the geometry fits it as well
 * as before. A path with no slip road may still have been drawn along one
 * (`drawnOnSlipRoads`), or stop short of the ramp it states
 * (`slipRoadAtJunction`); otherwise it names no ramp this spine has, and binds
 * nothing rather than close the road beside it.
 */
function onSlipRoads(
  r: BindResult,
  input: BindInput,
  spine: SpineSubgraph,
  graph: SegmentGraph,
  opts: BindOptions,
): BindResult {
  if (r.segments.length === 0) return r;
  const slip = new Set(spine.segments.filter(isSlipRoad).map((s) => s.segmentId));
  const segments = r.segments.filter((span) => slip.has(span.segmentId));
  if (segments.length > 0) return { ...r, segments };
  return (
    drawnOnSlipRoads(r, input, spine, opts) ??
    slipRoadAtJunction(r, input.slipRoad, spine, graph) ??
    failure("unresolved", "no_slip_road", r.candidateCount, r.debug.samples)
  );
}

/**
 * A path on the carriageway alone may still have been drawn along a ramp: a
 * ramp beside the carriageway carries no number, so the stated one keeps the
 * path on the carriageway. The location binds to the slip roads alone when
 * it lies nearer to them than to the carriageway path, as a location drawn
 * along the carriageway does not.
 */
function drawnOnSlipRoads(
  r: BindResult,
  input: BindInput,
  spine: SpineSubgraph,
  opts: BindOptions,
): BindResult | null {
  const onCarriageway = r.debug.meanOffsetM;
  if (onCarriageway === null) return null;
  const links = bindEvent(
    { ...input, slipRoadOnly: false },
    { segments: spine.segments.filter(isSlipRoad) },
    opts,
  );
  const onLinks = links.debug.meanOffsetM;
  const routable = links.status === "exact" || links.status === "likely";
  return routable && onLinks !== null && onLinks < onCarriageway ? links : null;
}

/** How far beyond a ramp closure's path its ramp may leave or join the carriageway, in metres. */
const SLIP_ROAD_REACH_M = 150;
/** The stretch bound of a ramp found at its junction: its first (exit) or last (entry) metres. */
const SLIP_ROAD_HEAD_M = 30;
/** A ramp found at its junction rather than along the geometry is at most `likely`. */
const JUNCTION_MAX_CONFIDENCE = 0.89;

/** Slack at the ends of a path when a junction node is read against them, in metres. */
const NODE_SLACK_M = 1;

/**
 * One carriageway segment of a corridor: the stretch `fromM`..`toM` along it
 * belongs to the corridor, and `baseM` is where the segment's start lies,
 * measured from the start of the path.
 */
interface CorridorPart {
  segment: SpineSegment;
  fromM: number;
  toM: number;
  baseM: number;
}

/**
 * The carriageway a ramp of the path may leave or join: the path itself, and
 * on from its end (exit) or back from its start (entry) for up to
 * `SLIP_ROAD_REACH_M`, as long as the carriageway runs on without a fork.
 * Null when a span's segment is not in the spine.
 */
function corridorOf(
  spans: SegmentSpan[],
  slipRoad: "exit" | "entry",
  graph: SegmentGraph,
): { parts: CorridorPart[]; pathM: number } | null {
  const parts: CorridorPart[] = [];
  let pathM = 0;
  for (const s of spans) {
    const segment = graph.byId(s.segmentId);
    if (!segment) return null;
    const lengthM = polylineLengthM(segment.coords);
    const fromM = s.startFraction * lengthM;
    const toM = s.endFraction * lengthM;
    parts.push({ segment, fromM, toM, baseM: pathM - fromM });
    pathM += toM - fromM;
  }
  // A way already in the corridor is not where it runs on: on a two-way road
  // its other direction starts where this one ends.
  const seen = new Set(parts.map((p) => p.segment.wayId));
  const only = (next: SpineSegment[]): SpineSegment | undefined => {
    const carriageway = next.filter((n) => !isSlipRoad(n) && !seen.has(n.wayId));
    return carriageway.length === 1 ? carriageway[0] : undefined;
  };
  if (slipRoad === "exit") {
    const last = parts[parts.length - 1]!;
    last.toM = polylineLengthM(last.segment.coords);
    let at = last.baseM + last.toM;
    let next = only(graph.successors(last.segment.segmentId));
    while (next && at - pathM < SLIP_ROAD_REACH_M) {
      const lengthM = polylineLengthM(next.coords);
      parts.push({ segment: next, fromM: 0, toM: lengthM, baseM: at });
      seen.add(next.wayId);
      at += lengthM;
      next = only(graph.successors(next.segmentId));
    }
  } else {
    const first = parts[0]!;
    first.fromM = 0;
    let at = first.baseM;
    let prev = only(graph.predecessors(first.segment.segmentId));
    while (prev && -at < SLIP_ROAD_REACH_M) {
      const lengthM = polylineLengthM(prev.coords);
      at -= lengthM;
      parts.unshift({ segment: prev, fromM: 0, toM: lengthM, baseM: at });
      seen.add(prev.wayId);
      prev = only(graph.predecessors(prev.segmentId));
    }
  }
  return { parts, pathM };
}

/**
 * A path on the carriageway alone, of a location that states which ramp it
 * closes: an exit's location often ends on the carriageway before the exit,
 * and an entry's starts on it after the merge. The ramp is the one slip road
 * that leaves the carriageway (exit) within the path or up to
 * `SLIP_ROAD_REACH_M` past its end, or joins it (entry) within the path or
 * up to that far before its start. Only its first (exit) or last (entry)
 * metres are bound, so the closure ends before the ramp's first fork. No
 * such ramp, or more than one, binds nothing, and so does a path whose
 * carriageway is not decided.
 */
function slipRoadAtJunction(
  r: BindResult,
  slipRoad: BindInput["slipRoad"],
  spine: SpineSubgraph,
  graph: SegmentGraph,
): BindResult | null {
  if (slipRoad !== "exit" && slipRoad !== "entry") return null;
  if (r.confidence === null || (r.status !== "exact" && r.status !== "likely")) return null;
  // Only a path on one carriageway tells which side its ramps leave or join.
  if (r.directionMode !== "single") return null;
  const corridor = corridorOf(r.segments, slipRoad, graph);
  if (corridor === null) return null;
  const [lo, hi] =
    slipRoad === "exit"
      ? [-NODE_SLACK_M, corridor.pathM + SLIP_ROAD_REACH_M]
      : [-SLIP_ROAD_REACH_M, corridor.pathM + NODE_SLACK_M];
  // The carriageway nodes in the window, each a place a ramp may leave or join.
  const nodes = new Set<string>();
  for (const part of corridor.parts) {
    const coords = part.segment.coords;
    let alongM = 0;
    for (let i = 0; i < coords.length; i++) {
      if (i > 0) alongM += polylineLengthM([coords[i - 1]!, coords[i]!]);
      const at = part.baseM + alongM;
      const inPart = alongM >= part.fromM - NODE_SLACK_M && alongM <= part.toM + NODE_SLACK_M;
      if (inPart && at >= lo && at <= hi) nodes.add(nodeKey(coords[i]!));
    }
  }
  const ramps = spine.segments.filter((s) => {
    if (!isSlipRoad(s) || s.coords.length < 2) return false;
    const end = slipRoad === "exit" ? s.coords[0]! : s.coords[s.coords.length - 1]!;
    return nodes.has(nodeKey(end));
  });
  if (new Set(ramps.map((s) => s.wayId)).size !== 1) return null;
  const ramp = ramps[0]!;
  const head = Math.min(1, SLIP_ROAD_HEAD_M / Math.max(polylineLengthM(ramp.coords), 1));
  const confidence = Math.min(r.confidence, JUNCTION_MAX_CONFIDENCE);
  return {
    ...r,
    status: r.status === "exact" ? "likely" : r.status,
    confidence,
    segments: [slipRoad === "exit" ? span(ramp, 0, head) : span(ramp, 1 - head, 1)],
  };
}

/** Bind one event to the spine: geometry and stated refs in, directed spans out. */
export function bindEvent(
  input: BindInput,
  spine: SpineSubgraph,
  opts: BindOptions = {},
): BindResult {
  const maxOffsetM = opts.maxOffsetM ?? BIND_DEFAULTS.maxOffsetM;
  const spacingM = opts.sampleSpacingM ?? BIND_DEFAULTS.sampleSpacingM;

  if (NOT_APPLICABLE_TYPES.has(input.type)) return failure("not_applicable", "area_type");
  const shape = shapeOf(input.geometry);
  if (!shape) return failure("not_applicable", "polygon_geometry");
  // Checked before the generic polygon branch: a gapped MultiLineString is a
  // real linear location we cannot join, not an area. Its source geometry is
  // still published for display.
  if (shape.kind === "disconnected") return failure("unresolved", "disconnected_geometry");
  if (spine.segments.length > BIND_DEFAULTS.maxSubgraphSegments)
    return failure("unresolved", "subgraph_too_large");

  const graph = new SegmentGraph(spine.segments);
  const grid = new SegmentGrid(spine.segments, maxOffsetM);
  // With a stated number or street name, paths run only over segments it does not contradict.
  const onRef = (s: SpineSegment): boolean => identityScore(input, s) !== 0;

  let result: BindResult;
  if (shape.kind === "point") result = bindPoint(shape.point, input, grid, maxOffsetM);
  else if (shape.kind === "endpoints")
    result = bindEndpoints(shape.start, shape.end, input, grid, graph, onRef, maxOffsetM);
  else if (shape.coords.length === 0) return failure("unresolved", "no_candidates");
  else if (shape.coords.length === 1) result = bindPoint(shape.coords[0]!, input, grid, maxOffsetM);
  else result = bindLine(shape.coords, input, spine, grid, graph, onRef, maxOffsetM, spacingM);
  const placed = oriented(result, input.travel, shape, spine);
  return input.slipRoadOnly ? onSlipRoads(placed, input, spine, graph, opts) : placed;
}
