import { deriveSeverity } from "@openconditions/core";
import type { GeoJsonGeometry } from "@openconditions/core";
import type { Confidence } from "@openconditions/core";
import type { LaneStatus, Restriction, RoadEvent, RoadRef } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
import { mapSourceType } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";

interface WzdxLane {
  order?: number;
  status?: string;
  type?: string;
  restrictions?: WzdxRestriction[];
}

interface WzdxTypeOfWork {
  type_name?: string;
}

interface WzdxWorkerPresence {
  are_workers_present?: boolean;
  confidence?: string;
}

interface WzdxRelatedEvent {
  id?: string;
  type?: string;
}

interface WzdxCoreDetails {
  data_source_id?: string;
  event_type?: string;
  road_names?: string[];
  direction?: string;
  description?: string;
  name?: string;
  creation_date?: string;
  update_date?: string;
  id?: string;
  related_road_events?: WzdxRelatedEvent[];
}

interface WzdxRestriction {
  type?: string;
  value?: number;
  unit?: string;
}

interface WzdxProperties {
  core_details?: WzdxCoreDetails;
  vehicle_impact?: string;
  start_date?: string;
  end_date?: string;
  is_start_date_verified?: boolean;
  start_date_accuracy?: string;
  lanes?: WzdxLane[];
  beginning_milepost?: number;
  ending_milepost?: number;
  beginning_cross_street?: string;
  ending_cross_street?: string;
  reduced_speed_limit_kph?: number;
  restrictions?: WzdxRestriction[];
  types_of_work?: WzdxTypeOfWork[];
  worker_presence?: WzdxWorkerPresence;
  work_zone_type?: string;
  event_status?: string;
  [key: string]: unknown;
}

interface WzdxFeature {
  id?: string;
  type?: string;
  properties?: WzdxProperties;
  geometry?: GeoJsonGeometry | null;
}

interface WzdxFeed {
  type?: string;
  features?: WzdxFeature[];
  [key: string]: unknown;
}

function parseLanes(rawLanes: WzdxLane[] | undefined): {
  laneStatuses: LaneStatus[];
  closed: number;
  total: number;
} {
  if (!rawLanes || rawLanes.length === 0) {
    return { laneStatuses: [], closed: 0, total: 0 };
  }

  let closed = 0;
  let total = 0;
  const laneStatuses: LaneStatus[] = [];

  for (const lane of rawLanes) {
    total++;
    const rawStatus = (lane.status ?? "").toLowerCase();
    let status: LaneStatus["status"] = "open";
    if (rawStatus === "closed") {
      status = "closed";
      closed++;
    } else if (rawStatus === "alternating-one-way" || rawStatus === "alternating") {
      status = "alternating";
    }

    const laneRestrictions = parseRestrictions(lane.restrictions);
    laneStatuses.push({
      index: lane.order ?? total,
      status,
      ...(lane.type != null ? { type: lane.type } : {}),
      ...(laneRestrictions ? { restrictions: laneRestrictions } : {}),
    });
  }

  return { laneStatuses, closed, total };
}

function workZoneTypeOf(raw: unknown): RoadEvent["workZoneType"] | undefined {
  return raw === "static" || raw === "moving" || raw === "area" ? raw : undefined;
}

function statusFromEventStatus(raw: string | undefined): RoadEvent["status"] {
  switch (raw) {
    case "completed":
      return "archived";
    case "cancelled":
      return "cancelled";
    default:
      return "active";
  }
}

function vehicleImpactToRoadState(
  vehicleImpact: string | undefined
): RoadEvent["roadState"] | undefined {
  switch (vehicleImpact) {
    case "all-lanes-closed":
      return "closed";
    case "some-lanes-closed":
      return "some_lanes_closed";
    case "alternating-one-way":
      return "single_lane_alternating";
    case "all-lanes-open":
      return "open";
    default:
      return undefined;
  }
}

