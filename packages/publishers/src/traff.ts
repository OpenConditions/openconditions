import type { ConditionEvent } from "@openconditions/core";
import { XMLBuilder } from "fast-xml-parser";
import { type FeedInfo, type RoadFields, roadFields } from "./types.js";

/**
 * TraFF (Traffic Feed Format) v0.8 emitter — the strategic interop format that
 * lets the FOSS nav ecosystem (CoMaps, Navit) consume OpenConditions.
 * Spec: https://traffxml.gitlab.io/. Each condition becomes one `<message>`
 * carrying its semantic event (INCIDENT/CONSTRUCTION/HAZARD/…) plus, when it
 * also restricts traffic, a routing-actionable RESTRICTION event (TraFF's
 * cause+effect multi-event model). Coordinates are "lat lon", space-separated.
 */

interface TraffEventCode {
  cls: string;
  type: string;
}

/** Primary (semantic) TraFF event code per canonical road type. */
const PRIMARY: Record<string, TraffEventCode> = {
  accident: { cls: "INCIDENT", type: "INCIDENT_ACCIDENT" },
  broken_down_vehicle: { cls: "INCIDENT", type: "INCIDENT_BROKEN_DOWN_VEHICLE" },
  roadworks: { cls: "CONSTRUCTION", type: "CONSTRUCTION_ROADWORKS" },
  congestion: { cls: "CONGESTION", type: "CONGESTION_TRAFFIC_CONGESTION" },
  hazard: { cls: "HAZARD", type: "HAZARD_HAZARD" },
  obstruction: { cls: "HAZARD", type: "HAZARD_OBSTRUCTION" },
  road_condition: { cls: "HAZARD", type: "HAZARD_HAZARD" },
  weather: { cls: "HAZARD", type: "HAZARD_HAZARD" },
  public_event: { cls: "ACTIVITY", type: "ACTIVITY_EVENT" },
  authority: { cls: "AUTHORITY", type: "AUTHORITY_CHECKPOINT" },
  security: { cls: "SECURITY", type: "SECURITY_ALERT" },
  speed_restriction: { cls: "RESTRICTION", type: "RESTRICTION_SPEED_LIMIT" },
  road_closure: { cls: "RESTRICTION", type: "RESTRICTION_CLOSED" },
  lane_closure: { cls: "RESTRICTION", type: "RESTRICTION_LANE_CLOSED" },
  contraflow: { cls: "RESTRICTION", type: "RESTRICTION_CONTRAFLOW" },
};

const MAX_BY_RESTRICTION: Record<string, string> = {
  height: "RESTRICTION_MAX_HEIGHT",
  width: "RESTRICTION_MAX_WIDTH",
  length: "RESTRICTION_MAX_LENGTH",
  weight: "RESTRICTION_MAX_WEIGHT",
};

function restrictionFromRoadState(rs: RoadFields["roadState"]): TraffEventCode | undefined {
  if (rs === "closed") return { cls: "RESTRICTION", type: "RESTRICTION_CLOSED" };
  if (rs === "some_lanes_closed") return { cls: "RESTRICTION", type: "RESTRICTION_LANE_CLOSED" };
  if (rs === "single_lane_alternating")
    return { cls: "RESTRICTION", type: "RESTRICTION_CONTRAFLOW" };
  return undefined;
}

/**
 * The TraFF events for a condition: the semantic primary, plus a RESTRICTION
 * "effect" event when the road state restricts traffic (so nav consumers, which
 * route on RESTRICTION/CONGESTION/DELAY, still act on it). Falls back to a
 * generic congestion event when nothing else applies.
 */
export function traffEvents(ev: ConditionEvent): TraffEventCode[] {
  const rf = roadFields(ev);
  const out: TraffEventCode[] = [];
  let primary = PRIMARY[ev.type];
  if (ev.type === "dimension_restriction") {
    const t = rf.restrictions?.[0]?.type;
    primary = {
      cls: "RESTRICTION",
      type: (t && MAX_BY_RESTRICTION[t]) ?? "RESTRICTION_MAX_WEIGHT",
    };
  }
  if (primary) out.push(primary);
  const effect = restrictionFromRoadState(rf.roadState);
  if (effect && !out.some((e) => e.type === effect.type)) out.push(effect);
  if (out.length === 0) out.push({ cls: "CONGESTION", type: "CONGESTION_TRAFFIC_CONGESTION" });
  return out;
}

