import { describe, it, expect } from "vitest";
import { observationsByBbox } from "../observationsByBbox.js";

const fakeRow = {
  id: "evt-001",
  source: "ndw",
  domain: "roads",
  kind: "event",
  type: "accident",
  severity: "high",
  headline: "Multi-vehicle collision",
  description: "Three vehicles involved",
  attributes: { roads: ["A2"] },
  valid_to: "2026-06-22T10:00:00Z",
  geojson: JSON.stringify({ type: "Point", coordinates: [5.1234, 52.5678] }),
  origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0", url: "https://www.ndw.nu" } },
  is_stale: false,
};

function makeStubSql(rows: unknown[]) {
  const stub = async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows;
  return stub as unknown as import("postgres").Sql;
}

describe("observationsByBbox", () => {
  it("maps database rows to a GeoJSON FeatureCollection", async () => {
    const sql = makeStubSql([fakeRow]);
    const fc = await observationsByBbox(sql, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });

    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);

    const feat = fc.features[0];
    expect(feat.type).toBe("Feature");
    expect(feat.geometry).toEqual({ type: "Point", coordinates: [5.1234, 52.5678] });
    expect(feat.properties?.id).toBe("evt-001");
    expect(feat.properties?.severity).toBe("high");
    expect(feat.properties?.headline).toBe("Multi-vehicle collision");
    expect(feat.properties?.source).toBe("ndw");
  });

  it("includes origin.attribution on the feature properties", async () => {
    const sql = makeStubSql([fakeRow]);
    const fc = await observationsByBbox(sql, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });

    const feat = fc.features[0];
    expect(feat.properties?.attribution).toEqual({
      provider: "NDW",
      license: "CC0-1.0",
      url: "https://www.ndw.nu",
    });
  });

  it("returns an empty FeatureCollection when no rows match", async () => {
    const sql = makeStubSql([]);
    const fc = await observationsByBbox(sql, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });

    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(0);
  });

  it("forwards optional types filter", async () => {
    let capturedValues: unknown[] = [];
    const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      capturedValues = values;
      return [];
    };
    await observationsByBbox(sql as unknown as import("postgres").Sql, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
      types: ["accident", "roadwork"],
    });

    expect(capturedValues).toContain("roads");
    expect(capturedValues).toContainEqual(["accident", "roadwork"]);
  });
});
