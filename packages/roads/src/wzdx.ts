import type { Confidence, GeoJsonGeometry } from "@openconditions/core";
import { deriveSeverity } from "@openconditions/core";
import { type RecordSkipReason, recordSkipped } from "@openconditions/ingest-framework";
import {
  WZDX,
  WZDX_LANE_STATUSES,
  WZDX_LANE_TYPES,
  wzdxClassification,
} from "@openconditions/model-roads";
import {
  LANE_STATUSES,
  type LaneStatus,
  type Restriction,
  type RoadEvent,
  type RoadRef,
  type SituationHints,
} from "./model.js";
import { coarseOf, coarseType } from "./situation/classes.js";
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

interface WzdxFeedInfo {
  version?: unknown;
}

interface WzdxFeed {
  type?: string;
  feed_info?: WzdxFeedInfo;
  road_event_feed_info?: WzdxFeedInfo;
  features?: WzdxFeature[];
  [key: string]: unknown;
}

/**
 * Counts the enumerated values the parser met but does not map. The record
 * carrying one is still published, without that value.
 */
interface Unread {
  count: number;
}

const valueSet = (values: readonly string[]) => new Set<string>(values);
const EVENT_TYPES = valueSet(WZDX.eventType);
const VEHICLE_IMPACTS = valueSet(WZDX.vehicleImpact);
const WORK_TYPES = valueSet(WZDX.workTypeName);
const RESTRICTION_TYPES = valueSet(WZDX.restrictionType);
const UNITS = valueSet(WZDX.unitOfMeasurement);
const TIME_VERIFICATIONS = valueSet(WZDX.timeVerification);
const EVENT_STATUSES = valueSet(WZDX.eventStatus);
const WORK_ZONE_TYPES = valueSet(WZDX.workZoneType);
const RELATED_TYPES = valueSet(WZDX.relatedRoadEventType);

/** A string value of an enumeration the parser reads; any other string counts as unread. */
function known(values: ReadonlySet<string>, raw: unknown, unread: Unread): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (values.has(raw)) return raw;
  unread.count++;
  return undefined;
}

const isLaneStatus = (s: string | undefined): s is LaneStatus["status"] =>
  (LANE_STATUSES as readonly (string | undefined)[]).includes(s);

/** A WZDx 4.x `LaneStatus` value as a model lane status, through the WZDx crosswalk. */
function laneStatusOf(raw: string | undefined): LaneStatus["status"] | undefined {
  const status = raw === undefined ? undefined : WZDX_LANE_STATUSES[raw.toLowerCase()];
  return isLaneStatus(status) ? status : undefined;
}

/**
 * WZDx 3.1 `LaneType` values 4.0 dropped, as the 4.x lane type (and, for the
 * ones 3.1 deprecated in favour of a lane `status`, the status) its 3.1
 * definition names. A lane's position is its `order`, so the left, right,
 * middle and centre lanes are general lanes; a "second" exit or entrance ramp
 * becomes the exit or entrance lane 3.1 tells producers to use instead; the
 * right merging lane tapers into the lane to its left (`merge-left`) and the
 * left one into the lane to its right. The turning lanes and the HOV lane
 * have no 4.x type, and 3.1 does not say which occupancy an HOV lane needs, so
 * they stay unread.
 */
const LEGACY_LANE_TYPES: Readonly<Record<string, { type: string; status?: string }>> = {
  lane: { type: "general" },
  "left-lane": { type: "general" },
  "right-lane": { type: "general" },
  "middle-lane": { type: "general" },
  "center-lane": { type: "general" },
  "right-shoulder": { type: "shoulder" },
  "left-shoulder": { type: "shoulder" },
  "right-exit-lane": { type: "exit-lane" },
  "left-exit-lane": { type: "exit-lane" },
  "right-second-exit-ramp": { type: "exit-lane" },
  "left-second-exit-ramp": { type: "exit-lane" },
  "right-exit-ramp": { type: "exit-ramp" },
  "left-exit-ramp": { type: "exit-ramp" },
  "right-entrance-lane": { type: "entrance-lane" },
  "left-entrance-lane": { type: "entrance-lane" },
  "right-second-entrance-ramp": { type: "entrance-lane" },
  "left-second-entrance-ramp": { type: "entrance-lane" },
  "right-entrance-ramp": { type: "entrance-ramp" },
  "left-entrance-ramp": { type: "entrance-ramp" },
  "right-merging-lane": { type: "general", status: "merge-left" },
  "left-merging-lane": { type: "general", status: "merge-right" },
  "alternating-flow-lane": { type: "general", status: "alternating-flow" },
  "reversible-lane": { type: "general", status: "alternating-flow" },
};

