import type { SegmentConditionRow } from "@openconditions/core";
import type { Effect } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { segmentConditionsToJson } from "../segment-conditions.js";
import { closure, segmentRow as row } from "./segment-rows.js";

const at = new Date("2026-09-06T10:00:00Z");
const project = (rows: SegmentConditionRow[]) =>
  segmentConditionsToJson(rows, at, { resolverVersion: "2.0.0" });

describe("segmentConditionsToJson", () => {
  it("emits one condition per effect with its binding, evidence and span geometry", () => {
    const out = project([row()]);
    expect(out).toMatchObject({ schema_version: 2, complete: true, resolver_version: "2.0.0" });
    expect(out.conditions[0]).toMatchObject({
      id: "oc:situation:de-autobahn-events:a1#a1/closure",
      kind: "closure",
      severity: "major",
      effect: closure,
      origin: "feed",
      routing_eligible: true,
      binding: { status: "exact", confidence: 0.96, direction_mode: "single" },
      segments: [{ way_id: 10, dir: "f", start_fraction: 0.3, end_fraction: 1 }],
    });
    expect(out.conditions[0]!.routing_evidence).toMatchObject({
      schema_version: 2,
      record_class: "situation",
      record_id: "oc:situation:de-autobahn-events:a1",
      effect_id: "a1/closure",
      record_revision: 3,
      binding_revision: 3,
      effect_kind: "closure",
      direction_mode: "forward",
      applicability: { kind: "all" },
      reason_codes: [],
    });
  });

  it("drops an effect whose binding resolved an older revision", () => {
    expect(project([row({ binding_revision: 2 })]).conditions).toEqual([]);
  });

  it("drops a binding whose segment vanished from the active graph", () => {
    const [span] = row().segments;
    expect(project([row({ segments: [{ ...span!, geometry: null }] })]).conditions).toEqual([]);
  });

  it("drops a binding produced by another resolver version", () => {
    expect(project([row({ binding_resolver_version: "1.2.0" })]).conditions).toEqual([]);
  });

  it("drops an ambiguous binding and a source past its freshness deadline", () => {
    expect(project([row({ binding_status: "ambiguous" })]).conditions).toEqual([]);
    expect(project([row({ fresh_until: "2026-09-06T09:59:00Z" })]).conditions).toEqual([]);
  });

  it("names the parent policy source while keeping the child it came from", () => {
    const [c] = project([
      row({ routing_source_id: "de-parent", child_source_id: "de-autobahn-events" }),
    ]).conditions;
    expect(c?.source).toBe("de-autobahn-events");
    expect(c?.routing_evidence).toMatchObject({
      source_id: "de-parent",
      child_source_id: "de-autobahn-events",
    });
  });

  it("routes an effect only while its own window is open", () => {
    const later = { ...closure, validity: { status: "active", start: "2026-09-06T20:00:00Z" } };
    expect(project([row({ effect: later as Effect })]).conditions).toEqual([]);
    const [c] = project([
      row({
        effect: {
          ...closure,
          validity: {
            status: "active",
            start: "2026-09-06T09:00:00Z",
            end: "2026-09-06T11:00:00Z",
          },
        } as Effect,
      }),
    ]).conditions;
    expect(c?.routing_evidence).toMatchObject({
      valid_from: "2026-09-06T09:00:00Z",
      valid_to: "2026-09-06T11:00:00Z",
      next_transition_at: "2026-09-06T11:00:00.000Z",
    });
  });

  it("drops a crowd effect its situation's evidence has not made routing eligible", () => {
    expect(project([row({ origin: "crowd", routing_eligible: false })]).conditions).toEqual([]);
    expect(project([row({ origin: "crowd", routing_eligible: true })]).conditions).toHaveLength(1);
  });

  it("keeps a class-specific scope for the consumer to evaluate", () => {
    const trucks = {
      ...closure,
      applicability: { kind: "classes", include: [{ class: "truck" }] },
    };
    const [c] = project([row({ effect: trucks as Effect })]).conditions;
    expect(c?.routing_evidence.applicability).toEqual({
      kind: "classes",
      include: [{ class: "truck" }],
    });
  });

  it("lists restriction evidence with the reasons it may not route", () => {
    const unknown = {
      ...closure,
      applicability: { kind: "unknown", raw: ["lorries over 7.5 t"] },
    } as Effect;
    const partial = { ...closure, id: "a1/partial", normalization: "partial" } as Effect;
    const out = project([
      row({ effect: unknown }),
      row({ effect_id: "a1/partial", effect: partial }),
    ]);
    expect(out.conditions.map((c) => c.routing_evidence.reason_codes)).toEqual([
      ["applicability_unknown"],
      ["not_normalized"],
    ]);
  });
});
