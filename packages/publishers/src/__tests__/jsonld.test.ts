import { describe, expect, it } from "vitest";
import { observationsToJsonLd } from "../jsonld.js";
import { measurement, roadEvent } from "./fixture.js";

describe("observationsToJsonLd", () => {
  it("wraps the GeoJSON with a SOSA/Schema.org @context", () => {
    const doc = observationsToJsonLd([roadEvent()]);
    expect(Array.isArray(doc["@context"])).toBe(true);
    const ctx = doc["@context"] as unknown[];
    expect(ctx[0]).toContain("geojson-ld");
    expect(ctx[1]).toMatchObject({
      sosa: "http://www.w3.org/ns/sosa/",
      schema: "https://schema.org/",
    });
    expect(doc.type).toBe("FeatureCollection");
    expect(doc.features).toHaveLength(1);
  });

  it("types each event feature as schema:SpecialAnnouncement with @id, inheriting the full payload", () => {
    const doc = observationsToJsonLd([roadEvent({ speedLimitKph: 50 })]);
    const p = doc.features[0]!.properties as Record<string, unknown>;
    expect(p["@type"]).toBe("schema:SpecialAnnouncement");
    expect(p["@id"]).toBe("ndw:1");
    expect(p["speedLimitKph"]).toBe(50); // inherits the full GeoJSON property payload
  });

  it("types measurements as sosa:Observation", () => {
    const doc = observationsToJsonLd([measurement()]);
    expect((doc.features[0]!.properties as Record<string, unknown>)["@type"]).toBe(
      "sosa:Observation"
    );
  });
});