function urgencyOf(severity: ConditionEvent["severity"]): string {
  if (severity === "critical") return "X_URGENT";
  if (severity === "high") return "URGENT";
  return "NORMAL";
}

const ROAD_CLASSES = new Set(["MOTORWAY", "TRUNK", "PRIMARY", "SECONDARY", "TERTIARY", "OTHER"]);

function mapRoadClass(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const up = raw.toUpperCase();
  return ROAD_CLASSES.has(up) ? up : undefined;
}

/** Signed decimal with explicit "+" for non-negatives, matching the TraFF examples. */
function fmtNum(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function coordText(lonLat: [number, number]): string {
  return `${fmtNum(lonLat[1])} ${fmtNum(lonLat[0])}`; // TraFF order is "lat lon"
}

function positions(geometry: ConditionEvent["geometry"]): [number, number][] {
  const out: [number, number][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) walk(x);
  };
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] };
  if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) {
    for (const sub of g.geometries) out.push(...positions(sub as ConditionEvent["geometry"]));
  } else {
    walk(g.coordinates);
  }
  return out;
}

function buildEvents(ev: ConditionEvent, rf: RoadFields): unknown {
  const events = traffEvents(ev).map((c, i) => {
    const e: Record<string, unknown> = { "@_class": c.cls, "@_type": c.type };
    // Quantifiers + diversion go on the primary event.
    if (i === 0) {
      if (rf.speedLimitKph != null) e["@_speed"] = Math.round(rf.speedLimitKph);
      if (rf.queueLengthMeters != null) e["@_length"] = Math.round(rf.queueLengthMeters);
      if (rf.detour) {
        e["supplementary_info"] = { "@_class": "DIVERSION", "@_type": "S_DIVERSION_IN_OPERATION" };
      }
    }
    return e;
  });
  return { event: events.length === 1 ? events[0] : events };
}

function buildLocation(ev: ConditionEvent, rf: RoadFields): Record<string, unknown> {
  const road = rf.roads?.[0];
  const loc: Record<string, unknown> = {};
  if (road?.name) loc["@_road_name"] = road.name;
  if (road?.ref) loc["@_road_ref"] = road.ref;
  const rc = mapRoadClass(road?.roadClass);
  if (rc) loc["@_road_class"] = rc;
  const direction = road?.direction ?? rf.direction;
  if (direction) loc["@_direction"] = direction;

  const pts = positions(ev.geometry);
  if (ev.geometry.type === "LineString" && pts.length >= 2) {
    loc["@_directionality"] = "ONE_DIRECTION"; // ordered from→to implies one direction
    const from: Record<string, unknown> = { "#text": coordText(pts[0]!) };
    if (road?.from) from["@_junction_name"] = road.from;
    if (road?.milepostFrom != null) from["@_distance"] = road.milepostFrom;
    const to: Record<string, unknown> = { "#text": coordText(pts[pts.length - 1]!) };
    if (road?.to) to["@_junction_name"] = road.to;
    if (road?.milepostTo != null) to["@_distance"] = road.milepostTo;
    loc["from"] = from;
    loc["to"] = to;
  } else if (pts.length > 0) {
    loc["at"] = coordText(pts[0]!);
  }
  return loc;
}

function buildMessage(ev: ConditionEvent): Record<string, unknown> {
  const rf = roadFields(ev);
  const expiration = ev.expiresAt ?? ev.validTo ?? undefined;
  return {
    "@_id": ev.id,
    "@_receive_time": ev.dataUpdatedAt ?? ev.fetchedAt,
    "@_update_time": ev.dataUpdatedAt ?? ev.fetchedAt,
    "@_urgency": urgencyOf(ev.severity),
    ...(expiration ? { "@_expiration_time": expiration } : {}),
    ...(ev.validFrom ? { "@_start_time": ev.validFrom } : {}),
    ...(ev.validTo ? { "@_end_time": ev.validTo } : {}),
    ...(ev.isForecast ? { "@_forecast": "true" } : {}),
    events: buildEvents(ev, rf),
    location: buildLocation(ev, rf),
  };
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

/**
 * Projects road condition events to a TraFF v0.8 `<feed>` XML document. Each
 * event becomes one `<message>` (semantic event + optional RESTRICTION effect)
 * with a coordinate-based `<location>`. `info` is accepted for symmetry but
 * TraFF carries no feed-level attribution element (credit travels via HTTP
 * headers + the source license).
 */
export function observationsToTraff(events: ConditionEvent[], _info: FeedInfo = {}): string {
  const doc = { feed: { message: events.map(buildMessage) } };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}`;
}
