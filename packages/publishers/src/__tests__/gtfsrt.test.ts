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
  // A transit-scoped event: one that resolves to a concrete GTFS selector, so
  // it is actually emitted under the corrected (selector-gated) emitter.
  const transitEvent = (over: Parameters<typeof roadEvent>[0] = {}) =>
    roadEvent({ informed: { routes: ["R1"] }, ...over });

  it("emits a decodable FeedMessage with a FULL_DATASET header", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([transitEvent()], { timestamp: "2026-06-23T10:00:00Z" })
    );
    expect(feed.header?.gtfsRealtimeVersion).toBe("2.0");
    expect(feed.header?.incrementality).toBe(FeedHeader.Incrementality.FULL_DATASET);
    expect(num(feed.header?.timestamp)).toBe(Math.floor(Date.parse("2026-06-23T10:00:00Z") / 1000));
  });

  it("emits one entity per transit-scoped event carrying cause/effect/severity + header text", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        transitEvent({
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

  it("EXCLUDES a road event with no transit subject/informed (no feed-wide selector)", () => {
    const feed = decode(observationsToGtfsRtAlerts([roadEvent({ subject: [] })]));
    expect(feed.entity).toHaveLength(0);
    // Assert exhaustively that no selector-less (network-wide) alert leaked in.
    for (const e of feed.entity) {
      for (const s of e.alert?.informedEntity ?? []) {
        expect(Object.keys(s).length).toBeGreaterThan(0);
      }
    }
  });

  it("EXCLUDES a transit-domain event that carries no resolvable selector", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({ domain: "transit", type: "transit_disruption", subject: [] }),
      ])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("derives informed_entity from ev.informed stops/routes/trips", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({ informed: { stops: ["s1", "s2"], routes: ["R9"], trips: ["t3"] } }),
      ])
    );
    const sel = feed.entity[0]!.alert!.informedEntity!;
    expect(sel.map((s) => s.stopId).filter(Boolean)).toEqual(["s1", "s2"]);
    expect(sel.map((s) => s.routeId).filter(Boolean)).toEqual(["R9"]);
    expect(sel.map((s) => s.trip?.tripId).filter(Boolean)).toEqual(["t3"]);
  });

  it("emits a road event that affects transit via informed.routes", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([roadEvent({ domain: "roads", informed: { routes: ["R1"] } })])
    );
    expect(feed.entity).toHaveLength(1);
    const sel = feed.entity[0]!.alert!.informedEntity!;
    expect(sel).toHaveLength(1);
    expect(sel[0]!.routeId).toBe("R1");
  });

  it("maps informed.modes to GTFS route_type, skipping unknown modes", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([roadEvent({ informed: { modes: ["bus", "tram", "spaceship"] } })])
    );
    const sel = feed.entity[0]!.alert!.informedEntity!;
    expect(sel.map((s) => s.routeType)).toEqual([3, 0]);
  });

  it("EXCLUDES an event whose modes are all unknown (no bogus selector)", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([roadEvent({ informed: { modes: ["spaceship", "teleport"] } })])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("keeps only transit-selector-bearing events from a mixed batch", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({ id: "road:1", subject: [] }),
        roadEvent({ id: "transit:1", informed: { routes: ["R1"] } }),
        roadEvent({ id: "road:2" }),
        roadEvent({ id: "transit:2", subject: [{ type: "gtfs-stop", id: "S1" }] }),
      ])
    );
    expect(feed.entity.map((e) => e.id)).toEqual(["transit:1", "transit:2"]);
  });

  it("dedupes an identical selector coming from both subject and informed", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({ subject: [{ type: "gtfs-route", id: "R1" }], informed: { routes: ["R1"] } }),
      ])
    );
    const sel = feed.entity[0]!.alert!.informedEntity!;
    expect(sel).toHaveLength(1);
    expect(sel[0]!.routeId).toBe("R1");
  });

  it("skips empty and whitespace-only ids (no {routeId:''} noise), excluding an all-empty event", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({
          subject: [{ type: "gtfs-stop", id: "" }],
          informed: { routes: ["", "   "] },
        }),
      ])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("keeps a valid id alongside an empty one from the same event", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({
          subject: [
            { type: "gtfs-stop", id: "" },
            { type: "gtfs-route", id: "R1" },
          ],
          informed: { stops: ["  ", "s9"] },
        }),
      ])
    );
    const sel = feed.entity[0]!.alert!.informedEntity!;
    expect(sel.map((s) => s.routeId).filter(Boolean)).toEqual(["R1"]);
    expect(sel.map((s) => s.stopId).filter(Boolean)).toEqual(["s9"]);
    expect(sel.every((s) => Object.keys(s).length > 0)).toBe(true);
  });

  it("sets active_period from validFrom/validTo", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        transitEvent({ validFrom: "2026-06-23T08:00:00Z", validTo: "2026-06-23T12:00:00Z" }),
      ])
    );
    const period = feed.entity[0]!.alert!.activePeriod![0]!;
    expect(num(period.start)).toBe(Math.floor(Date.parse("2026-06-23T08:00:00Z") / 1000));
    expect(num(period.end)).toBe(Math.floor(Date.parse("2026-06-23T12:00:00Z") / 1000));
  });

  it("still produces a protobuf-valid FeedMessage", () => {
    const bytes = observationsToGtfsRtAlerts([transitEvent()]);
    expect(() => decode(bytes)).not.toThrow();
    expect(
      transit_realtime.FeedMessage.verify(transit_realtime.FeedMessage.decode(bytes))
    ).toBeNull();
  });
});

describe("observationsToGtfsRtAlerts — extended Alert fields", () => {
  it("emits tts text + cause/effect detail", () => {
    const feed = decode(
      observationsToGtfsRtAlerts([
        roadEvent({
          type: "road_closure",
          headline: "A2 closed",
          description: "Closed until noon",
          subtype: "roadMaintenance",
          detour: "Use A4",
          informed: { routes: ["R1"] },
        }),
      ])
    );
    const alert = feed.entity[0]!.alert!;
    expect(alert.ttsHeaderText?.translation?.[0]?.text).toBe("A2 closed");
    expect(alert.ttsDescriptionText?.translation?.[0]?.text).toBe("Closed until noon");
    expect(alert.causeDetail?.translation?.[0]?.text).toBe("roadMaintenance");
    expect(alert.effectDetail?.translation?.[0]?.text).toBe("Use A4");
  });
});