/**
 * A lane's 4.x type and status. A 3.1 type that carried a status the lane's
 * own `status` leaves `open` supplies it.
 */
function laneTypeAndStatus(
  lane: WzdxLane,
  unread: Unread,
): { type?: string; status: string | undefined } {
  const raw = typeof lane.type === "string" ? lane.type : undefined;
  const status = typeof lane.status === "string" ? lane.status : undefined;
  if (raw === undefined) return { status };
  if (raw in WZDX_LANE_TYPES) return { type: raw, status };
  const legacy = LEGACY_LANE_TYPES[raw];
  if (legacy === undefined) {
    unread.count++;
    return { status };
  }
  return {
    type: legacy.type,
    status:
      legacy.status !== undefined && status?.toLowerCase() === "open" ? legacy.status : status,
  };
}

function parseLanes(
  rawLanes: WzdxLane[] | undefined,
  unread: Unread,
): {
  laneStatuses: LaneStatus[];
  closed: number;
  total: number;
} {
  if (!Array.isArray(rawLanes) || rawLanes.length === 0) {
    return { laneStatuses: [], closed: 0, total: 0 };
  }

  let closed = 0;
  let total = 0;
  const laneStatuses: LaneStatus[] = [];

  for (const lane of rawLanes) {
    total++;
    if (!lane || typeof lane !== "object") continue;
    const { type, status: rawStatus } = laneTypeAndStatus(lane, unread);
    const status = laneStatusOf(rawStatus);
    // A lane whose status is outside the spec still counts towards the total,
    // but nothing is said about it rather than guessing it open.
    if (status === undefined) {
      if (rawStatus !== undefined) unread.count++;
      continue;
    }
    // A merging lane tapers into its neighbour and ends, so like a closed lane
    // it carries no traffic through the work zone.
    if (status === "closed" || status === "merge_left" || status === "merge_right") closed++;

    const laneRestrictions = parseRestrictions(lane.restrictions, unread);
    laneStatuses.push({
      index: lane.order ?? total,
      status,
      ...(type !== undefined ? { type } : {}),
      ...(laneRestrictions ? { restrictions: laneRestrictions } : {}),
    });
  }

  return { laneStatuses, closed, total };
}

/**
 * A work zone's `WorkZoneType`: `planned-moving-area`, the planned extent of a
 * moving operation somewhere within it, is the model's `area`.
 */
function workZoneTypeOf(raw: unknown, unread: Unread): RoadEvent["workZoneType"] | undefined {
  const type = known(WORK_ZONE_TYPES, raw, unread);
  if (type === "planned-moving-area") return "area";
  return type === "static" || type === "moving" ? type : undefined;
}

/**
 * The lifecycle a deprecated `event_status` declares. `planned` (estimated
 * during planning) and `pending` (scheduled for the near future) both say the
 * work zone is not yet in place, the model's `planned`; `completed` ends it.
 * Without one, its dates decide.
 */
function lifecycleOf(
  raw: unknown,
  unread: Unread,
): { status: RoadEvent["status"]; validityStatus?: SituationHints["validityStatus"] } {
  switch (known(EVENT_STATUSES, raw, unread)) {
    case "planned":
    case "pending":
      return { status: "active", validityStatus: "planned" };
    case "completed":
      return { status: "archived" };
    case "cancelled":
      return { status: "cancelled" };
    default:
      return { status: "active" };
  }
}

function vehicleImpactToRoadState(
  vehicleImpact: string | undefined,
): RoadEvent["roadState"] | undefined {
  switch (vehicleImpact) {
    case "all-lanes-closed":
      return "closed";
    case "some-lanes-closed":
    case "some-lanes-closed-merge-left":
    case "some-lanes-closed-merge-right":
    case "some-lanes-closed-split":
      return "some_lanes_closed";
    case "alternating-one-way":
      return "single_lane_alternating";
    case "all-lanes-open":
    case "all-lanes-open-shift-left":
    case "all-lanes-open-shift-right":
      return "open";
    // `flagging` and `temporary-traffic-signal` name the traffic control, not
    // which lanes stay open; they and `unknown` leave the road state to the
    // lane data.
    default:
      return undefined;
  }
}

