import type { ConditionEvent } from "@openconditions/core";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { roadFields } from "./types.js";

/**
 * GTFS-RT Service Alert emitter — projects condition events to a protobuf
 * `FeedMessage` of `Alert`s so transit engines (OpenTripPlanner, MOTIS,
 * OneBusAway-style apps) can consume OpenConditions. Spec:
 * https://gtfs.org/realtime/reference/#message-alert. Uses the official
 * `gtfs-realtime-bindings`. GTFS-RT carries no geometry, so a condition's
 * location surfaces only via transit `informed_entity` selectors derived from
 * its `subject` refs; events with none get a single network-wide selector.
 */

const { transit_realtime } = GtfsRealtimeBindings;
const { Alert, FeedHeader } = transit_realtime;

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

function informedEntities(
  ev: ConditionEvent
): GtfsRealtimeBindings.transit_realtime.IEntitySelector[] {
  type Selector = GtfsRealtimeBindings.transit_realtime.IEntitySelector;
  const sels = (ev.subject ?? []).flatMap<Selector>((s) => {
    if (s.type === "gtfs-stop") return [{ stopId: s.id }];
    if (s.type === "gtfs-route") return [{ routeId: s.id }];
    if (s.type === "gtfs-trip") return [{ trip: { tripId: s.id } }];
    return [];
  });
  // GTFS-RT requires at least one selector; an empty one = applies feed-wide.
  return sels.length > 0 ? sels : [{}];
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

function toEntity(ev: ConditionEvent): GtfsRealtimeBindings.transit_realtime.IFeedEntity {
  const { cause, effect, severity } = toGtfsRtAlertCodes(ev);
  const alert: GtfsRealtimeBindings.transit_realtime.IAlert = {
    cause,
    effect,
    severityLevel: severity,
    informedEntity: informedEntities(ev),
  };
  const period = activePeriod(ev);
  if (period) alert.activePeriod = period;
  const header = translated(ev.headline);
  if (header) alert.headerText = header;
  const description = translated(ev.description);
  if (description) alert.descriptionText = description;
  const url = translated(ev.origin.attribution.url);
  if (url) alert.url = url;
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
    entity: events.map(toEntity),
  };
  const err = transit_realtime.FeedMessage.verify(message);
  if (err) throw new Error(`invalid GTFS-RT FeedMessage: ${err}`);
  return transit_realtime.FeedMessage.encode(message).finish();
}
