import type { Measurement } from "@openconditions/core";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { describe, expect, it } from "vitest";
import { observationsToOccupancy } from "../gtfsrt.js";
import { measurement } from "./fixture.js";

const { transit_realtime } = GtfsRealtimeBindings;
const { FeedHeader, VehiclePosition } = transit_realtime;
const { OccupancyStatus } = VehiclePosition;

function decode(bytes: Uint8Array) {
  return transit_realtime.FeedMessage.decode(bytes);
}

/** protobufjs decodes 64-bit fields to Long; normalise for comparison. */
function num(v: unknown): number {
  return typeof v === "number" ? v : (v as { toNumber(): number }).toNumber();
}

/**
 * A `transit/occupancy` measurement fixture. `attributes` is not part of the
 * typed Measurement interface (it is a runtime JSONB bag, same as elsewhere in
 * the codebase), so it is folded in via a cast after the base builder.
 */
function occ(
  over: Partial<Measurement> & { attributes?: Record<string, unknown> } = {}
): Measurement {
  const { attributes, ...rest } = over;
  const m = measurement({
    id: "occ:1",
    source: "transit-feed",
    sourceFormat: "gtfs-rt",
    domain: "transit",
    metric: "occupancy",
    value: undefined,
    unit: undefined,
    level: "FULL",
    ...rest,
  });
  return (attributes ? { ...m, attributes } : m) as Measurement;
}

describe("observationsToOccupancy — feed envelope", () => {
  it("emits a decodable FeedMessage with a FULL_DATASET header + timestamp", () => {
    const feed = decode(
      observationsToOccupancy(
        [occ({ subject: [{ type: "gtfs-trip", id: "trip-1" }], attributes: { vehicleId: "v-1" } })],
        { timestamp: "2026-06-23T10:00:00Z" }
      )
    );
    expect(feed.header?.gtfsRealtimeVersion).toBe("2.0");
    expect(feed.header?.incrementality).toBe(FeedHeader.Incrementality.FULL_DATASET);
    expect(num(feed.header?.timestamp)).toBe(Math.floor(Date.parse("2026-06-23T10:00:00Z") / 1000));
  });

  it("produces a protobuf-valid FeedMessage", () => {
    const bytes = observationsToOccupancy([
      occ({ subject: [{ type: "gtfs-trip", id: "trip-1" }], attributes: { vehicleId: "v-1" } }),
    ]);
    expect(() => decode(bytes)).not.toThrow();
    expect(
      transit_realtime.FeedMessage.verify(transit_realtime.FeedMessage.decode(bytes))
    ).toBeNull();
  });
});

describe("observationsToOccupancy — VehiclePosition path", () => {
  it("emits a VehiclePosition entity for a trip + vehicleId + valid level", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          id: "occ:7",
          level: "STANDING_ROOM_ONLY",
          subject: [{ type: "gtfs-trip", id: "trip-9" }],
          attributes: { vehicleId: "veh-42" },
          dataUpdatedAt: "2026-06-23T09:00:00Z",
        }),
      ])
    );
    expect(feed.entity).toHaveLength(1);
    const entity = feed.entity[0]!;
    expect(entity.id).toBe("occ:7");
    const vp = entity.vehicle!;
    expect(vp.trip?.tripId).toBe("trip-9");
    expect(vp.vehicle?.id).toBe("veh-42");
    expect(vp.occupancyStatus).toBe(OccupancyStatus.STANDING_ROOM_ONLY);
    expect(num(vp.timestamp)).toBe(Math.floor(Date.parse("2026-06-23T09:00:00Z") / 1000));
    // A VehiclePosition carrier, never a TripUpdate for this measurement.
    expect(entity.tripUpdate).toBeFalsy();
  });

  it("accepts the vehicle id from a subject with role='vehicle'", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          subject: [
            { type: "gtfs-trip", id: "trip-3" },
            { type: "gtfs-trip", id: "veh-7", role: "vehicle" },
          ],
        }),
      ])
    );
    expect(feed.entity).toHaveLength(1);
    expect(feed.entity[0]!.vehicle?.vehicle?.id).toBe("veh-7");
  });

  it("maps every OccupancyStatus level string to its enum int", () => {
    const levels = [
      "EMPTY",
      "MANY_SEATS_AVAILABLE",
      "FEW_SEATS_AVAILABLE",
      "STANDING_ROOM_ONLY",
      "CRUSHED_STANDING_ROOM_ONLY",
      "FULL",
      "NOT_ACCEPTING_PASSENGERS",
      "NO_DATA_AVAILABLE",
      "NOT_BOARDABLE",
    ] as const;
    const feed = decode(
      observationsToOccupancy(
        levels.map((level, i) =>
          occ({
            id: `occ:${i}`,
            level,
            subject: [{ type: "gtfs-trip", id: `trip-${i}` }],
            attributes: { vehicleId: `v-${i}` },
          })
        )
      )
    );
    expect(feed.entity.map((e) => e.vehicle?.occupancyStatus)).toEqual(
      levels.map((l) => OccupancyStatus[l])
    );
  });

  it("reads vehicleId from a top-level key (reconstructed-model shape)", () => {
    // readObservations spreads the attributes JSONB onto the top level, so a
    // DB-served measurement carries `vehicleId` as a top-level field rather than
    // nested under `attributes`. The emitter must resolve either shape.
    const feed = decode(
      observationsToOccupancy([
        {
          ...occ({ subject: [{ type: "gtfs-trip", id: "trip-top" }] }),
          vehicleId: "veh-top",
        } as unknown as Measurement,
      ])
    );
    expect(feed.entity).toHaveLength(1);
    expect(feed.entity[0]!.vehicle?.trip?.tripId).toBe("trip-top");
    expect(feed.entity[0]!.vehicle?.vehicle?.id).toBe("veh-top");
  });

  it("prefers the VehiclePosition path when both vehicleId and stopSequence are present", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          subject: [{ type: "gtfs-trip", id: "trip-5" }],
          attributes: { vehicleId: "v-5", stopSequence: 4 },
        }),
      ])
    );
    expect(feed.entity[0]!.vehicle).toBeTruthy();
    expect(feed.entity[0]!.tripUpdate).toBeFalsy();
  });
});

