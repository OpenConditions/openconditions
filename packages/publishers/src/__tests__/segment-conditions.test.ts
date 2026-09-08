import { describe, expect, it } from "vitest";
import { segmentConditionsToJson, type SegmentConditionRow } from "../segment-conditions.js";

function row(over: Partial<SegmentConditionRow> = {}): SegmentConditionRow {
  return {
    id: "a:1",
    source: "autobahn-de",
    type: "road_closure",
    severity: "high",
    attributes: { roadState: "closed", speedLimitKph: null, vehiclesAffected: [] },
    origin: { kind: "feed" },
    routing_eligible: null,
    valid_from: "2026-09-06T08:00:00Z",
    valid_to: "2026-09-06T16:00:00Z",
    schedule: null,
    source_license: "CC0-1.0",
    binding_status: "exact",
    binding_confidence: 0.96,
    binding_direction_mode: "single",
    segments: [
      {
        wayId: 10,
        dir: "f",
        startFraction: 0.3,
        endFraction: 1,
        geometry: {
          type: "LineString",
          coordinates: [
            [6.803, 51.2],
            [6.81, 51.2],
          ],
        },
      },
    ],
    ...over,
  };
}

describe("segmentConditionsToJson", () => {
  const at = new Date("2026-09-06T10:00:00Z");

  it("emits snake_case rows with bindings, segments and span geometry", () => {
    const out = segmentConditionsToJson([row()], at, { resolverVersion: "1.0.0" });
    expect(out.at).toBe(at.toISOString());
    expect(out.resolver_version).toBe("1.0.0");
    expect(out.conditions[0]).toMatchObject({
      id: "a:1",
      type: "road_closure",
      road_state: "closed",
      speed_limit_kph: null,
      vehicles_affected: [],
      origin_kind: "feed",
      routing_eligible: true,
      binding: { status: "exact", confidence: 0.96, direction_mode: "single" },
      segments: [
        {
          way_id: 10,
          dir: "f",
          start_fraction: 0.3,
          end_fraction: 1,
          geometry: {
            type: "LineString",
            coordinates: [
              [6.803, 51.2],
              [6.81, 51.2],
            ],
          },
        },
      ],
    });
  });

  it("passes a null geometry through for a vanished segment", () => {
    const out = segmentConditionsToJson(
      [
        row({
          segments: [{ wayId: 10, dir: "f", startFraction: 0, endFraction: 1, geometry: null }],
        }),
      ],
      at,
      { resolverVersion: "1.0.0" }
    );
    expect(out.conditions[0]!.segments[0]!.geometry).toBeNull();
  });

  it("drops rows not in effect at `at` (validity or schedule)", () => {
    expect(
      segmentConditionsToJson([row({ valid_from: "2026-09-06T12:00:00Z" })], at, {
        resolverVersion: "1.0.0",
      }).conditions
    ).toEqual([]);
    expect(
      segmentConditionsToJson(
        [
          row({
            schedule: [{ startTime: "20:00", duration: "PT9H", scheduleTimezone: "Europe/Berlin" }],
          }),
        ],
        at,
        { resolverVersion: "1.0.0" }
      ).conditions
    ).toEqual([]);
  });

  it("crowd rows carry routing_eligible verbatim, feed rows are always true", () => {
    const crowd = segmentConditionsToJson(
      [row({ origin: { kind: "crowd" }, routing_eligible: false })],
      at,
      { resolverVersion: "1.0.0" }
    );
    expect(crowd.conditions[0]!.routing_eligible).toBe(false);
  });

  it("carries speed limits from attributes", () => {
    const out = segmentConditionsToJson(
      [row({ type: "roadworks", attributes: { speedLimitKph: 60 } })],
      at,
      { resolverVersion: "1.0.0" }
    );
    expect(out.conditions[0]!.speed_limit_kph).toBe(60);
  });
});
