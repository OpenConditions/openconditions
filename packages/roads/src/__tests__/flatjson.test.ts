import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FEED_SOURCES, feedToSourceDescriptor } from "../feeds.js";
import { parseFlatJson } from "../flatjson.js";
import type { SourceDescriptor } from "../types.js";

describe("parseFlatJson", () => {
  it("reads a bare JSON array, building points from lon/lat fields", () => {
    const src: SourceDescriptor = {
      id: "t",
      attribution: "T",
      country: "XX",
      license: "CC0-1.0",
      geojson: { lonField: "lng", latField: "lat", typeField: "kind", headlineField: "title" },
    };
    const out = parseFlatJson(
      JSON.stringify([{ kind: "roadworks", title: "Works", lng: 100.5, lat: 13.7 }]),
      src
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceFormat).toBe("flatjson");
    expect(out[0]!.type).toBe("roadworks");
    expect(out[0]!.geometry).toEqual({ type: "Point", coordinates: [100.5, 13.7] });
  });

  it("reads records from a nested arrayPath (LTA-style {value:[…]})", () => {
    const src: SourceDescriptor = {
      id: "t",
      attribution: "T",
      country: "XX",
      license: "CC0-1.0",
      geojson: { arrayPath: "value", lonField: "Longitude", latField: "Latitude" },
    };
    const out = parseFlatJson(
      JSON.stringify({ value: [{ Latitude: 1.3, Longitude: 103.8 }] }),
      src
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.geometry).toEqual({ type: "Point", coordinates: [103.8, 1.3] });
  });

  it("skips records without coordinates and tolerates malformed input", () => {
    const src: SourceDescriptor = {
      id: "t",
      attribution: "T",
      country: "XX",
      license: "CC0-1.0",
      geojson: { lonField: "lng", latField: "lat" },
    };
    expect(parseFlatJson(JSON.stringify([{ lat: 1 }]), src)).toEqual([]);
    expect(parseFlatJson("not json", src)).toEqual([]);
  });

  it("parses the Longdo (Thailand) fixture via the registered mapping", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "longdo-th")!;
    const buf = readFileSync(join(import.meta.dirname, "fixtures/longdo-th/events.json"));
    const out = parseFlatJson(buf, feedToSourceDescriptor(feed));
    expect(out.length).toBeGreaterThan(0);
    const g = out[0]!.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    expect(g.coordinates[0]!).toBeGreaterThan(97);
    expect(g.coordinates[0]!).toBeLessThan(106);
    expect(g.coordinates[1]!).toBeGreaterThan(5);
    expect(g.coordinates[1]!).toBeLessThan(21);
  });
});
