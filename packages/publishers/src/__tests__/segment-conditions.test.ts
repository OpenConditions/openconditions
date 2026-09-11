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
    binding_resolver_version: "1.0.0",
    binding_confidence: 0.96,
    binding_direction_mode: "single",
    observation_revision: "rev-1",
    binding_revision: "rev-1",
    graph_generation: "graph-1",
    child_source_id: null,
    source_uri: "https://example.test/events/1",
    source_checked_at: "2026-09-06T09:55:00Z",
    fresh_until: "2026-09-06T10:15:00Z",
    expires_at: "2026-09-06T16:00:00Z",
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attribution: "Autobahn GmbH",
    rights: {
      source_redistribution: "yes",
      derived_redistribution: "yes",
      commercial_use: "yes",
      attribution_required: "no",
      retention: "yes",
      evidence_origin: "license-registry",
      evidence_version: "1",
      reviewed_at: "2026-09-01T00:00:00Z",
    },
    segments: [
      {
        segmentId: "10:f",
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
    expect(out.schema_version).toBe(1);
    expect(out.complete).toBe(true);
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
      routing_evidence: {
        schema_version: 1,
        observation_revision: "rev-1",
        binding_revision: "rev-1",
        graph_generation: "graph-1",
        source_id: "autobahn-de",
        binding_status: "exact",
        direction_mode: "forward",
        applicability: { kind: "all" },
        reason_codes: [],
      },
    });
  });

  it("drops a binding whose segment vanished from the active graph", () => {
    const out = segmentConditionsToJson(
      [
        row({
          segments: [
            {
              segmentId: "10:f",
              wayId: 10,
              dir: "f",
              startFraction: 0,
              endFraction: 1,
              geometry: null,
            },
          ],
        }),
      ],
      at,
      { resolverVersion: "1.0.0" }
    );
    expect(out.conditions).toEqual([]);
  });

  it("drops a binding produced by an older resolver", () => {
    expect(
      segmentConditionsToJson([row({ binding_resolver_version: "0.9.0" })], at, {
        resolverVersion: "1.0.0",
      }).conditions
    ).toEqual([]);
  });

  it("retains the original child source while evidence names its parent policy source", () => {
    const out = segmentConditionsToJson(
      [row({ source: "de-child", routing_source_id: "de-parent", child_source_id: "de-child" })],
      at,
      { resolverVersion: "1.0.0" }
    );
    expect(out.conditions[0]).toMatchObject({
      source: "de-child",
      routing_evidence: { source_id: "de-parent", child_source_id: "de-child" },
    });
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

  it("drops crowd rows without external routing eligibility", () => {
    const crowd = segmentConditionsToJson(
      [row({ origin: { kind: "crowd" }, routing_eligible: false })],
      at,
      { resolverVersion: "1.0.0" }
    );
    expect(crowd.conditions).toEqual([]);
  });

  it("carries speed limits from attributes", () => {
    const out = segmentConditionsToJson(
      [row({ type: "roadworks", attributes: { speedLimitKph: 60 } })],
      at,
      { resolverVersion: "1.0.0" }
    );
    expect(out.conditions[0]!.speed_limit_kph).toBe(60);
  });

  it("drops obsolete, stale, ambiguous and incomplete bindings before routing export", () => {
    const out = segmentConditionsToJson(
      [
        row({ id: "obsolete", binding_revision: "rev-old" }),
        row({ id: "stale", fresh_until: "2026-09-06T09:59:59Z" }),
        row({ id: "ambiguous", binding_status: "ambiguous" }),
        row({ id: "vanished", segments: [{ ...row().segments[0]!, geometry: null }] }),
      ],
      at,
      { resolverVersion: "1.0.0", evaluatedAt: at }
    );
    expect(out.conditions).toEqual([]);
  });

  it("preserves class-specific applicability for the host to evaluate", () => {
    const out = segmentConditionsToJson(
      [row({ attributes: { roadState: "closed", vehiclesAffected: ["heavyGoodsVehicle"] } })],
      at,
      { resolverVersion: "1.0.0", evaluatedAt: at }
    );
    expect(out.conditions[0]!.routing_evidence.applicability).toEqual({
      kind: "classes",
      classes: ["truck"],
      raw: ["heavyGoodsVehicle"],
    });
  });

  it("drops a dimension-qualified vehicle scope that cannot be represented safely", () => {
    const out = segmentConditionsToJson(
      [
        row({
          attributes: {
            roadState: "closed",
            vehiclesAffected: ["lorry"],
            restrictions: [{ type: "height", value: 4.5, unit: "m", operator: "greaterThan" }],
          },
        }),
      ],
      at,
      { resolverVersion: "1.0.0", evaluatedAt: at }
    );
    expect(out.conditions).toEqual([]);
  });
});