function parseRoads(coreDetails: WzdxCoreDetails, props: WzdxProperties): RoadRef[] {
  const names = coreDetails.road_names ?? [];
  if (names.length === 0) return [];

  return names.map((name) => {
    const ref: RoadRef = { name };
    if (coreDetails.direction != null) ref.direction = coreDetails.direction;
    if (typeof props.beginning_cross_street === "string") ref.from = props.beginning_cross_street;
    if (typeof props.ending_cross_street === "string") ref.to = props.ending_cross_street;
    if (typeof props.beginning_milepost === "number") ref.milepostFrom = props.beginning_milepost;
    if (typeof props.ending_milepost === "number") ref.milepostTo = props.ending_milepost;
    return ref;
  });
}

function parseRestrictions(raw: WzdxRestriction[] | undefined): Restriction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Restriction[] = [];
  for (const r of raw) {
    if (r && typeof r.type === "string") {
      const item: Restriction = { type: r.type };
      if (typeof r.value === "number") item.value = r.value;
      if (typeof r.unit === "string") item.unit = r.unit;
      out.push(item);
    }
  }
  return out.length > 0 ? out : undefined;
}

function relatedIdsOf(coreDetails: WzdxCoreDetails): string[] | undefined {
  const ids = (coreDetails.related_road_events ?? [])
    .map((r) => r?.id)
    .filter((id): id is string => typeof id === "string");
  return ids.length > 0 ? ids : undefined;
}

function relatedEventsOf(
  coreDetails: WzdxCoreDetails
): { id: string; type?: string }[] | undefined {
  const events = (coreDetails.related_road_events ?? [])
    .filter((r): r is WzdxRelatedEvent => !!r && typeof r.id === "string")
    .map((r) => ({
      id: r.id as string,
      ...(typeof r.type === "string" ? { type: r.type } : {}),
    }));
  return events.length > 0 ? events : undefined;
}

/**
 * Derive a confidence from WZDx date-verification signals. The verified/estimated
 * date accuracy is the primary signal (a directly observed vs. inferred event);
 * worker-presence "low" is a weaker fallback when no date signal is present.
 */
function confidenceFrom(props: WzdxProperties): Confidence | undefined {
  if (props.is_start_date_verified === true || props.start_date_accuracy === "verified") {
    return "observed";
  }
  if (props.start_date_accuracy === "estimated") {
    return "likely";
  }
  if (props.worker_presence?.confidence === "low") {
    return "possible";
  }
  return undefined;
}

/**
 * Parse a WZDx v4.x WorkZoneFeed (GeoJSON FeatureCollection) and return an
 * array of RoadEvent observations. Features lacking geometry are skipped.
 * Severity is always derived from vehicle_impact and lane data.
 */
