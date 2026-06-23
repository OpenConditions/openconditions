import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { describe, expect, it } from "vitest";
import { observationsToGtfsRtAlerts, toGtfsRtAlertCodes } from "../gtfsrt.js";
import { roadEvent } from "./fixture.js";

const { transit_realtime } = GtfsRealtimeBindings;
const { Alert, FeedHeader } = transit_realtime;

function decode(bytes: Uint8Array) {
  return transit_realtime.FeedMessage.decode(bytes);
}

/** protobufjs decodes 64-bit fields to Long; normalise for comparison. */
function num(v: unknown): number {
  return typeof v === "number" ? v : (v as { toNumber(): number }).toNumber();
}

describe("toGtfsRtAlertCodes", () => {
  it("maps condition type to a GTFS-RT cause", () => {
    expect(toGtfsRtAlertCodes(roadEvent({ type: "accident" })).cause).toBe(Alert.Cause.ACCIDENT);
    expect(toGtfsRtAlertCodes(roadEvent({ type: "roadworks" })).cause).toBe(
      Alert.Cause.CONSTRUCTION
    );
    expect(toGtfsRtAlertCodes(roadEvent({ type: "weather" })).cause).toBe(Alert.Cause.WEATHER);
    expect(toGtfsRtAlertCodes(roadEvent({ type: "authority" })).cause).toBe(
      Alert.Cause.POLICE_ACTIVITY
    );
  });

  it("maps routing impact to a GTFS-RT effect", () => {
    expect(toGtfsRtAlertCodes(roadEvent({ type: "road_closure" })).effect).toBe(
      Alert.Effect.DETOUR
    );
    expect(toGtfsRtAlertCodes(roadEvent({ type: "accident", roadState: "closed" })).effect).toBe(
      Alert.Effect.DETOUR
    );
    expect(toGtfsRtAlertCodes(roadEvent({ type: "lane_closure" })).effect).toBe(
      Alert.Effect.SIGNIFICANT_DELAYS
    );
    expect(toGtfsRtAlertCodes(roadEvent({ type: "congestion" })).effect).toBe(
      Alert.Effect.SIGNIFICANT_DELAYS
    );
  });

  it("maps severity to a GTFS-RT severity level", () => {
    expect(toGtfsRtAlertCodes(roadEvent({ severity: "low" })).severity).toBe(
      Alert.SeverityLevel.INFO
    );
    expect(toGtfsRtAlertCodes(roadEvent({ severity: "medium" })).severity).toBe(
      Alert.SeverityLevel.WARNING
    );
    expect(toGtfsRtAlertCodes(roadEvent({ severity: "critical" })).severity).toBe(
      Alert.SeverityLevel.SEVERE
    );
    expect(toGtfsRtAlertCodes(roadEvent({ severity: "unknown" })).severity).toBe(
      Alert.SeverityLevel.UNKNOWN_SEVERITY
    );
  });
});

describe("observationsToGtfsRtAlerts", () => {
  it("emits a decodable FeedMessage with a FULL_DATASET header", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([roadEvent()], { timestamp: "2026-06-23T10:00:00Z" })
    );
    expect(feed.header?.gtfsRealtimeVersion).toBe("2.0");
    expect(feed.header?.incrementality).toBe(FeedHeader.Incrementality.FULL_DATASET);
    expect(num(feed.header?.timestamp)).toBe(Math.floor(Date.parse("2026-06-23T10:00:00Z") / 1000));
  });

  it("emits one entity per event carrying an Alert with cause/effect/severity + header text", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({
          id: "ndw:7",
          type: "road_closure",
          severity: "critical",
          headline: "A2 closed",
        }),
      ])
    );
    expect(feed.entity).toHaveLength(1);
    const entity = feed.entity[0]!;
    expect(entity.id).toBe("ndw:7");
    const alert = entity.alert!;
    expect(alert.cause).toBe(Alert.Cause.OTHER_CAUSE);
    expect(alert.effect).toBe(Alert.Effect.DETOUR);
    expect(alert.severityLevel).toBe(Alert.SeverityLevel.SEVERE);
    expect(alert.headerText?.translation?.[0]?.text).toBe("A2 closed");
  });

  it("derives informed_entity from transit subject refs", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({
          type: "transit_disruption",
          subject: [
            { type: "gtfs-stop", id: "stop-1" },
            { type: "gtfs-route", id: "route-9" },
            { type: "gtfs-trip", id: "trip-3" },
            { type: "geo", id: "geo:52,13" },
          ],
        }),
      ])
    );
    const sel = feed.entity[0]!.alert!.informedEntity!;
    expect(sel.map((s) => s.stopId).filter(Boolean)).toEqual(["stop-1"]);
    expect(sel.map((s) => s.routeId).filter(Boolean)).toEqual(["route-9"]);
    expect(sel.map((s) => s.trip?.tripId).filter(Boolean)).toEqual(["trip-3"]);
  });

  it("falls back to a single network-wide selector when there are no transit subjects", () => {
    const feed = decode(observationsToGtfsRtAlerts([roadEvent({ subject: [] })]));
    expect(feed.entity[0]!.alert!.informedEntity).toHaveLength(1);
  });

  it("sets active_period from validFrom/validTo", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({ validFrom: "2026-06-23T08:00:00Z", validTo: "2026-06-23T12:00:00Z" }),
      ])
    );
    const period = feed.entity[0]!.alert!.activePeriod![0]!;
    expect(num(period.start)).toBe(Math.floor(Date.parse("2026-06-23T08:00:00Z") / 1000));
    expect(num(period.end)).toBe(Math.floor(Date.parse("2026-06-23T12:00:00Z") / 1000));
  });
});
