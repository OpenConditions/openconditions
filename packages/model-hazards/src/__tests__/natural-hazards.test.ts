import { buildRegistry, kernelModule, observationId } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { HAZARDS_SOURCE_FORMATS, hazardsModule } from "../module.js";

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

/** A hazard of another type, without the fire's subtype and IRWIN id. */
function hazard(type: string, details: object, rest: object = {}) {
  const { subtype: _, externalIds: __, ...base } = withDetails(details);
  return { ...base, type, ...rest };
}
const amend = (draft: { details: object }, details: object) => ({
  ...draft,
  details: { ...draft.details, ...details },
});
const valid = (draft: object) => registry.validateDraft(draft).ok;

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
    expect(registry.property("fire.frp")?.domain).toBe("hazards");
  });

  it("keeps each fire pixel's power as a transient reading and no brightness", () => {
    expect(registry.property("fire.frp")?.transient).toBe(true);
    expect(registry.property("fire.frp")?.retention).toEqual({ rawDays: 7 });
    expect(registry.property("fire.brightness")).toBeUndefined();
  });

  it("covers the hazards the event registers publish", () => {
    const types = registry.kind("situation", "natural_hazard")?.types ?? {};
    for (const t of ["tropical_cyclone", "volcano", "drought", "sea_ice"]) {
      expect(types[t]).toBeDefined();
    }
    expect(types["tropical_cyclone"]).toEqual([
      "tropical_depression",
      "tropical_storm",
      "hurricane",
      "typhoon",
      "cyclone",
    ]);
    expect(types["sea_ice"]).toEqual(["iceberg", "lake_ice"]);
    const storm = hazard(
      "tropical_cyclone",
      {
        name: [{ lang: "en", text: "Tropical Storm Simon" }],
        maxWind: { value: 95, unit: "km/h" },
        populationAffected: 120000,
        detailUrl: "https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001234",
      },
      {
        subtype: "tropical_storm",
        externalIds: [
          { scheme: "gdacs:event", id: "TC1001234" },
          { scheme: "glide", id: "TC-2026-000123-PHL" },
        ],
      },
    );
    expect(valid(storm)).toBe(true);
    expect(valid(amend(storm, { maxWind: { value: 26, unit: "m/s" } }))).toBe(false);
    expect(valid(amend(storm, { populationAffected: -1 }))).toBe(false);
  });

  it("registers what USGS publishes about an earthquake, a depth above sea level included", () => {
    const quake = hazard(
      "earthquake",
      {
        magnitude: { value: 2.1, scale: "ml" },
        depth: { value: -3370, unit: "m" },
        tsunamiFlag: true,
        feltReports: 4,
        mmi: 7.654,
        reviewed: true,
        detailUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u0xi",
      },
      { validity: { status: "ended", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:00:00Z" } },
    );
    expect(valid(quake)).toBe(true);
    expect(valid(amend(quake, { mmi: 12.5 }))).toBe(false);
    expect(valid(amend(quake, { feltReports: 1.5 }))).toBe(false);
    expect(valid(amend(quake, { feltReports: -1 }))).toBe(false);
    expect(valid(amend(quake, { depth: { value: -3.37, unit: "km" } }))).toBe(false);
    expect(valid(amend(quake, { detailUrl: "eventpage/us6000u0xi" }))).toBe(false);
  });

  it("keeps a smoke plume current while its analysis window has closed", () => {
    const smoke = hazard(
      "smoke",
      {
        density: "light",
        detection: {
          satellite: "GOES-WEST",
          start: "2026-10-08T12:00:00Z",
          end: "2026-10-08T15:00:00Z",
        },
      },
      { validity: { status: "active", start: "2026-10-08T12:00:00Z" } },
    );
    expect(valid(smoke)).toBe(true);
    expect(valid(amend(smoke, { detection: { start: "2026-10-08 12:00" } }))).toBe(false);
  });

  it("records when a fire's perimeter was mapped", () => {
    expect(valid(withDetails({ perimeterAt: "2026-07-24T18:30:00Z" }))).toBe(true);
  });

  it("registers the geocode schemes of MeteoAlarm's areas without a shape source", () => {
    const schemes = registry.vocabulary("admin_geocode_scheme")!;
    expect(schemes.values).toContain("cisorp");
    expect(schemes.values).toContain("fips10_4");
    expect(schemes.values).toContain("fips");
  });

  it("contributes the hazards source formats", () => {
    const formats = registry.vocabulary("source_format")!;
    for (const id of HAZARDS_SOURCE_FORMATS) expect(formats.contributedBy[id]).toBe("hazards");
    expect([...HAZARDS_SOURCE_FORMATS]).toEqual([
      "cap",
      "nws",
      "meteoalarm",
      "firms",
      "wfigs",
      "effis",
      "hms",
      "usgs",
      "eonet",
      "gdacs",
    ]);
  });
});