export function parseWzdx(geojson: string | Buffer | object, src: SourceDescriptor): RoadEvent[] {
  let feed: WzdxFeed;
  try {
    const str = Buffer.isBuffer(geojson) ? geojson.toString("utf8") : geojson;
    if (typeof str === "string") {
      // A feed that returns an HTML block/login/error page with a 2xx isn't JSON;
      // skip cleanly instead of letting JSON.parse throw a noisy SyntaxError.
      if (str.trimStart().startsWith("<")) {
        console.warn(`[wzdx] ${src.id}: feed returned HTML, not JSON; skipping`);
        return [];
      }
      feed = JSON.parse(str) as WzdxFeed;
    } else {
      feed = str as WzdxFeed;
    }
  } catch (err) {
    console.warn(`[wzdx] ${src.id}: failed to parse JSON input:`, err);
    return [];
  }

  const features = feed.features;
  if (!Array.isArray(features) || features.length === 0) return [];

  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;
  let localCounter = 0;

  for (const feature of features) {
    try {
      const geometry = feature.geometry ?? null;
      if (!geometry || typeof geometry !== "object" || !("type" in geometry)) {
        skippedNoGeometry++;
        continue;
      }

      const props = feature.properties ?? {};
      const coreDetails = props.core_details ?? {};
      const eventType = typeof coreDetails.event_type === "string" ? coreDetails.event_type : "";
      const { type, category, isPlanned } = mapSourceType("wzdx", eventType);

      const vehicleImpact =
        typeof props.vehicle_impact === "string" ? props.vehicle_impact : undefined;
      const roadState = vehicleImpactToRoadState(vehicleImpact);

      const { laneStatuses, closed, total } = parseLanes(props.lanes);

      let derivedRoadState = roadState;
      if (derivedRoadState === "open") {
        derivedRoadState = undefined;
      }

      const severity = deriveSeverity({
        roadState: derivedRoadState,
        lanesAffected: total > 0 ? { closed, total } : undefined,
      });

      const lanesAffected: RoadEvent["lanesAffected"] =
        vehicleImpact != null || laneStatuses.length > 0
          ? {
              ...(total > 0 ? { total, closed } : {}),
              ...(laneStatuses.length > 0 ? { lanes: laneStatuses } : {}),
              ...(vehicleImpact != null ? { vehicleImpact } : {}),
            }
          : undefined;

      localCounter++;
      const rawId =
        coreDetails.id ??
        (typeof feature.id === "string" || typeof feature.id === "number"
          ? String(feature.id)
          : `wzdx-${localCounter}`);
      const dataSourceId = coreDetails.data_source_id;
      const featureId = dataSourceId != null ? `${dataSourceId}:${rawId}` : rawId;

      const roads = parseRoads(coreDetails, props);

      out.push({
        id: `${src.id}:${featureId}`,
        source: src.id,
        sourceFormat: "wzdx",
        domain: "roads",
        kind: "event",
        type,
        subtype: props.types_of_work?.[0]?.type_name ?? (eventType || undefined),
        category,
        isPlanned,
        severity,
        severitySource: "derived",
        status: statusFromEventStatus(
          typeof props.event_status === "string" ? props.event_status : undefined
        ),
        geometry: geometry as GeoJsonGeometry,
        direction: typeof coreDetails.direction === "string" ? coreDetails.direction : undefined,
        roads,
        roadState: derivedRoadState,
        lanesAffected,
        speedLimitKph:
          typeof props.reduced_speed_limit_kph === "number"
            ? props.reduced_speed_limit_kph
            : undefined,
        restrictions: parseRestrictions(props.restrictions),
        workersPresent: props.worker_presence?.are_workers_present === true ? true : undefined,
        workZoneType: workZoneTypeOf(props.work_zone_type),
        ...(typeof coreDetails.name === "string" && coreDetails.name
          ? { label: coreDetails.name }
          : {}),
        relatedIds: relatedIdsOf(coreDetails),
        relatedEvents: relatedEventsOf(coreDetails),
        confidence: confidenceFrom(props),
        sourceRaw: props as Record<string, unknown>,
        headline:
          typeof coreDetails.description === "string" && coreDetails.description
            ? coreDetails.description
            : type,
        description:
          typeof coreDetails.description === "string" ? coreDetails.description : undefined,
        validFrom:
          typeof props.start_date === "string" && props.start_date ? props.start_date : null,
        validTo: typeof props.end_date === "string" && props.end_date ? props.end_date : null,
        origin: {
          kind: "feed",
          attribution: {
            provider: src.attribution,
            license: src.license,
            url: src.licenseUrl,
          },
        },
        dataUpdatedAt:
          (typeof coreDetails.update_date === "string" && coreDetails.update_date) ||
          (typeof coreDetails.creation_date === "string" && coreDetails.creation_date) ||
          new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        isStale: false,
      });
    } catch (err) {
      console.warn("[wzdx] skipped malformed feature:", feature?.id, err);
    }
  }

  if (skippedNoGeometry > 0) {
    console.debug(`[wzdx] skipped ${skippedNoGeometry} feature(s) with no usable geometry`);
  }

  return dedupeRoadEvents(out);
}
