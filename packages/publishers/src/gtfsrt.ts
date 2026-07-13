import type { ConditionEvent, Measurement } from "@openconditions/core";
import { observedKey } from "@openconditions/core";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { roadFields } from "./types.js";

/**
 * GTFS-RT Service Alert emitter — projects condition events to a protobuf
 * `FeedMessage` of `Alert`s so transit engines (OpenTripPlanner, MOTIS,
 * OneBusAway-style apps) can consume OpenConditions. Spec:
 * https://gtfs.org/realtime/reference/#message-alert. Uses the official
 * `gtfs-realtime-bindings`. GTFS-RT carries no geometry, so a condition's
 * location surfaces only via transit `informed_entity` selectors derived from
 * its `subject` refs and its `informed` transit hints. A GTFS-RT Alert is
 * scoped to a GTFS dataset, so an event is emitted ONLY IF it resolves to at
 * least one concrete transit selector; an event with none (e.g. a plain road
 * accident) is EXCLUDED entirely — never emitted as a selector-less,
 * network-wide alert. This gate is domain-aware by construction: a road-domain
 * event that genuinely affects transit (carries `informed.routes` etc.) is
 * emitted with those selectors, while a transit-domain event with no resolvable
 * selector is also dropped (an entity-less transit alert is meaningless).
 *
 * The selector ids are passed through as-is: no GTFS dataset is configured in
 * this repo (road-only today), so per-dataset id validation against a static
 * feed is deferred until a GTFS dataset is wired.
 */

const { transit_realtime } = GtfsRealtimeBindings;
const { Alert, FeedHeader, VehiclePosition } = transit_realtime;
const { OccupancyStatus } = VehiclePosition;

export interface GtfsRtAlertCodes {
  cause: number;
  effect: number;
  severity: number;
}

/** Map a condition event to GTFS-RT `Alert` cause × effect × severity. */
export function toGtfsRtAlertCodes(ev: ConditionEvent): GtfsRtAlertCodes {
  return { cause: causeOf(ev), effect: effectOf(ev), severity: severityOf(ev) };
}

function causeOf(ev: ConditionEvent): number {
  switch (ev.type) {
    case "accident":
      return Alert.Cause.ACCIDENT;
    case "roadworks":
      return Alert.Cause.CONSTRUCTION;
    case "weather":
    case "road_condition":
      return Alert.Cause.WEATHER;
    case "equipment_fault":
      return Alert.Cause.TECHNICAL_PROBLEM;
    case "authority":
    case "security":
      return Alert.Cause.POLICE_ACTIVITY;
    default:
      return Alert.Cause.OTHER_CAUSE;
  }
}

function effectOf(ev: ConditionEvent): number {
  const rs = roadFields(ev).roadState;
  const t = ev.type;
  if (rs === "closed" || t === "road_closure" || t === "detour") return Alert.Effect.DETOUR;
  if (rs === "some_lanes_closed" || t === "lane_closure") return Alert.Effect.SIGNIFICANT_DELAYS;
  if (t === "congestion") return Alert.Effect.SIGNIFICANT_DELAYS;
  if (t === "roadworks") return Alert.Effect.MODIFIED_SERVICE;
  if (t === "transit_disruption") return Alert.Effect.REDUCED_SERVICE;
  return Alert.Effect.OTHER_EFFECT;
}

function severityOf(ev: ConditionEvent): number {
  switch (ev.severity) {
    case "low":
      return Alert.SeverityLevel.INFO;
    case "medium":
      return Alert.SeverityLevel.WARNING;
    case "high":
    case "critical":
      return Alert.SeverityLevel.SEVERE;
    default:
      return Alert.SeverityLevel.UNKNOWN_SEVERITY;
  }
}

