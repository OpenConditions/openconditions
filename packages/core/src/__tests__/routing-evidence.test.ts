import { describe, expect, it } from "vitest";
import { type RoadConditionRoutingEvidence, routingEvidenceReasons } from "../index.js";

const base: RoadConditionRoutingEvidence = {
  schema_version: 2,
  record_class: "situation",
  record_id: "oc:situation:de-autobahn-events:a1",
  effect_id: "a1/closure",
  record_revision: 2,
  binding_revision: 2,
  effect_kind: "closure",
  graph_generation: "graph-1",
  resolver_version: "1.0.0",
  source_id: "de-autobahn-events",
  child_source_id: null,
  source_license: "DL-DE-BY-2.0",
  license_url: "https://www.govdata.de/dl-de/by-2-0",
  attribution: "Autobahn GmbH",
  record_url: null,
  source_checked_at: "2026-09-11T09:55:00.000Z",
  fresh_until: "2026-09-11T10:15:00.000Z",
  expires_at: "2026-09-11T11:00:00.000Z",
  valid_from: "2026-09-11T09:00:00.000Z",
  valid_to: "2026-09-11T11:00:00.000Z",
  next_transition_at: null,
  direction_mode: "forward",
  applicability: { kind: "all" },
  rights: {
    source_redistribution: "yes",
    derived_redistribution: "yes",
    commercial_use: "yes",
    attribution_required: "yes",
    retention: "yes",
    evidence_origin: "feed-descriptor",
    evidence_version: "2026-09-11",
    reviewed_at: "2026-09-11T00:00:00.000Z",
  },
  segments: [
    {
      segment_id: "123:f",
      direction: "forward",
      from_fraction: 0.2,
      to_fraction: 0.8,
    },
  ],
  binding_status: "exact",
  reason_codes: [],
  evaluated_at: "2026-09-11T10:00:00.000Z",
};

describe("routingEvidenceReasons", () => {
  it("accepts current complete evidence with affirmative rights", () => {
    expect(routingEvidenceReasons(base, new Date("2026-09-11T10:00:00.000Z"))).toEqual([]);
  });

  it("reports every independent fail-closed reason", () => {
    expect(
      routingEvidenceReasons(
        {
          ...base,
          binding_revision: 1,
          binding_status: "ambiguous",
          fresh_until: "2026-09-11T09:59:59.000Z",
          direction_mode: "unknown",
          applicability: { kind: "unknown", raw: ["except buses"] },
          rights: { ...base.rights, source_redistribution: "unknown" },
          segments: [{ ...base.segments[0]!, to_fraction: 1.2 }],
        },
        new Date("2026-09-11T10:00:00.000Z"),
      ),
    ).toEqual([
      "binding_revision_mismatch",
      "binding_ambiguous",
      "source_stale",
      "rights_source_redistribution_unknown",
      "applicability_unknown",
      "direction_unknown",
      "invalid_segment_span",
    ]);
  });

  it("rejects missing or invalid finite authority deadlines", () => {
    expect(
      routingEvidenceReasons(
        { ...base, source_checked_at: "invalid", fresh_until: "infinity" },
        new Date("2026-09-11T10:00:00.000Z"),
      ),
    ).toEqual(["source_check_invalid", "freshness_deadline_invalid"]);
  });

  it("rejects an expired record and invalid optional time bounds", () => {
    expect(
      routingEvidenceReasons(
        {
          ...base,
          expires_at: "2026-09-11T10:00:00.000Z",
          valid_from: "yesterday-ish",
          next_transition_at: "never",
        },
        new Date("2026-09-11T10:00:00.000Z"),
      ),
    ).toEqual(["record_expired", "valid_from_invalid", "next_transition_invalid"]);
  });

  it("requires the record, effect and revisions the evidence is about", () => {
    expect(
      routingEvidenceReasons(
        { ...base, record_id: "", effect_kind: " ", record_revision: 0, binding_revision: 0 },
        new Date("2026-09-11T10:00:00.000Z"),
      ),
    ).toEqual([
      "record_id_missing",
      "effect_kind_missing",
      "record_revision_missing",
      "binding_revision_missing",
    ]);
  });

  it("requires timezone-qualified evaluation and rights-review timestamps", () => {
    expect(
      routingEvidenceReasons(
        {
          ...base,
          evaluated_at: "2026-09-11",
          rights: { ...base.rights, reviewed_at: "2026-09-01" },
        },
        new Date("2026-09-11T10:00:00.000Z"),
      ),
    ).toEqual(["evaluated_at_invalid", "rights_reviewed_at_invalid"]);
  });

  it("rejects evidence whose directional summary contradicts its spans", () => {
    expect(
      routingEvidenceReasons(
        {
          ...base,
          direction_mode: "forward",
          segments: [{ ...base.segments[0]!, direction: "reverse" }],
        },
        new Date("2026-09-11T10:00:00.000Z"),
      ),
    ).toContain("segment_direction_mismatch");
  });
});
