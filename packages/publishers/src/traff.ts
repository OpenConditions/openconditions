import type { ConditionEvent } from "@openconditions/core";
import { XMLBuilder } from "fast-xml-parser";
import { type FeedInfo, roadFields } from "./types.js";

/**
 * TraFF (Traffic Feed Format) emitter — the strategic interop format that lets
 * the FOSS nav ecosystem (CoMaps, Navit) consume OpenConditions.
 * Spec: https://traffxml.gitlab.io/ (v0.8). Event codes follow Navit's
 * implemented subset (CONGESTION / DELAY / RESTRICTION), since those are the
 * classes consumers actually route on; we therefore map each condition to its
 * routing-relevant code rather than to a semantically-pure code a consumer
 * would ignore. Coordinates are "lat lon" (latitude first), space-separated.
 */

type TraffClass = "CONGESTION" | "RESTRICTION";

interface TraffEventCode {
  cls: TraffClass;
  type: string;
}

/** Map a road condition to the most routing-relevant confirmed TraFF/Navit code. */
export function toTraffEventCode(ev: ConditionEvent): TraffEventCode {
  const rf = roadFields(ev);
  const t = ev.type;
  const rs = rf.roadState;

  if (rs === "closed" || t === "road_closure")
    return { cls: "RESTRICTION", type: "RESTRICTION_CLOSED" };
  if (rs === "some_lanes_closed" || t === "lane_closure")
    return { cls: "RESTRICTION", type: "RESTRICTION_LANE_CLOSED" };
  if (t === "contraflow" || rs === "single_lane_alternating")
    return { cls: "RESTRICTION", type: "RESTRICTION_CONTRAFLOW" };
  if (t === "congestion") return { cls: "CONGESTION", type: "CONGESTION_TRAFFIC_CONGESTION" };
  if (t === "roadworks") return { cls: "RESTRICTION", type: "RESTRICTION_REDUCED_LANES" };
  if (
    t === "accident" ||
    t === "broken_down_vehicle" ||
    t === "obstruction" ||
    t === "hazard" ||
    t === "security"
  )
    return { cls: "RESTRICTION", type: "RESTRICTION_BLOCKED" };
  if (ev.category === "incident") return { cls: "RESTRICTION", type: "RESTRICTION_BLOCKED" };
  if (ev.category === "planned") return { cls: "RESTRICTION", type: "RESTRICTION_REDUCED_LANES" };
  return { cls: "CONGESTION", type: "CONGESTION_TRAFFIC_CONGESTION" };
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

function locationChildren(geometry: ConditionEvent["geometry"]): Record<string, string> {
  const pts = positions(geometry);
  if (pts.length === 0) return {};
  if (geometry.type === "LineString" && pts.length >= 2) {
    return { from: coordText(pts[0]!), to: coordText(pts[pts.length - 1]!) };
  }
  return { at: coordText(pts[0]!) };
}

function buildMessage(ev: ConditionEvent): Record<string, unknown> {
  const rf = roadFields(ev);
  const road = rf.roads?.[0];
  const code = toTraffEventCode(ev);
  const expiration = ev.expiresAt ?? ev.validTo ?? undefined;

  const locationAttrs: Record<string, string> = {};
  if (road?.name) locationAttrs["@_road_name"] = road.name;
  if (road?.ref) locationAttrs["@_road_ref"] = road.ref;
  const rc = mapRoadClass(road?.roadClass);
  if (rc) locationAttrs["@_road_class"] = rc;
  const direction = road?.direction ?? rf.direction;
  if (direction) locationAttrs["@_direction"] = direction;

  return {
    "@_id": ev.id,
    "@_receive_time": ev.dataUpdatedAt ?? ev.fetchedAt,
    "@_update_time": ev.dataUpdatedAt ?? ev.fetchedAt,
    ...(expiration ? { "@_expiration_time": expiration } : {}),
    ...(ev.validFrom ? { "@_start_time": ev.validFrom } : {}),
    ...(ev.validTo ? { "@_end_time": ev.validTo } : {}),
    ...(ev.isForecast ? { "@_forecast": "true" } : {}),
    events: { event: { "@_class": code.cls, "@_type": code.type } },
    location: { ...locationAttrs, ...locationChildren(ev.geometry) },
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
 * event becomes one `<message>` with a single `<event>` and a coordinate-based
 * `<location>`. `info` is accepted for symmetry but TraFF carries no feed-level
 * attribution element (credit travels via HTTP headers + the source license).
 */
export function observationsToTraff(events: ConditionEvent[], _info: FeedInfo = {}): string {
  const doc = { feed: { message: events.map(buildMessage) } };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}`;
}
