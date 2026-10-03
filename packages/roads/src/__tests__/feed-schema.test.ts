import { type IngestDomain, regionFileJsonSchema } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { roadsDomain } from "../domain.js";
import { roadsFeedShape } from "../feed-schema.js";

const roadsFeedSchema = z.object(roadsFeedShape).strict();

const berlin = {
  subdivision: "be",
  operator: "berlin",
  product: "events",
  name: "VIZ Berlin roadworks & closures",
  format: "geojson",
  endpoints: {
    main: {
      url: "https://api.viz.berlin.de/daten/baustellen_sperrungen_viz.json",
      cadenceSec: 600,
    },
  },
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
  freshnessWindowSec: 1800,
  license: "DL-DE-BY-2.0",
  licenseUrl: "https://daten.berlin.de/",
  attribution: "Verkehrsinformationszentrale Berlin (VIZ)",
  privacyUrl: "https://www.berlin.de/datenschutzerklaerung/",
  tier: "authoritative",
};

describe("roadsFeedShape", () => {
  it("parses a roads geojson feed", () => {
    expect(roadsFeedSchema.safeParse(berlin).success).toBe(true);
  });

  it("carries lane numbering, which the base feed does not", () => {
    expect(roadsFeedSchema.safeParse({ ...berlin, laneNumbering: "left_first" }).success).toBe(
      true,
    );
    expect(roadsFeedSchema.safeParse({ ...berlin, laneNumbering: "right_first" }).success).toBe(
      false,
    );
  });

  it("names reference data as an endpoint, not a site table or station registry field", () => {
    const siteTable = { url: "https://example.test/sites.xml" };
    expect(roadsFeedSchema.safeParse({ ...berlin, siteTable }).success).toBe(false);
    expect(roadsFeedSchema.safeParse({ ...berlin, stationRegistry: siteTable }).success).toBe(
      false,
    );
  });

  it("rejects a typeMap value that is not a RoadEventType", () => {
    const bad = { ...berlin, geojson: { ...berlin.geojson, typeMap: { Baustelle: "not-a-type" } } };
    expect(roadsFeedSchema.safeParse(bad).success).toBe(false);
  });

  it("takes a registered situation code as a typeMap value, and only a registered one", () => {
    const withCode = (code: string) => ({
      ...berlin,
      geojson: { ...berlin.geojson, typeMap: { Baustelle: code } },
    });
    expect(roadsFeedSchema.safeParse(withCode("incident.accident.fatal")).success).toBe(true);
    expect(roadsFeedSchema.safeParse(withCode("incident.accident")).success).toBe(true);
    expect(roadsFeedSchema.safeParse(withCode("incident.accident.knitting")).success).toBe(false);
    expect(roadsFeedSchema.safeParse(withCode("incident")).success).toBe(false);
  });

  it("gives every typeMap value a JSON Schema: the event types and the registered codes", () => {
    type Json = { properties: { feeds: { items: { properties: Record<string, unknown> } } } };
    const feed = (regionFileJsonSchema(roadsDomain as unknown as IngestDomain) as Json).properties
      .feeds.items;
    const geojson = feed.properties["geojson"] as {
      properties: { typeMap: { additionalProperties: { anyOf: { enum?: string[] }[] } } };
    };
    const [types, codes] = geojson.properties.typeMap.additionalProperties.anyOf;
    expect(types?.enum).toContain("roadworks");
    expect(codes?.enum).toEqual(
      expect.arrayContaining(["incident.accident", "incident.accident.fatal"]),
    );
    expect(codes?.enum).not.toContain("incident.accident.knitting");
  });

  it("rejects an unknown top-level key on a roads feed too", () => {
    expect(roadsFeedSchema.safeParse({ ...berlin, discover: "x" }).success).toBe(false);
  });

  it("accepts validity-date fields, a record filter and start/end coordinates", () => {
    const extended = {
      ...berlin,
      geojson: {
        ...berlin.geojson,
        validFromField: "debut",
        validToField: "fin",
        filter: [{ field: "ROADCONDITION", exclude: ["Easily passable"] }],
        startLonField: "STARTX",
        startLatField: "STARTY",
        endLonField: "ENDX",
        endLatField: "ENDY",
      },
    };
    expect(roadsFeedSchema.safeParse(extended).success).toBe(true);
  });

  it("rejects an unknown key inside a filter entry", () => {
    const bad = {
      ...berlin,
      geojson: { ...berlin.geojson, filter: [{ field: "x", contains: ["y"] }] },
    };
    expect(roadsFeedSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a filter entry with no field", () => {
    const bad = { ...berlin, geojson: { ...berlin.geojson, filter: [{ include: ["y"] }] } };
    expect(roadsFeedSchema.safeParse(bad).success).toBe(false);
  });
});
