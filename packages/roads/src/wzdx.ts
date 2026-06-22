import { deriveSeverity } from "@openconditions/core";
import type { GeoJsonGeometry } from "@openconditions/core";
import type { LaneStatus, RoadEvent, RoadRef } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
import { mapSourceType } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";

interface WzdxLane {
  order?: number;
  status?: string;
  type?: string;
}

interface WzdxCoreDetails {
  data_source_id?: string;
  event_type?: string;
  road_names?: string[];
  direction?: string;
  description?: string;
  update_date?: string;
  id?: string;
}

interface WzdxProperties {
  core_details?: WzdxCoreDetails;
  vehicle_impact?: string;
  start_date?: string;
  end_date?: string;
  lanes?: WzdxLane[];
  beginning_milepost?: number;
  ending_milepost?: number;
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

    laneStatuses.push({
      index: lane.order ?? total,
      status,
      ...(lane.type != null ? { type: lane.type } : {}),
    });
  }

  return { laneStatuses, closed, total };
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

function parseRoads(coreDetails: WzdxCoreDetails): RoadRef[] {
  const names = coreDetails.road_names ?? [];
  if (names.length === 0) return [];

  return names.map((name) => {
    const ref: RoadRef = { name };
    if (coreDetails.direction != null) ref.direction = coreDetails.direction;
    return ref;
  });
}

/**
 * Parse a WZDx v4.x WorkZoneFeed (GeoJSON FeatureCollection) and return an
 * array of RoadEvent observations. Features lacking geometry are skipped.
 * Severity is always derived from vehicle_impact and lane data.
 */
export function parseWzdx(geojson: string | object, src: SourceDescriptor): RoadEvent[] {
  let feed: WzdxFeed;
  try {
    feed = (typeof geojson === "string" ? JSON.parse(geojson) : geojson) as WzdxFeed;
  } catch (err) {
    console.warn("[wzdx] failed to parse JSON input:", err);
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

      const roads = parseRoads(coreDetails);

      out.push({
        id: `${src.id}:${featureId}`,
        source: src.id,
        sourceFormat: "wzdx",
        domain: "roads",
        kind: "event",
        type,
        subtype: eventType || undefined,
        category,
        isPlanned,
        severity,
        severitySource: "derived",
        status: "active",
        geometry: geometry as GeoJsonGeometry,
        direction: typeof coreDetails.direction === "string" ? coreDetails.direction : undefined,
        roads,
        roadState: derivedRoadState,
        lanesAffected,
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
          typeof coreDetails.update_date === "string" && coreDetails.update_date
            ? coreDetails.update_date
            : new Date().toISOString(),
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
