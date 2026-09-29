import { buildRegistry, kernelModule, observationId } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  DATEX2_OPENING_STATUSES_OUT,
  DATEX2_V2_OPENING_STATUSES,
  DATEX2_V3_OPENING_STATUSES,
} from "../crosswalk/datex2.js";
import { facilitiesModule } from "../module.js";
import { DATEX2_OPENING_STATUSES } from "../vocabularies/datex2.js";

const registry = buildRegistry([kernelModule, facilitiesModule]);

const base = (cls: "feature" | "observation", localId: string) => ({
  id: `oc:${cls}:no-nvdb:${localId}`,
  temporality: cls === "feature" ? "static" : "live",
  location: {
    geometry: { type: "Point", coordinates: [6.65686224, 59.0499312] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  },
  provenance: {
    origin: "feed",
    sourceId: "no-nvdb",
    sourceFormat: "derived",
    accessMode: "bulk",
    recordId: localId,
    attribution: { provider: "Statens vegvesen", license: "NLOD-2.0" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: "2026-09-29T21:10:00Z" },
});

const restArea = {
  ...base("feature", "80092187"),
  class: "feature",
  kind: "rest_area",
  type: "rest_area",
  name: [{ lang: "nb", text: "Lysebotn" }],
  lifecycle: "operational",
  amenities: ["toilets", "fresh_water"],
  details: {
    kind: "rest_area",
    v: 1,
    direction: { value: "both", basis: "road_reference" },
    seasonalClosure: { from: "11-30", to: "05-01" },
    paved: false,
  },
};

const unmapped = (values: readonly string[], table: Readonly<Record<string, unknown>>) =>
  values.filter((v) => !(`openingStatus:${v}` in table));

describe("facilities module", () => {
  it("registers rest areas and weigh stations as operated sites", () => {
    expect(registry.kinds("feature").map((k) => k.code)).toEqual(["rest_area", "weigh_station"]);
    for (const code of ["rest_area", "weigh_station"]) {
      expect(registry.kind("feature", code)?.traits).toEqual(["operated_site"]);
    }
  });

  it("keeps a rest area's winter closure and its season in the source's words", () => {
    expect(registry.validateDraft(restArea).ok).toBe(true);
    const season = {
      ...restArea,
      details: {
        kind: "rest_area",
        v: 1,
        season: [{ lang: "en", text: "Victoria Day to Thanksgiving Day" }],
      },
    };
    expect(registry.validateDraft(season).ok).toBe(true);
  });

  it("describes a weigh station by how it weighs", () => {
    const station = {
      ...base("feature", "78858021"),
      class: "feature",
      kind: "weigh_station",
      type: "control_area",
      lifecycle: "operational",
      openingHours: { osm: "24/7", twentyFourSeven: true },
      details: { kind: "weigh_station", v: 1, scaleType: "static", truckSpaces: 2 },
    };
    expect(registry.validateDraft(station).ok).toBe(true);
    expect(
      registry.validateDraft({ ...station, details: { ...station.details, scaleType: "mobile" } })
        .ok,
    ).toBe(false);
  });

  it("observes the open status of any operated site", () => {
    const draft = {
      ...base("observation", "x"),
      class: "observation",
      kind: "observation",
      property: "facility.open_status",
      subject: { kind: "feature", featureId: restArea.id },
      result: { type: "category", value: "closed", vocabulary: "facility_open_status" },
      phenomenonTime: { instant: "2026-09-29T21:00:00Z" },
      aggregation: "instantaneous",
    };
    expect(
      registry.validateDraft({ ...draft, id: observationId("no-nvdb", draft as never) }).ok,
    ).toBe(true);
    expect(registry.property("facility.open_status")?.subjects).toEqual([
      { kind: "feature", traits: ["operated_site"] },
    ]);
  });

  it("maps every DATEX opening status of both versions", () => {
    expect(unmapped(DATEX2_OPENING_STATUSES.v3, DATEX2_V3_OPENING_STATUSES)).toEqual([]);
    expect(unmapped(DATEX2_OPENING_STATUSES.v2, DATEX2_V2_OPENING_STATUSES)).toEqual([]);
    const cw = registry.crosswalk;
    expect(cw.value("facility_open_status", "datex2_v3", "openingStatus:closedOnMaintenance")).toBe(
      "closed",
    );
    expect(
      cw.value("facility_open_status", "datex2_v2", "openingStatus:openingTimesInForce"),
    ).toBeUndefined();
    expect(Object.keys(DATEX2_OPENING_STATUSES_OUT)).toEqual([
      "open",
      "restricted",
      "closed",
      "unknown",
    ]);
  });
});