function toEpochSeconds(t: string | number | null | undefined): number | undefined {
  if (t == null) return undefined;
  if (typeof t === "number") return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function translated(
  text: string | undefined
): GtfsRealtimeBindings.transit_realtime.ITranslatedString | undefined {
  return text ? { translation: [{ text, language: "en" }] } : undefined;
}

/**
 * GTFS `route_type` for a coarse transit mode string (extended values folded to
 * their base type). An unknown mode maps to `undefined` and is skipped rather
 * than emitting a bogus selector.
 */
const ROUTE_TYPE_BY_MODE: Record<string, number> = {
  tram: 0,
  streetcar: 0,
  lightrail: 0,
  subway: 1,
  metro: 1,
  rail: 2,
  bus: 3,
  ferry: 4,
  cablecar: 5,
  cable_tram: 5,
  aerial: 6,
  gondola: 6,
  funicular: 7,
  trolleybus: 11,
  monorail: 12,
};

/**
 * Concrete transit `informed_entity` selectors for an event, built from BOTH
 * its `subject` refs (gtfs-stop/route/trip) and its `informed` hints
 * (stops/routes/trips/modes). Identical selectors are deduped. Returns an empty
 * array when the event resolves to no transit entity — the caller then excludes
 * it from the feed rather than emitting a selector-less, network-wide alert.
 */
function informedEntities(
  ev: ConditionEvent
): GtfsRealtimeBindings.transit_realtime.IEntitySelector[] {
  type Selector = GtfsRealtimeBindings.transit_realtime.IEntitySelector;
  // An empty/whitespace-only concrete id matches no entity — skip it rather than
  // emit noise like {routeId:""}.
  const clean = (id: string | undefined): string | undefined => {
    const t = id?.trim();
    return t ? t : undefined;
  };
  const sels: Selector[] = [];
  for (const s of ev.subject ?? []) {
    const id = clean(s.id);
    if (!id) continue;
    if (s.type === "gtfs-stop") sels.push({ stopId: id });
    else if (s.type === "gtfs-route") sels.push({ routeId: id });
    else if (s.type === "gtfs-trip") sels.push({ trip: { tripId: id } });
  }
  const informed = ev.informed;
  if (informed) {
    for (const raw of informed.stops ?? []) {
      const stopId = clean(raw);
      if (stopId) sels.push({ stopId });
    }
    for (const raw of informed.routes ?? []) {
      const routeId = clean(raw);
      if (routeId) sels.push({ routeId });
    }
    for (const raw of informed.trips ?? []) {
      const tripId = clean(raw);
      if (tripId) sels.push({ trip: { tripId } });
    }
    for (const mode of informed.modes ?? []) {
      const routeType = ROUTE_TYPE_BY_MODE[mode.trim().toLowerCase()];
      if (routeType != null) sels.push({ routeType });
    }
  }
  const seen = new Set<string>();
  return sels.filter((sel) => {
    const key = JSON.stringify(sel);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function activePeriod(
  ev: ConditionEvent
): GtfsRealtimeBindings.transit_realtime.ITimeRange[] | undefined {
  const start = toEpochSeconds(ev.validFrom);
  const end = toEpochSeconds(ev.validTo ?? ev.expiresAt);
  if (start == null && end == null) return undefined;
  const range: GtfsRealtimeBindings.transit_realtime.ITimeRange = {};
  if (start != null) range.start = start;
  if (end != null) range.end = end;
  return [range];
}

function toEntity(ev: ConditionEvent): GtfsRealtimeBindings.transit_realtime.IFeedEntity | null {
  const informedEntity = informedEntities(ev);
  // A GTFS-RT Alert is dataset-scoped: with no concrete transit selector the
  // event does not belong in this feed (and must never become a feed-wide one).
  if (informedEntity.length === 0) return null;
  const { cause, effect, severity } = toGtfsRtAlertCodes(ev);
  const alert: GtfsRealtimeBindings.transit_realtime.IAlert = {
    cause,
    effect,
    severityLevel: severity,
    informedEntity,
  };
  const period = activePeriod(ev);
  if (period) alert.activePeriod = period;
  const header = translated(ev.headline);
  if (header) {
    alert.headerText = header;
    alert.ttsHeaderText = header; // plain text, safe to speak verbatim
  }
  const description = translated(ev.description);
  if (description) {
    alert.descriptionText = description;
    alert.ttsDescriptionText = description;
  }
  const url = translated(ev.origin.attribution.url);
  if (url) alert.url = url;
  // Free-text refinements of the coarse cause/effect enums.
  const causeDetail = translated(ev.subtype);
  if (causeDetail) alert.causeDetail = causeDetail;
  const effectDetail = translated((ev as { detour?: string }).detour);
  if (effectDetail) alert.effectDetail = effectDetail;
  return { id: ev.id, alert };
}

/**
 * Projects condition events to an encoded GTFS-RT `FeedMessage` (a FULL_DATASET
 * of service alerts). `timestamp` (ISO string or epoch seconds) sets the feed
 * header time; pass it in — the projection is pure.
 */
export function observationsToGtfsRtAlerts(
  events: ConditionEvent[],
  opts: { timestamp?: string | number } = {}
): Uint8Array {
  const ts = toEpochSeconds(opts.timestamp);
  const message: GtfsRealtimeBindings.transit_realtime.IFeedMessage = {
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: FeedHeader.Incrementality.FULL_DATASET,
      ...(ts != null ? { timestamp: ts } : {}),
    },
    entity: events
      .map(toEntity)
      .filter((e): e is GtfsRealtimeBindings.transit_realtime.IFeedEntity => e !== null),
  };
  const err = transit_realtime.FeedMessage.verify(message);
  if (err) throw new Error(`invalid GTFS-RT FeedMessage: ${err}`);
  return transit_realtime.FeedMessage.encode(message).finish();
}

/** Trim an id; an empty/whitespace-only value resolves to no concrete entity. */
function cleanId(id: string | undefined): string | undefined {
  const t = id?.trim();
  return t ? t : undefined;
}

/**
 * Read one runtime attribute off a Measurement, tolerating BOTH shapes the
 * attribute can arrive in:
 *  - top-level, the canonical reconstructed-model form: `readObservations`
 *    spreads the `attributes` JSONB back onto the observation (same convention
 *    `roadFields` relies on), so a DB-served measurement carries `vehicleId` /
 *    `stopSequence` as top-level keys;
 *  - nested under `attributes`, the pre-write parser form (the write path reads
 *    `o.attributes`).
 * Top-level wins when both are present (it is the post-read canonical value).
 */
function readAttr(m: Measurement, key: string): unknown {
  const record = m as unknown as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  const nested = record.attributes;
  if (nested != null && typeof nested === "object" && !Array.isArray(nested)) {
    return (nested as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Resolve a `transit/occupancy` `level` string to its GTFS-RT `OccupancyStatus`
 * enum int, or `undefined` when it is not one of the nine enum names. The
 * binding's enum object is the sole source of truth (forward name→int lookup),
 * so no int is hardcoded; a numeric-looking string ("5") reverse-maps to a name
 * (a string), so it is rejected — only the enum NAMES qualify.
 */
function occupancyStatusInt(level: string | undefined): number | undefined {
  if (level == null) return undefined;
  const v = OccupancyStatus[level as keyof typeof OccupancyStatus];
  return typeof v === "number" ? v : undefined;
}

/**
 * Project one `transit/occupancy` Measurement to a GTFS-RT `FeedEntity`, or
 * `null` when it does not resolve to a concrete transit entity.
 *
 * The concrete-entity gate is binding: occupancy is emitted ONLY for a concrete
 * trip+vehicle (a VehiclePosition) or a concrete trip+stop_sequence (a
 * TripUpdate StopTimeUpdate). A measurement that resolves to only a route or
 * only a stop — an aggregate — is EXCLUDED; it is never forced into a
 * VehiclePosition (aggregates belong on STA/SIRI surfaces per the plan).
 *
 *  - VehiclePosition (primary): a `gtfs-trip` subject supplies `tripId`; the
 *    vehicle id comes from `attributes.vehicleId`, falling back to a `subject`
 *    whose `role === "vehicle"`. Preferred whenever a vehicle id is available.
 *  - TripUpdate: a `gtfs-trip` subject plus a non-negative integer
 *    `attributes.stopSequence` (and no vehicle id) → a StopTimeUpdate carrying
 *    `departureOccupancyStatus` (the only occupancy field GTFS-RT defines on a
 *    StopTimeUpdate; used for NO_DATA / predicted stop-time occupancy).
 *  - A bare trip with neither a vehicle id nor a stop_sequence has no valid
 *    GTFS-RT occupancy carrier, so it is EXCLUDED.
 *
 * Trip/vehicle ids pass through un-validated: no GTFS static dataset is
 * configured in this repo (road-only today, same as the Alert emitter), so
 * per-dataset id validation against a feed is deferred until one is wired.
 */
function toOccupancyEntity(
  m: Measurement
): GtfsRealtimeBindings.transit_realtime.IFeedEntity | null {
  if (observedKey(m) !== "transit/occupancy") return null;
  const occupancyStatus = occupancyStatusInt(m.level);
  if (occupancyStatus === undefined) return null;
  const tripId = cleanId(m.subject?.find((s) => s.type === "gtfs-trip")?.id);
  // No concrete trip (route/stop-only aggregate, or nothing) → not this feed.
  if (!tripId) return null;
  const rawVehicleId = readAttr(m, "vehicleId");
  const vehicleId =
    cleanId(typeof rawVehicleId === "string" ? rawVehicleId : undefined) ??
    cleanId(m.subject?.find((s) => s.role === "vehicle")?.id);
  const timestamp = toEpochSeconds(m.dataUpdatedAt);
  if (vehicleId) {
    const vehicle: GtfsRealtimeBindings.transit_realtime.IVehiclePosition = {
      trip: { tripId },
      vehicle: { id: vehicleId },
      occupancyStatus,
      ...(timestamp != null ? { timestamp } : {}),
    };
    return { id: m.id, vehicle };
  }
  const stopSequence = readAttr(m, "stopSequence");
  if (typeof stopSequence === "number" && Number.isInteger(stopSequence) && stopSequence >= 0) {
    const tripUpdate: GtfsRealtimeBindings.transit_realtime.ITripUpdate = {
      trip: { tripId },
      stopTimeUpdate: [{ stopSequence, departureOccupancyStatus: occupancyStatus }],
    };
    return { id: m.id, tripUpdate };
  }
  return null;
}

/**
 * GTFS-RT OccupancyStatus emitter — projects `transit/occupancy` Measurements to
 * an encoded `FeedMessage` (a FULL_DATASET). A pure projection: `timestamp` (ISO
 * string or epoch seconds) sets the feed header time; per-vehicle time comes
 * from each measurement's `dataUpdatedAt`.
 *
 * Occupancy is EXPERIMENTAL in GTFS-RT; this emits it, it does not architect
 * around it. Only concrete-entity occupancy is emitted (see
 * {@link toOccupancyEntity}): a trip+vehicle VehiclePosition or a
 * trip+stop_sequence TripUpdate, never a route/stop aggregate. A measurement
 * whose `level` is not one of the nine OccupancyStatus enum names is excluded
 * rather than emitted as bogus occupancy.
 */
export function observationsToOccupancy(
  measurements: Measurement[],
  opts: { timestamp?: string | number } = {}
): Uint8Array {
  const ts = toEpochSeconds(opts.timestamp);
  const message: GtfsRealtimeBindings.transit_realtime.IFeedMessage = {
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: FeedHeader.Incrementality.FULL_DATASET,
      ...(ts != null ? { timestamp: ts } : {}),
    },
    entity: measurements
      .map(toOccupancyEntity)
      .filter((e): e is GtfsRealtimeBindings.transit_realtime.IFeedEntity => e !== null),
  };
  const err = transit_realtime.FeedMessage.verify(message);
  if (err) throw new Error(`invalid GTFS-RT FeedMessage: ${err}`);
  return transit_realtime.FeedMessage.encode(message).finish();
}