function parseRoads(coreDetails: WzdxCoreDetails, props: WzdxProperties): RoadRef[] {
  const names = Array.isArray(coreDetails.road_names) ? coreDetails.road_names : [];
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

/**
 * A road or lane's `Restriction` list. A type or unit outside the standard is
 * kept as the source gave it, so the restriction still shows as evidence, and
 * counted as unread.
 */
function parseRestrictions(
  raw: WzdxRestriction[] | undefined,
  unread: Unread,
): Restriction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Restriction[] = [];
  for (const r of raw) {
    if (r && typeof r.type === "string") {
      known(RESTRICTION_TYPES, r.type, unread);
      const item: Restriction = { type: r.type };
      if (typeof r.value === "number") item.value = r.value;
      if (typeof r.unit === "string") {
        known(UNITS, r.unit, unread);
        item.unit = r.unit;
      }
      out.push(item);
    }
  }
  return out.length > 0 ? out : undefined;
}

function relatedOf(coreDetails: WzdxCoreDetails): WzdxRelatedEvent[] {
  return Array.isArray(coreDetails.related_road_events)
    ? coreDetails.related_road_events.filter(
        (r): r is WzdxRelatedEvent => !!r && typeof r.id === "string",
      )
    : [];
}

function relatedIdsOf(coreDetails: WzdxCoreDetails): string[] | undefined {
  const ids = relatedOf(coreDetails).map((r) => r.id as string);
  return ids.length > 0 ? ids : undefined;
}

function relatedEventsOf(
  coreDetails: WzdxCoreDetails,
  unread: Unread,
): { id: string; type?: string }[] | undefined {
  const events = relatedOf(coreDetails).map((r) => {
    const type = known(RELATED_TYPES, r.type, unread);
    return { id: r.id as string, ...(type !== undefined ? { type } : {}) };
  });
  return events.length > 0 ? events : undefined;
}

/**
 * The event's certainty from whether its start was verified: a verified start
 * (`is_start_date_verified`, or the deprecated `start_date_accuracy` of
 * `verified`) was observed in the field, an `estimated` one is likely.
 * `worker_presence.confidence` qualifies only `are_workers_present`, never the
 * work zone itself, so it is not read as the event's certainty.
 */
function confidenceFrom(props: WzdxProperties, unread: Unread): Confidence | undefined {
  const accuracy = known(TIME_VERIFICATIONS, props.start_date_accuracy, unread);
  if (props.is_start_date_verified === true || accuracy === "verified") return "observed";
  if (accuracy === "estimated") return "likely";
  return undefined;
}

/** The v3 property names that v4 moved into the `core_details` sub-object. */
const V3_CORE_KEYS = [
  "data_source_id",
  "event_type",
  "road_names",
  "direction",
  "description",
  "name",
  "creation_date",
  "update_date",
  "id",
  "related_road_events",
] as const;

/** A 3.1 `LaneRestriction` (`restriction_type`, `restriction_value`, `restriction_units`) as a 4.x `Restriction`. */
function liftLaneRestriction(r: unknown): unknown {
  if (!r || typeof r !== "object") return r;
  const v3 = r as Record<string, unknown>;
  if (v3["type"] !== undefined || v3["restriction_type"] === undefined) return r;
  return {
    type: v3["restriction_type"],
    ...(v3["restriction_value"] !== undefined ? { value: v3["restriction_value"] } : {}),
    ...(v3["restriction_units"] !== undefined ? { unit: v3["restriction_units"] } : {}),
  };
}

/**
 * Normalise a WZDx 3.1 feature's properties into the v4 shape.
 *
 * v3 puts the core fields directly on `properties`; v4 groups them under
 * `core_details`. Feeding a v3 body to the v4 mapping unchanged silently yields
 * events with no event type at all — Québec City's 493 work zones all landed as
 * `other` — so the lift happens before the mapping rather than by relaxing the
 * version gate. The other 3.1 shapes 4.0 replaced are lifted too:
 *
 * - `restrictions` is a list of `RoadRestriction` flags, not of objects;
 * - a lane restriction is a `LaneRestriction` (`restriction_type`, ...);
 * - `workers_present` is a bare flag, not a `worker_presence` object;
 * - the deprecated `road_name` and `road_number` stand in for `road_names`;
 * - lanes may still carry the `alternating-one-way` status 3.1 deprecated in
 *   favour of `alternating-flow`, which v4 removed.
 *
 * 3.1's `reduced_speed_limit` states no unit (4.0 replaced it with
 * `reduced_speed_limit_kph`), so it stays unread. A body that already has
 * `core_details` is returned untouched.
 */
