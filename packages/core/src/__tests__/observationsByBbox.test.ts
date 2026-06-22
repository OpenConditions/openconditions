import { describe, it, expect } from "vitest";
import { observationsByBbox, type QueryRunner } from "../observationsByBbox.js";
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

// Stub the OpenMapX `ctx.db` (DatabaseClient) interface: execute(query, params) → rows.
function makeStubDb(rows: unknown[]): QueryRunner {
  return {
    async execute<T = unknown>(_query: string, _params?: unknown[]): Promise<T> {
      return rows as T;
    },
  };
}

describe("observationsByBbox", () => {
  it("maps database rows to a GeoJSON FeatureCollection", async () => {
    const fc = await observationsByBbox(makeStubDb([fakeRow]), {
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
    const fc = await observationsByBbox(makeStubDb([fakeRow]), {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });

    expect(fc.features[0].properties?.attribution).toEqual({
      provider: "NDW",
      license: "CC0-1.0",
      url: "https://www.ndw.nu",
    });
  });

  it("returns an empty FeatureCollection when no rows match", async () => {
    const fc = await observationsByBbox(makeStubDb([]), {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });

    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(0);
  });

  it("passes domain + bbox as positional bind parameters ($1..$5)", async () => {
    let capturedParams: unknown[] = [];
    const db: QueryRunner = {
      async execute<T = unknown>(_q: string, p?: unknown[]): Promise<T> {
        capturedParams = p ?? [];
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    expect(capturedParams).toEqual(["roads", 4.0, 51.0, 6.0, 53.0]);
  });

  it("appends a typed array param for the types filter", async () => {
    let capturedQuery = "";
    let capturedParams: unknown[] = [];
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
        capturedQuery = q;
        capturedParams = p ?? [];
        return [] as T;
      },
    };
    await observationsByBbox(db, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
      types: ["accident", "roadworks"],
    });
    expect(capturedQuery).toMatch(/type = ANY\(\$6::text\[\]\)/);
    expect(capturedParams[5]).toEqual(["accident", "roadworks"]);
  });

  it("passes minSeverity as a bound integer rank", async () => {
    let capturedParams: unknown[] = [];
    const db: QueryRunner = {
      async execute<T = unknown>(_q: string, p?: unknown[]): Promise<T> {
        capturedParams = p ?? [];
        return [] as T;
      },
    };
    await observationsByBbox(db, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
      minSeverity: "high",
    });
    expect(capturedParams).toContain(3);
  });

  it("ORDER BY uses the severity CASE rank expression, not the raw text column", async () => {
    let capturedQuery = "";
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, _p?: unknown[]): Promise<T> {
        capturedQuery = q;
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    expect(capturedQuery).toMatch(/ORDER BY.*CASE severity/s);
    expect(capturedQuery).not.toMatch(/ORDER BY severity\b/);
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
