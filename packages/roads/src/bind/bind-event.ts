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

import type { Geometry, LineString, MultiLineString, MultiPoint, Point } from "geojson";
import type { BindingStatus, DirectionMode, SegmentSpan } from "@openconditions/core";
import {
  bearingDeg,
  bearingDelta,
  densify,
  polylineLengthM,
  projectOntoPolyline,
  type LngLat,
} from "./geo.js";
import { nodeKey, SegmentGraph } from "./graph.js";
import { normalizeRefs, refScore } from "./refs.js";
import { scoreCandidate } from "./score.js";
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

/** Event types that describe an area or a non-road subject and never bind to a carriageway. */
export const NOT_APPLICABLE_TYPES: ReadonlySet<string> = new Set([
  "weather",
  "public_event",
  "authority",
  "security",
  "transit_disruption",
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
  direction?: string;
  roadState?: string;
}): BindInput {
  const refs = normalizeRefs((ev.roads ?? []).flatMap((r) => [r.ref, r.name]));
  return {
    id: ev.id,
    geometry: ev.geometry,
    type: ev.type,
    refs,
    ...(ev.direction ? { direction: ev.direction } : {}),
    ...(ev.roadState ? { roadState: ev.roadState } : {}),
  };
}

type Shape =
  | { kind: "point"; point: LngLat }
  | { kind: "line"; coords: LngLat[] }
  | { kind: "endpoints"; start: LngLat; end: LngLat };