function liftV3Properties(props: WzdxProperties): WzdxProperties {
  if (props.core_details) return props;
  const hasV3Core = V3_CORE_KEYS.some((k) => props[k] !== undefined);
  if (!hasV3Core) return props;

  const core: WzdxCoreDetails = {};
  for (const key of V3_CORE_KEYS) {
    if (props[key] !== undefined) (core as Record<string, unknown>)[key] = props[key];
  }
  if (!Array.isArray(core.road_names) || core.road_names.length === 0) {
    const legacy = [props["road_number"], props["road_name"]].filter(
      (n): n is string => typeof n === "string" && n.length > 0,
    );
    if (legacy.length > 0) core.road_names = [...new Set(legacy)];
  }
  const lanes = Array.isArray(props.lanes)
    ? props.lanes.map((lane) => {
        if (!lane || typeof lane !== "object") return lane;
        const status =
          lane.status?.toLowerCase() === "alternating-one-way" ? "alternating-flow" : lane.status;
        return {
          ...lane,
          ...(status !== undefined ? { status } : {}),
          ...(Array.isArray(lane.restrictions)
            ? { restrictions: lane.restrictions.map(liftLaneRestriction) as WzdxRestriction[] }
            : {}),
        };
      })
    : props.lanes;
  const restrictions = Array.isArray(props.restrictions)
    ? (props.restrictions as unknown[]).map((r) => (typeof r === "string" ? { type: r } : r))
    : props.restrictions;
  const workersPresent = props["workers_present"];
  return {
    ...props,
    core_details: core,
    ...(lanes !== undefined ? { lanes } : {}),
    ...(restrictions !== undefined ? { restrictions: restrictions as WzdxRestriction[] } : {}),
    ...(props.worker_presence === undefined && typeof workersPresent === "boolean"
      ? { worker_presence: { are_workers_present: workersPresent } }
      : {}),
  };
}

/**
 * One event per road event id, the one updated last. A WZDx feed publishes
 * each direction of travel (its first business rule) and each occurrence of a
 * recurring work zone as a road event of its own, often over the same stretch
 * of road with the same description, so events are never folded by place or
 * text: only a road event published twice under its id is one.
 */
