import { buildRegistry, kernelModule, observationId } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { borderModule } from "../module.js";

const registry = buildRegistry([kernelModule, borderModule]);

const base = (cls: "feature" | "observation", localId: string) => ({
  id: `oc:${cls}:us-cbp-bwt:${localId}`,
  temporality: cls === "feature" ? "static" : "live",
  location: {
    geometry: null,
    extent: "point",
    geometryOrigin: "none",
    fuzziness: "exact",
    admin: { country: "US", subdivision: "US-NY" },
  },
  provenance: {
    origin: "feed",
    sourceId: "us-cbp-bwt",
    sourceFormat: "derived",
    accessMode: "bulk",
    recordId: localId,
    attribution: { provider: "U.S. Customs and Border Protection", license: "public-domain" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: "2026-09-29T21:07:00Z" },
});

const lane = (key: string, details: object) => ({
  key,
  kind: "lane_group",
  details: { kind: "lane_group", v: 1, ...details },
});

const crossing = {
  ...base("feature", "070801"),
  class: "feature",
  kind: "border_crossing",
  name: [{ lang: "en", text: "Alexandria Bay: Thousand Islands Bridge" }],
  lifecycle: "operational",
  externalIds: [{ scheme: "cbp:port", id: "070801" }],
  components: [
    lane("commercial/standard", {
      mode: "commercial",
      program: "standard",
      direction: { from: "CA", to: "US" },
      lanesTotal: 5,
    }),
    lane("passenger/trusted_traveller", {
      mode: "passenger",
      program: "trusted_traveller",
      direction: { from: "CA", to: "US" },
    }),
  ],
  details: {
    kind: "border_crossing",
    v: 1,
    countries: ["CA", "US"],
    modes: ["commercial", "passenger"],
  },
};

const wait = (value: object, componentKey = "commercial/standard") => {
  const draft = {
    ...base("observation", "x"),
    class: "observation",
    kind: "observation",
    property: "border.wait",
    subject: { kind: "feature", featureId: crossing.id, componentKey },
    result: { type: "structured", schema: "border_wait", v: 1, value: { v: 1, ...value } },
    phenomenonTime: { instant: "2026-09-29T20:00:00Z" },
    aggregation: "instantaneous",
  };
  return { ...draft, id: observationId("us-cbp-bwt", draft as never) };
};

describe("border module", () => {
  it("registers a crossing whose queues are lane groups, located by its admin area alone", () => {
    const result = registry.validateDraft(crossing);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("rejects a crossing or a queue that stays in one country", () => {
    expect(
      registry.validateDraft({
        ...crossing,
        details: { ...crossing.details, countries: ["US", "US"] },
      }).ok,
    ).toBe(false);
    expect(
      registry.validateDraft({
        ...crossing,
        components: [lane("x", { mode: "passenger", direction: { from: "US", to: "US" } })],
      }).ok,
    ).toBe(false);
  });

  it("splits a queue by vehicle class where a source does so instead of by programme", () => {
    const trucks = {
      ...crossing,
      components: [
        lane("truck/UA-PL", {
          mode: "commercial",
          vehicleClass: "truck",
          direction: { from: "UA", to: "PL" },
        }),
      ],
    };
    expect(registry.validateDraft(trucks).ok).toBe(true);
  });

  it("accepts a few minutes under no delay, and a paused queue that keeps its length", () => {
    expect(
      registry.validateDraft(wait({ status: "no_delay", waitMinutes: 3, lanesOpen: 3 })).ok,
    ).toBe(true);
    expect(
      registry.validateDraft(
        wait({ status: "delay", waitMinutes: 714, vehiclesInQueue: 212, paused: true }),
      ).ok,
    ).toBe(true);
    expect(registry.validateDraft(wait({ status: "open" })).ok).toBe(false);
  });

  it("rejects an impossible reading instead of storing it", () => {
    expect(registry.validateDraft(wait({ status: "delay", waitMinutes: -5 })).ok).toBe(false);
    expect(registry.validateDraft(wait({ status: "delay", lanesOpen: 1.5 })).ok).toBe(false);
  });

  it("keeps no rollup of a structured wait", () => {
    expect(registry.property("border.wait")?.retention).toEqual({ rawDays: 30 });
  });
});