/** Reduce GeoJSON to the three shapes the resolver understands; areas return null. */
function shapeOf(g: Geometry): Shape | null {
  switch (g.type) {
    case "Point":
      return { kind: "point", point: (g as Point).coordinates as LngLat };
    case "LineString":
      return { kind: "line", coords: (g as LineString).coordinates as LngLat[] };
    case "MultiLineString":
      return { kind: "line", coords: (g as MultiLineString).coordinates.flat() as LngLat[] };
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
 * when the event's own ref picked the winner: matching refs, two mismatches or
 * a refless event all leave the choice open, so the candidate stays a rival.
 */
function isRival(c: Candidate, chosen: Candidate): boolean {
  return (
    c.segment.wayId !== chosen.segment.wayId &&
    !nodeAdjacent(c.segment, chosen.segment) &&
    chosen.refScore <= c.refScore
  );
}

/** Every spine segment within `maxOffsetM` of `p` that survives scoring, best first. */
function candidatesFor(
  p: LngLat,
  bearing: number | null,
  input: BindInput,
  segments: SpineSegment[],
  maxOffsetM: number
): Candidate[] {
  const out: Candidate[] = [];
  for (const s of segments) {
    if (s.coords.length === 0) continue;
    const pr = projectOntoPolyline(p, s.coords);
    if (pr.offsetM > maxOffsetM) continue;
    const delta = bearing == null ? null : bearingDelta(bearing, pr.bearing);
    const rs = refScore(input.refs, s.ref);
    const score = scoreCandidate(
      { offsetM: pr.offsetM, bearingDelta: delta, refScore: rs, highway: s.highway },
      maxOffsetM
    );
    // Only a heading beyond 90° scores 0, and that means the wrong carriageway.
    if (score <= 0) continue;
    out.push({
      segment: s,
      offsetM: pr.offsetM,
      fraction: pr.fraction,
      bearingDelta: delta,
      refScore: rs,
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score);
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
    span(s, i === 0 ? fractionOn(s, start) : 0, i === path.length - 1 ? fractionOn(s, end) : 1)
  );
}

/** Share of samples the path explains, and their mean offset from it. */
function pathFit(
  path: SpineSegment[],
  samples: LngLat[],
  maxOffsetM: number
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
    refScore: number;
    directionMode: DirectionMode;
    ambiguity: number;
  },
  maxOffsetM: number
): number {
  const direction = a.directionMode === "single" ? 1 : a.directionMode === "both" ? 0.5 : 0;
  const raw =
    0.4 * a.coverage +
    0.2 * (1 - a.meanOffsetM / maxOffsetM) +
    0.2 * a.refScore +
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

function statusOf(confidence: number, ambiguity: number): BindingStatus {
  if (confidence >= 0.9 && ambiguity < EXACT_MAX_AMBIGUITY) return "exact";
  if (confidence >= 0.7 && ambiguity < LIKELY_MAX_AMBIGUITY) return "likely";
  return "ambiguous";
}

function failure(
  status: BindingStatus,
  reason: string,
  candidateCount = 0,
  samples: BindDebug["samples"] = []
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
  spine: SpineSubgraph,
  maxOffsetM: number
): BindResult {
  const candidates = candidatesFor(point, null, input, spine.segments, maxOffsetM);
  const samples = [{ point, candidates }];
  if (candidates.length === 0) return failure("unresolved", "no_candidates", 0, samples);

  const best = candidates[0]!;
  const twin = candidates.find(
    (c) => c.segment.wayId === best.segment.wayId && c.segment.dir !== best.segment.dir
  );
  const rival = candidates.find((c) => isRival(c, best));
  const ambiguity = rival ? rival.score / best.score : 0;
  const directionMode: DirectionMode = twin ? "both" : rival ? "unknown" : "single";

  const segments = [best, ...(twin ? [twin] : [])].map((c) =>
    span(c.segment, c.fraction, c.fraction)
  );
  const confidence = confidenceOf(
    { coverage: 1, meanOffsetM: best.offsetM, refScore: best.refScore, directionMode, ambiguity },
    maxOffsetM
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
  spine: SpineSubgraph,
  graph: SegmentGraph,
  onRef: (s: SpineSegment) => boolean,
  maxOffsetM: number
): BindResult {
  const straightM = polylineLengthM([start, end]);
  const cap = Math.min(MAX_ENDPOINT_PATH_M, 2.5 * straightM + 500);
  const starts = candidatesFor(start, null, input, spine.segments, maxOffsetM).slice(
    0,
    ENDPOINT_CANDIDATES
  );
  const ends = candidatesFor(end, null, input, spine.segments, maxOffsetM).slice(
    0,
    ENDPOINT_CANDIDATES
  );
  const samples = [
    { point: start, candidates: starts },
    { point: end, candidates: ends },
  ];
  const candidateCount = starts.length + ends.length;
  if (starts.length === 0 || ends.length === 0)
    return failure("unresolved", "no_candidates", candidateCount, samples);

  const routes: EndpointRoute[] = [];
  for (const s of starts) {
    for (const e of ends) {
      const path = graph.shortestPath(s.segment.segmentId, e.segment.segmentId, cap, onRef);
      if (!path) continue;
      const rs = path.reduce((m, p) => Math.min(m, refScore(input.refs, p.ref)), 1);
      const score = ((s.score + e.score) / 2) * (0.8 + 0.2 * rs);
      routes.push({ path, score, refScore: rs, from: s, to: e });
    }
  }
  const best = routes.reduce<EndpointRoute | null>(
    (m, r) => (!m || r.score > m.score ? r : m),
    null
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
    { coverage: 1, meanOffsetM, refScore: best.refScore, directionMode: "single", ambiguity },
    maxOffsetM
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
  refScore: number;
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
    ])
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
  graph: SegmentGraph,
  onRef: (s: SpineSegment) => boolean,
  maxOffsetM: number,
  spacingM: number
): BindResult {
  const lengthM = polylineLengthM(coords);
  // Too short to have a trustworthy heading, so the bearing test is skipped.
  const hasBearing = lengthM >= BIND_DEFAULTS.minBearingLengthM;
  const points = densify(coords, spacingM);
  const samples = points.map((point, i) => {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    const bearing = hasBearing ? bearingDeg(prev, next) : null;
    return { point, candidates: candidatesFor(point, bearing, input, spine.segments, maxOffsetM) };
  });
  const candidateCount = new Set(
    samples.flatMap((s) => s.candidates.map((c) => c.segment.segmentId))
  ).size;
  const matched = samples.filter((s) => s.candidates.length > 0);
  if (matched.length === 0) return failure("unresolved", "no_candidates", 0, samples);

  const cap = 1.5 * lengthM + 200;
  const path: SpineSegment[] = [];
  const onPath = new Set<string>();
  const push = (s: SpineSegment): void => {
    if (onPath.has(s.segmentId)) return;
    path.push(s);
    onPath.add(s.segmentId);
  };
  for (const sample of matched) {
    const best = sample.candidates[0]!.segment;
    const last = path[path.length - 1];
    if (!last) {
      push(best);
      continue;
    }
    if (last.segmentId === best.segmentId) continue;
    const bridge = graph.shortestPath(last.segmentId, best.segmentId, cap, onRef);
    if (bridge) for (const s of bridge.slice(1)) push(s);
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
      (c) => !onPath.has(c.segment.segmentId) && isRival(c, chosen)
    );
    if (rivals.length === 0) continue;
    contested = true;
    // Candidates are score-sorted, so the first rival is the strongest.
    ambiguity = Math.max(ambiguity, rivals[0]!.score / chosen.score);
    const nearestDelta = Math.min(...rivals.map((r) => r.bearingDelta ?? 0));
    minMarginDeg = Math.min(minMarginDeg, nearestDelta - (chosen.bearingDelta ?? 0));
  }

  const { coverage, meanOffsetM } = pathFit(path, points, maxOffsetM);
  const rs = path.reduce((m, p) => Math.min(m, refScore(input.refs, p.ref)), 1);
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
    { coverage, meanOffsetM, refScore: rs, directionMode, ambiguity },
    maxOffsetM
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

/** Bind one event to the spine: geometry and stated refs in, directed spans out. */
export function bindEvent(
  input: BindInput,
  spine: SpineSubgraph,
  opts: BindOptions = {}
): BindResult {
  const maxOffsetM = opts.maxOffsetM ?? BIND_DEFAULTS.maxOffsetM;
  const spacingM = opts.sampleSpacingM ?? BIND_DEFAULTS.sampleSpacingM;

  if (NOT_APPLICABLE_TYPES.has(input.type)) return failure("not_applicable", "area_type");
  const shape = shapeOf(input.geometry);
  if (!shape) return failure("not_applicable", "polygon_geometry");
  if (spine.segments.length > BIND_DEFAULTS.maxSubgraphSegments)
    return failure("unresolved", "subgraph_too_large");

  const graph = new SegmentGraph(spine.segments);
  // With a stated ref, paths may only run over segments that match it.
  const onRef = (s: SpineSegment): boolean =>
    input.refs.length === 0 || refScore(input.refs, s.ref) !== 0;

  if (shape.kind === "point") return bindPoint(shape.point, input, spine, maxOffsetM);
  if (shape.kind === "endpoints")
    return bindEndpoints(shape.start, shape.end, input, spine, graph, onRef, maxOffsetM);
  if (shape.coords.length === 0) return failure("unresolved", "no_candidates");
  if (shape.coords.length === 1) return bindPoint(shape.coords[0]!, input, spine, maxOffsetM);
  return bindLine(shape.coords, input, spine, graph, onRef, maxOffsetM, spacingM);
}