describe("observationsToOccupancy — TripUpdate path", () => {
  it("emits a TripUpdate with a StopTimeUpdate for a trip + stopSequence (no vehicle)", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          id: "occ:11",
          level: "NO_DATA_AVAILABLE",
          subject: [{ type: "gtfs-trip", id: "trip-11" }],
          attributes: { stopSequence: 6 },
        }),
      ])
    );
    expect(feed.entity).toHaveLength(1);
    const entity = feed.entity[0]!;
    expect(entity.vehicle).toBeFalsy();
    const tu = entity.tripUpdate!;
    expect(tu.trip?.tripId).toBe("trip-11");
    expect(tu.stopTimeUpdate).toHaveLength(1);
    const stu = tu.stopTimeUpdate![0]!;
    expect(stu.stopSequence).toBe(6);
    expect(stu.departureOccupancyStatus).toBe(OccupancyStatus.NO_DATA_AVAILABLE);
  });

  it("reads stopSequence from a top-level key (reconstructed-model shape)", () => {
    const feed = decode(
      observationsToOccupancy([
        {
          ...occ({
            level: "FEW_SEATS_AVAILABLE",
            subject: [{ type: "gtfs-trip", id: "trip-top" }],
          }),
          stopSequence: 2,
        } as unknown as Measurement,
      ])
    );
    expect(feed.entity).toHaveLength(1);
    const stu = feed.entity[0]!.tripUpdate!.stopTimeUpdate![0]!;
    expect(stu.stopSequence).toBe(2);
    expect(stu.departureOccupancyStatus).toBe(OccupancyStatus.FEW_SEATS_AVAILABLE);
  });
});

describe("observationsToOccupancy — concrete-entity gate (exclusions)", () => {
  it("EXCLUDES an aggregate with only a gtfs-route subject", () => {
    const feed = decode(
      observationsToOccupancy([occ({ subject: [{ type: "gtfs-route", id: "route-1" }] })])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("EXCLUDES an aggregate with only a gtfs-stop subject", () => {
    const feed = decode(
      observationsToOccupancy([occ({ subject: [{ type: "gtfs-stop", id: "stop-1" }] })])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("EXCLUDES a bare trip with neither vehicleId nor stopSequence (no carrier)", () => {
    const feed = decode(
      observationsToOccupancy([occ({ subject: [{ type: "gtfs-trip", id: "trip-1" }] })])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("EXCLUDES an unknown/invalid level string (no bogus occupancy)", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          level: "PACKED",
          subject: [{ type: "gtfs-trip", id: "trip-1" }],
          attributes: { vehicleId: "v-1" },
        }),
      ])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("EXCLUDES a numeric-string level (only the enum names are valid)", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          level: "5",
          subject: [{ type: "gtfs-trip", id: "trip-1" }],
          attributes: { vehicleId: "v-1" },
        }),
      ])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("EXCLUDES a measurement with a missing level", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          level: undefined,
          subject: [{ type: "gtfs-trip", id: "trip-1" }],
          attributes: { vehicleId: "v-1" },
        }),
      ])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("EXCLUDES a non-transit-occupancy measurement (wrong domain)", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          domain: "roads",
          subject: [{ type: "gtfs-trip", id: "trip-1" }],
          attributes: { vehicleId: "v-1" },
        }),
      ])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("EXCLUDES a transit measurement with a different metric", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          metric: "temperature",
          level: undefined,
          value: 21,
          subject: [{ type: "gtfs-trip", id: "trip-1" }],
          attributes: { vehicleId: "v-1" },
        }),
      ])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("EXCLUDES a whitespace-only trip id", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({ subject: [{ type: "gtfs-trip", id: "  " }], attributes: { vehicleId: "v-1" } }),
      ])
    );
    expect(feed.entity).toHaveLength(0);
  });

  it("keeps only qualifying measurements from a mixed batch", () => {
    const feed = decode(
      observationsToOccupancy([
        occ({
          id: "keep:vp",
          subject: [{ type: "gtfs-trip", id: "t1" }],
          attributes: { vehicleId: "v1" },
        }),
        occ({ id: "drop:route", subject: [{ type: "gtfs-route", id: "r1" }] }),
        occ({
          id: "keep:tu",
          subject: [{ type: "gtfs-trip", id: "t2" }],
          attributes: { stopSequence: 3 },
        }),
        occ({ id: "drop:badlevel", level: "NOPE", subject: [{ type: "gtfs-trip", id: "t3" }] }),
      ])
    );
    expect(feed.entity.map((e) => e.id)).toEqual(["keep:vp", "keep:tu"]);
  });
});
