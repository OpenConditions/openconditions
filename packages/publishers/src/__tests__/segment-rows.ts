import type { SegmentConditionRow } from "@openconditions/core";
import type { Effect } from "@openconditions/model";

/** A full closure of the eastbound A 46 for all vehicles. */
export const closure = {
  id: "a1/closure",
  kind: "closure",
  v: 1,
  scope: "road",
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
} as Effect;

/** One bound, current, licensed effect row as the routing read returns it; `over` replaces fields. */
export function segmentRow(over: Partial<SegmentConditionRow> = {}): SegmentConditionRow {
  return {
    record_id: "oc:situation:de-autobahn:a1",
    effect_id: "a1/closure",
    source_id: "de-autobahn",
    kind: "closure",
    type: "closure",
    subtype: "full",
    severity: "major",
    validity: { status: "active", start: "2026-09-06T08:00:00Z", end: "2026-09-06T16:00:00Z" },
    effect: closure,
    origin: "feed",
    evidence_state: null,
    routing_eligible: null,
    record_revision: 3,
    expires_at: "2026-09-06T16:00:00Z",
    provenance_attribution: { provider: "Autobahn GmbH", license: "CC0-1.0" },
    source_uri: "https://example.test/events/1",
    source_checked_at: "2026-09-06T09:55:00Z",
    fresh_until: "2026-09-06T10:15:00Z",
    binding_status: "exact",
    binding_confidence: 0.96,
    binding_resolver_version: "2.0.0",
    binding_direction_mode: "single",
    binding_revision: 3,
    graph_generation: "graph-1",
    child_source_id: null,
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
