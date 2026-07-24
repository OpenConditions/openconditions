import { describe, expect, it } from "vitest";
import { roadFeedSchema } from "../feed-schema.js";

const berlin = {
  subdivision: "be",
  operator: "berlin",
  name: "VIZ Berlin roadworks & closures",
  format: "geojson",
  url: "https://api.viz.berlin.de/daten/baustellen_sperrungen_viz.json",
  geojson: {
    idField: "id",
    typeField: "subtype",
    typeMap: { Baustelle: "roadworks", Sperrung: "road_closure" },
    defaultType: "other",
    headlineField: "content",
    roadField: "street",
    severityField: "severity",
    severityMap: { Vollsperrung: "high", "keine Sperrung": "low" },
    updatedField: "tstore",
  },
  cadenceSec: 600,
  freshnessWindowSec: 1800,
  license: "dl-de/by-2-0",
  licenseUrl: "https://daten.berlin.de/",
  attribution: "Verkehrsinformationszentrale Berlin (VIZ)",
  country: "DE",
  privacyUrl: "https://www.berlin.de/datenschutzerklaerung/",
};

describe("roadFeedSchema", () => {
  it("parses a roads geojson feed", () => {
    expect(roadFeedSchema.parse(berlin).id).toBe("de-be-berlin");
  });

  it("rejects a typeMap value that is not a RoadEventType", () => {
    const bad = { ...berlin, geojson: { ...berlin.geojson, typeMap: { Baustelle: "not-a-type" } } };
    expect(roadFeedSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown top-level key on a roads feed too", () => {
    expect(roadFeedSchema.safeParse({ ...berlin, discover: "x" }).success).toBe(false);
  });
});
