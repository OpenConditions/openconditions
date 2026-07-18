import { describe, expect, it } from "vitest";
import type { QueryRunner } from "../observationsByBbox.js";
import { readObservations } from "../readObservations.js";

const eventRow = {
  id: "nl-ndw:1",
  source: "nl-ndw",
  source_format: "datex2",
  domain: "roads",
  kind: "event",
  type: "accident",
  subtype: null,
  category: "incident",
  severity: "high",
  severity_source: "derived",
  headline: "Accident on A2",
  description: "Two cars",
  metric: null,
  value: null,
  level: null,
  unit: null,
  aggregation: null,
  status: "active",
  valid_from: null,
  valid_to: null,
  data_updated_at: "2026-06-22T10:00:00Z",
  fetched_at: "2026-06-22T10:00:00Z",
  expires_at: null,
  attributes: { roads: [{ name: "A2" }], roadState: "some_lanes_closed", isPlanned: false },
  subject: null,
  origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
  geojson: JSON.stringify({ type: "Point", coordinates: [13.4, 52.5] }),
  is_stale: false,
};

function stubDb(rows: unknown[], capture?: (q: string, p?: unknown[]) => void): QueryRunner {
  return {
    async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
      capture?.(q, p);
      return rows as T;
    },
  };
}

describe("readObservations", () => {
  it("reconstructs the canonical model, spreading attributes (road fields) back on", async () => {
    const obs = await readObservations(stubDb([eventRow]), {
      domain: "roads",
      bbox: [4, 51, 6, 53],
    });
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      id: "nl-ndw:1",
      sourceFormat: "datex2",
      kind: "event",
      type: "accident",
      category: "incident",
      severity: "high",
      headline: "Accident on A2",
      geometry: { type: "Point", coordinates: [13.4, 52.5] },
      // road fields lifted out of `attributes`:
      roadState: "some_lanes_closed",
      isPlanned: false,
    });
    expect((obs[0] as { roads?: unknown }).roads).toEqual([{ name: "A2" }]);
    expect(obs[0]!.origin.attribution.license).toBe("CC0-1.0");
  });

  it("coerces postgres-js Date timestamps to ISO strings", async () => {
    const withDates = {
      ...eventRow,
      data_updated_at: new Date("2026-06-22T10:00:00Z"),
      fetched_at: new Date("2026-06-22T10:00:00Z"),
      valid_to: new Date("2026-06-22T12:00:00Z"),
    };
    const obs = await readObservations(stubDb([withDates]), {
      domain: "roads",
      bbox: [4, 51, 6, 53],
    });
    expect(obs[0]!.dataUpdatedAt).toBe("2026-06-22T10:00:00.000Z");
    expect(obs[0]!.validTo).toBe("2026-06-22T12:00:00.000Z");
    expect(typeof obs[0]!.dataUpdatedAt).toBe("string");
  });

  it("collapses a cross-source duplicate event and preserves the other source", async () => {
    const autobahn = {
      ...eventRow,
      id: "autobahn:1",
      source: "de-autobahn",
      data_updated_at: "2026-06-22T10:00:00Z",
      origin: { kind: "feed", attribution: { provider: "Autobahn", license: "dl-de/by-2-0" } },
    };
    const nrw = {
      ...eventRow,
      id: "nrw:9",
      source: "nrw-viz",
      data_updated_at: "2026-06-22T11:00:00Z",
      origin: { kind: "feed", attribution: { provider: "VIZ.NRW", license: "dl-de/zero-2-0" } },
    };
    const obs = await readObservations(stubDb([autobahn, nrw]), {
      domain: "roads",
      bbox: [4, 51, 6, 53],
    });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.id).toBe("nrw:9"); // newer survives (equal richness)
    expect(obs[0]!.mergedSources).toEqual([
      {
        source: "de-autobahn",
        id: "autobahn:1",
        attribution: { provider: "Autobahn", license: "dl-de/by-2-0" },
      },
    ]);
  });

  it("returns both rows un-merged when dedupe is disabled", async () => {
    const a = { ...eventRow, id: "autobahn:1", source: "de-autobahn" };
    const b = { ...eventRow, id: "nrw:9", source: "nrw-viz" };
    const obs = await readObservations(stubDb([a, b]), {
      domain: "roads",
      bbox: [4, 51, 6, 53],
      dedupe: false,
    });
    expect(obs).toHaveLength(2);
  });

  it("selects and maps the informed transit-entity hints when present", async () => {
    let q = "";
    const withInformed = {
      ...eventRow,
      informed: { modes: ["bus"], routes: ["R1"], stops: ["s1"], trips: ["t1"] },
    };
    const obs = await readObservations(
      stubDb([withInformed], (query) => (q = query)),
      { domain: "roads", bbox: [4, 51, 6, 53] }
    );
    expect(q).toMatch(/o\.informed/);
    expect(obs[0]!.informed).toEqual({
      modes: ["bus"],
      routes: ["R1"],
      stops: ["s1"],
      trips: ["t1"],
    });
  });

  it("leaves informed undefined for rows without it (byte-identical output)", async () => {
    const obs = await readObservations(stubDb([eventRow]), {
      domain: "roads",
      bbox: [4, 51, 6, 53],
    });
    expect(obs[0]!.informed).toBeUndefined();
  });

  it("reads across all domains when no domain is given", async () => {
    let q = "";
    let params: unknown[] | undefined;
    await readObservations(
      stubDb([], (query, p) => {
        q = query;
        params = p;
      }),
      { bbox: [4, 51, 6, 53] }
    );
    expect(q).not.toMatch(/o\.domain =/);
    expect(params).not.toContain("roads");
  });

  it("selects ST_AsGeoJSON + derives is_stale from source_status + filters by validity", async () => {
    let q = "";
    await readObservations(
      stubDb([], (query) => (q = query)),
      { domain: "roads", bbox: [4, 51, 6, 53] }
    );
    expect(q).toMatch(/ST_AsGeoJSON\(o\.geom\) AS geojson/);
    expect(q).toMatch(/LEFT JOIN conditions\.source_status ss ON ss\.source = o\.source/);
    expect(q).toMatch(
      /ss\.last_success_at \+ make_interval\(secs => ss\.freshness_window_sec\) < now\(\)\) AS is_stale/
    );
    expect(q).toMatch(/valid_to IS NULL OR o\.valid_to > now\(\)/);
  });
});
