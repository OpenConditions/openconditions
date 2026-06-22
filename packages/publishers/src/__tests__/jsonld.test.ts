import { describe, expect, it } from "vitest";
import { observationsToJsonLd } from "../jsonld.js";
import { roadEvent } from "./fixture.js";

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
});
