import type { ConditionEvent, Measurement } from "@openconditions/core";
import type { Geometry } from "geojson";

type RoadFields = {
  isPlanned?: boolean;
  roadState?: "open" | "some_lanes_closed" | "single_lane_alternating" | "closed";
  direction?: string;
  roads?: {
    name: string;
    ref?: string;
    roadClass?: string;
    direction?: string;
    from?: string;
    to?: string;
    milepostFrom?: number;
    milepostTo?: number;
  }[];
  lanesAffected?: { total?: number; closed?: number; vehicleImpact?: string };
  speedLimitKph?: number;
  restrictions?: { type: string; value?: number; unit?: string }[];
  vehiclesAffected?: string[];
  detour?: string;
  delaySeconds?: number;
  queueLengthMeters?: number;
  workersPresent?: boolean;
  workZoneType?: "static" | "moving" | "area";
  regions?: string[];
  externalRefs?: { tmc?: { country: string; table: number; code: number } };
  sourceRaw?: Record<string, unknown>;
};

export function roadEvent(
  over: Partial<ConditionEvent> & RoadFields & { geometry?: Geometry } = {}
): ConditionEvent {
  return {
    id: "ndw:1",
    source: "ndw",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    status: "active",
    origin: {
      kind: "feed",
      attribution: { provider: "NDW", license: "CC0-1.0", url: "https://www.ndw.nu" },
    },
    dataUpdatedAt: "2026-06-22T10:00:00Z",
    fetchedAt: "2026-06-22T10:00:00Z",
    isStale: false,
    routingEvidence: {
      schema_version: 1,
      observation_revision: "rev-1",
      binding_revision: "rev-1",
      graph_generation: "graph-1",
      resolver_version: "1.0.0",
      source_id: "ndw",
      child_source_id: null,
      source_license: "CC0-1.0",
      license_url: null,
      attribution: "NDW",
      record_url: null,
      source_checked_at: "2026-06-22T09:55:00Z",
      fresh_until: "2030-06-22T10:15:00Z",
      expires_at: "2030-06-22T11:00:00Z",
      valid_from: null,
      valid_to: null,
      next_transition_at: null,
      direction_mode: "both",
      applicability: { kind: "all" },
      rights: {
        source_redistribution: "yes",
        derived_redistribution: "yes",
        commercial_use: "yes",
        attribution_required: "no",
        retention: "yes",
        evidence_origin: "fixture",
        evidence_version: "1",
        reviewed_at: "2026-06-01T00:00:00Z",
      },
      segments: [
        { segment_id: "1:f", direction: "forward", from_fraction: 0, to_fraction: 1 },
        { segment_id: "1:b", direction: "reverse", from_fraction: 0, to_fraction: 1 },
      ],
      binding_status: "exact",
      reason_codes: [],
      evaluated_at: "2026-06-22T10:00:00Z",
    },
    type: "accident",
    category: "incident",
    severity: "high",
    severitySource: "derived",
    headline: "Accident on A2",
    ...over,
  } as ConditionEvent;
}

export function measurement(over: Partial<Measurement> = {}): Measurement {
  return {
    id: "flow:1",
    source: "ndw",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "measurement",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    status: "active",
    origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-06-22T10:00:00Z",
    fetchedAt: "2026-06-22T10:00:00Z",
    isStale: false,
    metric: "flow",
    value: 1200,
    unit: "veh/h",
    aggregation: "live",
    ...over,
  } as Measurement;
}
