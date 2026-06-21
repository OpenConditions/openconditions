import { describe, it, expect } from "vitest";
import { observationsByBbox } from "../observationsByBbox.js";
import { severityRank } from "../severity.js";

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
  origin: {
    kind: "feed",
    attribution: { provider: "NDW", license: "CC0-1.0", url: "https://www.ndw.nu" },
  },
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

  it("forwards optional types filter without error", async () => {
    const sql = makeStubSql([]);
    const fc = await observationsByBbox(sql, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
      types: ["accident", "roadwork"],
    });

    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(0);
  });

  it("passes minSeverity rank as a bound integer value", async () => {
    const allValues: unknown[] = [];
    const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      allValues.push(...values);
      return [];
    };

    await observationsByBbox(sql as unknown as import("postgres").Sql, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
      minSeverity: "high",
    });

    expect(allValues).toContain(3);
  });

  it("ORDER BY uses the severity CASE rank expression, not the raw text column", async () => {
    const capturedStrings: string[] = [];
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      capturedStrings.push(...strings);
      void values;
      return [];
    };

    await observationsByBbox(sql as unknown as import("postgres").Sql, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });

    const fullQuery = capturedStrings.join("");
    expect(fullQuery).toMatch(/ORDER BY.*CASE severity/s);
    expect(fullQuery).not.toMatch(/ORDER BY severity/s);
  });
});

describe("severityRank", () => {
  it("returns correct ranks for all canonical severity values", () => {
    expect(severityRank("critical")).toBe(4);
    expect(severityRank("high")).toBe(3);
    expect(severityRank("medium")).toBe(2);
    expect(severityRank("low")).toBe(1);
  });

  it("returns 0 for unknown/none/null/undefined", () => {
    expect(severityRank("unknown")).toBe(0);
    expect(severityRank("none")).toBe(0);
    expect(severityRank(null)).toBe(0);
    expect(severityRank(undefined)).toBe(0);
    expect(severityRank("")).toBe(0);
  });

  it("ranks are strictly ordered: critical > high > medium > low > 0", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("medium"));
    expect(severityRank("medium")).toBeGreaterThan(severityRank("low"));
    expect(severityRank("low")).toBeGreaterThan(0);
  });
});