function latestById(events: RoadEvent[]): RoadEvent[] {
  const byId = new Map<string, RoadEvent>();
  for (const event of events) {
    const seen = byId.get(event.id);
    if (!seen || Date.parse(event.dataUpdatedAt) > Date.parse(seen.dataUpdatedAt)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()];
}

/**
 * The version a feed declares, when the parser does not read it. WZDx 3.1 and
 * 4.x are read (3.1 through {@link liftV3Properties}); so is CWZ 1.x, the
 * standard WZDx became, which publishes the 4.2 WorkZoneFeed shape under
 * `feed_info`. WZDx 1.x to 3.0 also declared their version, under
 * `road_event_feed_info`, in shapes the lift does not cover. A feed that
 * declares no version is read by its shape.
 */
function unreadVersion(feed: WzdxFeed): string | undefined {
  const raw = (feed.feed_info ?? feed.road_event_feed_info)?.version;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const version = String(raw).trim();
  if (/^4(\.\d+)*$/.test(version) || /^3\.1(\.\d+)*$/.test(version)) return undefined;
  if (feed.feed_info !== undefined && /^1(\.\d+)*$/.test(version)) return undefined;
  return version;
}

/**
 * Parse a WZDx v3.1 or v4.x WorkZoneFeed or v4.0 RoadRestrictionFeed (GeoJSON
 * FeatureCollection) and return an array of RoadEvent observations. Severity
 * is always derived from vehicle_impact and lane data.
 *
 * What is left out is counted per source: a feed in a version the parser does
 * not read (`unsupported_version`), a feature with no geometry
 * (`no_geometry`), one without the required `event_type` or that cannot be
 * read (`malformed`), and one whose `event_type` is not a WZDx road event type
 * (`unknown_type`). An enumerated value outside the standard is left out of
 * the event that carries it and counted as `unknown_value`.
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

  const features = feed?.features;
  if (!Array.isArray(features) || features.length === 0) return [];

  const version = unreadVersion(feed);
  if (version !== undefined) {
    console.warn(`[wzdx] ${src.id}: WZDx version ${version} is not read; skipping the feed`);
    recordSkipped(src.id, "unsupported_version", features.length);
    return [];
  }

  const out: RoadEvent[] = [];
  const skipped: Partial<Record<RecordSkipReason, number>> = {};
  const skip = (reason: RecordSkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const unread: Unread = { count: 0 };
  let localCounter = 0;

  for (const feature of features) {
    try {
      if (!feature || typeof feature !== "object") {
        skip("malformed");
        continue;
      }
      const geometry = feature.geometry ?? null;
      if (!geometry || typeof geometry !== "object" || !("type" in geometry)) {
        skip("no_geometry");
        continue;
      }
      if (!feature.properties || typeof feature.properties !== "object") {
        skip("malformed");
        continue;
      }

      const props = liftV3Properties(feature.properties);
      const coreDetails = props.core_details ?? {};
      const eventType = coreDetails.event_type;
      if (typeof eventType !== "string" || eventType === "") {
        skip("malformed");
        continue;
      }
      if (!EVENT_TYPES.has(eventType)) {
        skip("unknown_type");
        continue;
      }

      const typesOfWork = (Array.isArray(props.types_of_work) ? props.types_of_work : [])
        .map((w) => w?.type_name)
        .filter((n): n is string => typeof n === "string");
      for (const name of typesOfWork) known(WORK_TYPES, name, unread);
      const classification = wzdxClassification(
        eventType,
        typesOfWork,
        (Array.isArray(props.restrictions) ? props.restrictions : [])
          .map((r) => (r as { type?: unknown })?.type)
          .filter((t): t is string => typeof t === "string"),
      );
      // A detour road event is never a situation of its own: it stays a detour
      // for the assembler to attach to the situation it serves.
      const { type, category, isPlanned } =
        eventType === "detour" ? coarseType("detour") : coarseOf(classification);

      const vehicleImpact =
        typeof props.vehicle_impact === "string" ? props.vehicle_impact : undefined;
      known(VEHICLE_IMPACTS, vehicleImpact, unread);
      const roadState = vehicleImpactToRoadState(vehicleImpact);

      const { laneStatuses, closed, total } = parseLanes(props.lanes, unread);

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
          : typeof props["road_event_id"] === "string"
            ? props["road_event_id"]
            : `wzdx-${localCounter}`);
      const dataSourceId = coreDetails.data_source_id;
      const featureId = dataSourceId != null ? `${dataSourceId}:${rawId}` : rawId;

      const roads = parseRoads(coreDetails, props);
      const recordTime =
        (typeof coreDetails.update_date === "string" && coreDetails.update_date) ||
        (typeof coreDetails.creation_date === "string" && coreDetails.creation_date) ||
        undefined;
      const hasDescription =
        typeof coreDetails.description === "string" && !!coreDetails.description;
      const lifecycle = lifecycleOf(props.event_status, unread);
      const workersPresent = props.worker_presence?.are_workers_present;

      out.push({
        id: `${src.id}:${featureId}`,
        source: src.id,
        sourceFormat: "wzdx",
        domain: "roads",
        kind: "event",
        situation: {
          ...(classification !== undefined ? { classification } : {}),
          ...(recordTime !== undefined ? { sourceUpdatedAt: recordTime } : {}),
          ...(hasDescription ? {} : { headlineFromSource: false as const }),
          ...(lifecycle.validityStatus !== undefined
            ? { validityStatus: lifecycle.validityStatus }
            : {}),
        },
        type,
        subtype: typesOfWork[0] ?? eventType,
        category,
        isPlanned,
        severity,
        severitySource: "derived",
        status: lifecycle.status,
        geometry: geometry as GeoJsonGeometry,
        direction: typeof coreDetails.direction === "string" ? coreDetails.direction : undefined,
        roads,
        roadState: derivedRoadState,
        lanesAffected,
        speedLimitKph:
          typeof props.reduced_speed_limit_kph === "number"
            ? props.reduced_speed_limit_kph
            : undefined,
        restrictions: parseRestrictions(props.restrictions, unread),
        workersPresent: typeof workersPresent === "boolean" ? workersPresent : undefined,
        workZoneType: workZoneTypeOf(props.work_zone_type, unread),
        ...(typeof coreDetails.name === "string" && coreDetails.name
          ? { label: coreDetails.name }
          : {}),
        relatedIds: relatedIdsOf(coreDetails),
        relatedEvents: relatedEventsOf(coreDetails, unread),
        confidence: confidenceFrom(props, unread),
        sourceRaw: feature.properties as Record<string, unknown>,
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
      skip("malformed");
    }
  }

  // Counted per source so the loss shows up in GET /feeds/status.
  for (const [reason, count] of Object.entries(skipped) as [RecordSkipReason, number][]) {
    console.debug(`[wzdx] ${src.id}: skipped ${count} feature(s): ${reason}`);
    recordSkipped(src.id, reason, count);
  }
  recordSkipped(src.id, "unknown_value", unread.count);

  return latestById(out);
}
