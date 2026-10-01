import { buildRegistry, kernelModule, observationId } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { hazardsModule } from "../module.js";

const registry = buildRegistry([kernelModule, hazardsModule]);

const base = (cls: "situation" | "observation", localId: string, geometry: object) => ({
  id: `oc:${cls}:us-nifc:${localId}`,
  temporality: "live",
  location: { geometry, extent: "area", geometryOrigin: "source", fuzziness: "exact" },
  provenance: {
    origin: "feed",
    sourceId: "us-nifc",
    sourceFormat: "derived",
    accessMode: "bulk",
    recordId: localId,
    attribution: { provider: "National Interagency Fire Center", license: "public-domain" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: "2026-10-01T00:30:00Z" },
});

const perimeter = {
  ...base("situation", "DB5448A6-FCAC-4041-A817-6F8198161DBA", {
    type: "Polygon",
    coordinates: [
      [
        [-116.9, 44.6],
        [-116.8, 44.6],
        [-116.8, 44.7],
        [-116.9, 44.6],
      ],
    ],
  }),
  class: "situation",
  kind: "natural_hazard",
  type: "wildfire",
  subtype: "wildfire_perimeter",
  externalIds: [{ scheme: "irwin", id: "DB5448A6-FCAC-4041-A817-6F8198161DBA" }],
  planned: false,
  certainty: "observed",
  severity: { label: "unknown" },
  validity: { status: "active", start: "2026-07-24T16:00:00.000Z" },
  effects: [],
  details: {
    kind: "natural_hazard",
    v: 1,
    name: [{ lang: "en", text: "Tartar" }],
    areaHa: 63950.9,
    containmentPct: 100,
    ignitionCause: "natural",
  },
};

const withDetails = (details: object) => ({
  ...perimeter,
  details: { kind: "natural_hazard", v: 1, ...details },
});

describe("natural hazards", () => {
  it("registers a fire perimeter with what the registers publish about it", () => {
    expect(registry.validateDraft(perimeter).ok).toBe(true);
  });

  it("registers an earthquake with its magnitude and its depth in metres", () => {
    const { subtype: _, ...quake } = {
      ...withDetails({
        magnitude: { value: 5.6, scale: "mww" },
        depth: { value: 8000, unit: "m" },
      }),
      type: "earthquake",
    };
    expect(registry.validateDraft(quake).ok).toBe(true);
    const km = {
      ...quake,
      details: { kind: "natural_hazard", v: 1, depth: { value: 8, unit: "km" } },
    };
    expect(registry.validateDraft(km).ok).toBe(false);
  });

  it("names a fire's cause only in the words registers use", () => {
    expect(registry.validateDraft(withDetails({ ignitionCause: "lightning" })).ok).toBe(false);
  });

  it("refuses a fire contained beyond its whole perimeter", () => {
    expect(registry.validateDraft(withDetails({ containmentPct: 150 })).ok).toBe(false);
  });

  it("observes a satellite fire pixel at its location and refuses a negative reading", () => {
    const draft = {
      ...base("observation", "x", { type: "Point", coordinates: [31.67576, 45.2613] }),
      class: "observation",
      kind: "observation",
      property: "fire.frp",
      subject: { kind: "location" },
      result: { type: "quantity", value: 14.13, unit: "MW" },
      phenomenonTime: { instant: "2026-09-29T02:02:00Z" },
      aggregation: "instantaneous",
      quality: { confidence: 0.83 },
    };
    expect(
      registry.validateDraft({ ...draft, id: observationId("us-nifc", draft as never) }).ok,
    ).toBe(true);
    const negative = { ...draft, result: { type: "quantity", value: -2.5, unit: "MW" } };
    expect(
      registry.validateDraft({ ...negative, id: observationId("us-nifc", negative as never) }).ok,
    ).toBe(false);
    expect(registry.property("fire.brightness")?.result).toEqual({ type: "quantity", unit: "K" });
    expect(registry.property("fire.frp")?.domain).toBe("hazards");
  });
});
