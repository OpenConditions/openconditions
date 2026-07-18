import { describe, it, expect } from "vitest";
import { observationsByBbox, type QueryRunner } from "../observationsByBbox.js";
import { severityRank } from "../severity.js";

const fakeRow = {
  id: "evt-001",
  source: "nl-ndw",
  domain: "roads",
  kind: "event",
  type: "accident",
  severity: "high",
  headline: "Multi-vehicle collision",
  description: "Three vehicles involved",
  attributes: { roads: ["A2"] },
  valid_from: "2026-06-22T06:00:00Z",
  valid_to: "2026-06-22T10:00:00Z",
  schedule: [
    {
      repeatFrequency: "P1D",
      startDate: "2026-06-22",
      endDate: "2026-06-22",
      startTime: "06:00",
      endTime: "10:00",
      duration: "PT4H",
      scheduleTimezone: "Europe/Amsterdam",
    },
  ],
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
    expect(feat.properties?.source).toBe("nl-ndw");
    // Structured validity window + recurring schedule survive into the feature
    // properties (consumed by the map popup + time-aware routing).
    expect(feat.properties?.valid_from).toBe("2026-06-22T06:00:00Z");
    expect(feat.properties?.valid_to).toBe("2026-06-22T10:00:00Z");
    expect(feat.properties?.schedule).toEqual([
      {
        repeatFrequency: "P1D",
        startDate: "2026-06-22",
        endDate: "2026-06-22",
        startTime: "06:00",
        endTime: "10:00",
        duration: "PT4H",
        scheduleTimezone: "Europe/Amsterdam",
      },
    ]);
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

  it("collapses a cross-source duplicate into one feature, carrying mergedSources", async () => {
    const autobahn = {
      ...fakeRow,
      id: "autobahn:1",
      source: "de-autobahn",
      attributes: { roads: [{ ref: "A3" }] },
      data_updated_at: "2026-06-22T10:00:00Z",
      origin: { kind: "feed", attribution: { provider: "Autobahn", license: "dl-de/by-2-0" } },
      geojson: JSON.stringify({ type: "Point", coordinates: [8.0, 50.0] }),
    };
    const nrw = {
      ...fakeRow,
      id: "nrw:9",
      source: "nrw-viz",
      attributes: { roads: [{ name: "A3 Köln" }] },
      data_updated_at: "2026-06-22T11:00:00Z",
      origin: { kind: "feed", attribution: { provider: "VIZ.NRW", license: "dl-de/zero-2-0" } },
      geojson: JSON.stringify({ type: "Point", coordinates: [8.0, 50.0] }),
    };
    const fc = await observationsByBbox(makeStubDb([autobahn, nrw]), {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties?.id).toBe("nrw:9");
    expect(fc.features[0].properties?.mergedSources).toEqual([
      {
        source: "de-autobahn",
        id: "autobahn:1",
        attribution: { provider: "Autobahn", license: "dl-de/by-2-0" },
      },
    ]);
  });

  it("leaves cross-source duplicates separate when dedupe is disabled", async () => {
    const a = {
      ...fakeRow,
      id: "autobahn:1",
      source: "de-autobahn",
      attributes: { roads: [{ ref: "A3" }] },
    };
    const b = {
      ...fakeRow,
      id: "nrw:9",
      source: "nrw-viz",
      attributes: { roads: [{ ref: "A3" }] },
    };
    const fc = await observationsByBbox(makeStubDb([a, b]), {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
      dedupe: false,
    });
    expect(fc.features).toHaveLength(2);
  });

  it("selects data_updated_at (needed by the dedup newest-tiebreak)", async () => {
    let capturedQuery = "";
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, _p?: unknown[]): Promise<T> {
        capturedQuery = q;
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    expect(capturedQuery).toMatch(/data_updated_at/);
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

  it("appends a kind filter clause + bound param when kind is given", async () => {
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
      kind: "event",
    });
    expect(capturedQuery).toMatch(/kind = \$6/);
    expect(capturedParams[5]).toBe("event");
  });

  it("omits the kind clause when no kind is given", async () => {
    let capturedQuery = "";
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, _p?: unknown[]): Promise<T> {
        capturedQuery = q;
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    expect(capturedQuery).not.toMatch(/kind =/);
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

  it("filters out conditions past their validity/expiry window", async () => {
    let capturedQuery = "";
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, _p?: unknown[]): Promise<T> {
        capturedQuery = q;
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    expect(capturedQuery).toMatch(/valid_to IS NULL OR o\.valid_to > now\(\)/);
    expect(capturedQuery).toMatch(/expires_at IS NULL OR o\.expires_at > now\(\)/);
  });

  it("selects valid_from (projected, not filtered) so future closures still reach consumers", async () => {
    let capturedQuery = "";
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, _p?: unknown[]): Promise<T> {
        capturedQuery = q;
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    // valid_from + schedule are in the SELECT list...
    expect(capturedQuery).toMatch(/\bvalid_from\b/);
    expect(capturedQuery).toMatch(/\bschedule\b/);
    // ...but valid_from is NOT a WHERE filter — the map shows upcoming closures;
    // routing does the time-of-travel filtering itself.
    expect(capturedQuery).not.toMatch(/valid_from\s+(?:IS|<=|<|>)/);
  });

  it("projects data_updated_at (top-level, ISO string) onto the feature properties", async () => {
    const row = { ...fakeRow, data_updated_at: "2026-06-22T05:30:00Z" };
    const fc = await observationsByBbox(makeStubDb([row]), {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });
    expect(fc.features[0]?.properties?.data_updated_at).toBe("2026-06-22T05:30:00Z");
  });

  it("serializes a Date data_updated_at value to an ISO string", async () => {
    const row = { ...fakeRow, data_updated_at: new Date("2026-06-22T05:30:00Z") };
    const fc = await observationsByBbox(makeStubDb([row]), {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });
    expect(fc.features[0]?.properties?.data_updated_at).toBe("2026-06-22T05:30:00.000Z");
  });

  it("projects a null data_updated_at as null rather than dropping the key", async () => {
    const row = { ...fakeRow, data_updated_at: null };
    const fc = await observationsByBbox(makeStubDb([row]), {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });
    expect(fc.features[0]?.properties?.data_updated_at).toBeNull();
  });

  it("derives is_stale from a source_status join at query time (not the stored column)", async () => {
    let capturedQuery = "";
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, _p?: unknown[]): Promise<T> {
        capturedQuery = q;
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    expect(capturedQuery).toMatch(
      /LEFT JOIN conditions\.source_status ss ON ss\.source = o\.source/
    );
    expect(capturedQuery).toMatch(
      /\(ss\.last_success_at IS NULL OR ss\.last_success_at \+ make_interval\(secs => ss\.freshness_window_sec\) < now\(\)\) AS is_stale/
    );
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
    expect(capturedQuery).toMatch(/ORDER BY.*CASE o\.severity/s);
    expect(capturedQuery).not.toMatch(/ORDER BY severity\b/);
  });

  it("projects the evidence-labeling fields (origin.kind + evidence/routing/confidence/privacy/fuzziness)", async () => {
    const crowd = {
      ...fakeRow,
      id: "crowd:1",
      origin: { kind: "crowd", attribution: { provider: "OpenConditions" } },
      evidence_state: "self_reported",
      routing_eligible: false,
      confidence_score: 0.3,
      privacy_class: "crowd_pseudonym",
      fuzziness: "low_res",
    };
    const fc = await observationsByBbox(makeStubDb([crowd]), {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
    });
    const p = fc.features[0]!.properties!;
    expect(p.originKind).toBe("crowd");
    expect(p.evidenceState).toBe("self_reported");
    expect(p.routingEligible).toBe(false);
    expect(p.confidenceScore).toBe(0.3);
    expect(p.privacyClass).toBe("crowd_pseudonym");
    expect(p.fuzziness).toBe("low_res");
  });

  it("selects the evidence-labeling columns", async () => {
    let capturedQuery = "";
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, _p?: unknown[]): Promise<T> {
        capturedQuery = q;
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    expect(capturedQuery).toMatch(/o\.evidence_state/);
    expect(capturedQuery).toMatch(/o\.routing_eligible/);
    expect(capturedQuery).toMatch(/o\.confidence_score/);
    expect(capturedQuery).toMatch(/o\.privacy_class/);
    expect(capturedQuery).toMatch(/o\.fuzziness/);
  });

  it("adds the origin-aware routing filter only when routingEligibleOnly is true", async () => {
    let capturedQuery = "";
    const db: QueryRunner = {
      async execute<T = unknown>(q: string, _p?: unknown[]): Promise<T> {
        capturedQuery = q;
        return [] as T;
      },
    };
    await observationsByBbox(db, { domain: "roads", bbox: [4.0, 51.0, 6.0, 53.0] });
    // The column is always selected, but the origin-aware WHERE filter is not.
    expect(capturedQuery).not.toMatch(/origin->>'kind' = 'crowd'/);

    await observationsByBbox(db, {
      domain: "roads",
      bbox: [4.0, 51.0, 6.0, 53.0],
      routingEligibleOnly: true,
    });
    // Keep feed rows always; keep crowd rows only when routing_eligible.
    expect(capturedQuery).toMatch(
      /NOT \(o\.origin->>'kind' = 'crowd' AND COALESCE\(o\.routing_eligible, false\) IS NOT TRUE\)/
    );
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
