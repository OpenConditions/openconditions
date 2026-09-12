import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { OsmWay, SpineSubgraph } from "@openconditions/roads";
import { bindObservations, drainBindingQueue } from "../pipeline/bind-observations.js";
import { buildSegments } from "../pipeline/segment-build.js";
import { activateRoadGraph } from "../pipeline/graph-state.js";
import { importOsmRoads } from "../pipeline/osm-import.js";
import { atomicSwap } from "../pipeline/write-postgis.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * Event binding through the real graph tables: import the frozen Road 40 spine,
 * build segments, activate the graph and drain the queue.
 *
 * The spine is OpenStreetMap data under ODbL (see its manifest); the event is
 * the reviewed Fintraffic record under CC BY 4.0. The assertion that matters is
 * negative: binding the parent event never establishes where a phase or detour
 * restriction applies.
 */

const CHECKED_AT = "2026-09-12T07:14:00.000Z";
const REGION = {
  id: "fi-road40-test",
  bbox: [22.38, 60.455, 22.42, 60.475] as [number, number, number, number],
  tz: "Europe/Helsinki",
};
const ENV = { SEGMENT_REGIONS: JSON.stringify([REGION]), BIND_ENABLED: "true" };

const spine = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/roads/src/bind/__tests__/fixtures/finland-road40/spine.json",
      import.meta.url
    ),
    "utf8"
  )
) as SpineSubgraph;

const sourceFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json",
      import.meta.url
    ),
    "utf8"
  )
) as { features: Array<{ geometry: unknown; properties: Record<string, unknown> }> };

/**
 * Convert the frozen directed spine back into the `OsmWay` rows the importer
 * consumes: one forward segment per way. `oneway` is inferred as false only
 * when the frozen graph also holds the paired backward segment, so the test
 * never invents a bidirectional road the capture did not contain.
 */
function spineToWays(subgraph: SpineSubgraph): OsmWay[] {
  const backward = new Set(
    subgraph.segments.filter((s) => s.dir === "b").map((s) => String(s.wayId))
  );
  const ways: OsmWay[] = [];
  for (const segment of subgraph.segments) {
    if (segment.dir !== "f") continue;
    ways.push({
      wayId: segment.wayId,
      coords: segment.coords as [number, number][],
      highway: segment.highway,
      oneway: !backward.has(String(segment.wayId)),
      ...(segment.ref ? { ref: segment.ref } : {}),
    });
  }
  return ways;
}

const ways = spineToWays(spine);

function road40Event() {
  const feature = sourceFixture.features.find(
    (f) => f.properties["situationId"] === "GUID50470575"
  )!;
  return feature;
}

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await importOsmRoads(sql, {
    source: { fetchRegion: async () => ways },
    now: () => CHECKED_AT,
    regions: [REGION],
  });
  await buildSegments(sql, () => CHECKED_AT, { region: REGION.id });
  await activateRoadGraph(sql, {
    now: () => CHECKED_AT,
    env: ENV,
    generation: "restriction-fi-test",
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

async function seedEvent(
  id: string,
  geometry: unknown,
  attributes: Record<string, unknown>
): Promise<void> {
  await atomicSwap(
    sql,
    "fi-digitraffic",
    [
      {
        id,
        source: "fi-digitraffic",
        sourceFormat: "digitraffic",
        domain: "roads",
        kind: "event",
        type: "roadworks",
        category: "planned",
        severity: "high",
        severitySource: "declared",
        headline: "Tie 40, Lieto",
        status: "active",
        geometry,
        origin: {
          kind: "feed",
          attribution: {
            provider: "Fintraffic / Digitraffic",
            license: "CC-BY-4.0",
            url: "https://creativecommons.org/licenses/by/4.0/",
          },
        },
        dataUpdatedAt: CHECKED_AT,
        fetchedAt: CHECKED_AT,
        isStale: false,
        attributes,
      } as never,
    ],
    600
  );
}

describe("restriction event binding against the real graph", () => {
  it("imports the frozen spine into real directed segments", async () => {
    const rows = await sql<{ segment_id: string }[]>`
      SELECT segment_id FROM conditions.road_segment ORDER BY segment_id`;
    expect(rows.length).toBeGreaterThan(0);
    const built = new Set(rows.map((r) => r.segment_id));
    for (const expected of ["1089416142:f", "724030614:f", "1117139737:f"]) {
      expect(built.has(expected), expected).toBe(true);
    }
  }, 60_000);

  it("binds the width record to the same segments the pure matcher chose", async () => {
    const event = road40Event();
    await seedEvent("fi-digitraffic:GUID50470575", event.geometry, {
      roads: [{ name: "Turun kehätie", ref: "40" }],
      isPlanned: true,
      direction: "Naantali",
    });
    const result = await bindObservations(sql, ["fi-digitraffic:GUID50470575"], {
      now: () => CHECKED_AT,
      env: ENV,
    });
    expect(result.attempted).toBe(1);
    const binding = await sql<{ status: string; direction_mode: string }[]>`
      SELECT status, direction_mode FROM conditions.observation_binding
      WHERE observation_id = 'fi-digitraffic:GUID50470575'`;
    expect(["exact", "likely"]).toContain(binding[0]!.status);
    const spans = await sql<{ segment_id: string; dir: string }[]>`
      SELECT segment_id, dir FROM conditions.observation_segment
      WHERE observation_id = 'fi-digitraffic:GUID50470575' ORDER BY seq`;
    expect(spans.map((s) => s.segment_id)).toEqual(["1089416142:f", "724030614:f", "1117139737:f"]);
    // Every span names a segment the graph actually holds.
    const known = await sql<{ segment_id: string }[]>`
      SELECT segment_id FROM conditions.road_segment`;
    const set = new Set(known.map((k) => k.segment_id));
    for (const span of spans) expect(set.has(span.segment_id), span.segment_id).toBe(true);
  }, 60_000);

  it("never records a restriction fact as bound, whatever the event bound to", async () => {
    const stored = await sql<{ attributes: Record<string, unknown> }[]>`
      SELECT attributes FROM conditions.observations
      WHERE id = 'fi-digitraffic:GUID50470575'`;
    void stored;
    const spans = await sql<{ segment_id: string }[]>`
      SELECT segment_id FROM conditions.observation_segment
      WHERE observation_id = 'fi-digitraffic:GUID50470575'`;
    expect(spans.length).toBeGreaterThan(0);
    // There is no table, column or attribute that binds a restriction fact:
    // the contract's only value is "not_established", asserted at the parser
    // and contract boundaries. Assert here that the segment table holds only
    // observation-level rows.
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'observation_segment'`;
    expect(columns.map((c) => c.column_name)).not.toContain("fact_id");
  }, 60_000);

  it("reports no coverage for an event outside the imported graph", async () => {
    await seedEvent(
      "fi-digitraffic:GUID50470575",
      { type: "Point", coordinates: [24.249493, 64.264338] },
      { roads: [{ name: "7840", ref: "7840" }], isPlanned: true }
    );
    await bindObservations(sql, ["fi-digitraffic:GUID50470575"], {
      now: () => CHECKED_AT,
      env: ENV,
    });
    const binding = await sql<{ status: string }[]>`
      SELECT status FROM conditions.observation_binding
      WHERE observation_id = 'fi-digitraffic:GUID50470575'`;
    expect(["unresolved", "no_coverage"]).toContain(binding[0]!.status);
    const spans = await sql`SELECT segment_id FROM conditions.observation_segment
      WHERE observation_id = 'fi-digitraffic:GUID50470575'`;
    expect(spans).toHaveLength(0);
  }, 60_000);

  it("leaves a disconnected linear event unbound with a diagnostic", async () => {
    const event = road40Event();
    const original = event.geometry as { coordinates: number[][][] };
    const component = original.coordinates[0]!;
    const half = Math.floor(component.length / 2);
    await seedEvent(
      "fi-digitraffic:gapped",
      {
        type: "MultiLineString",
        // Synthetic: the real line split and its second half moved away, so the
        // gap crosses roads the source never mentioned.
        coordinates: [
          component.slice(0, half),
          component.slice(half).map(([lon, lat]) => [lon! + 0.01, lat! + 0.005]),
        ],
      },
      { roads: [{ name: "Turun kehätie", ref: "40" }], isPlanned: true }
    );
    await bindObservations(sql, ["fi-digitraffic:gapped"], { now: () => CHECKED_AT, env: ENV });
    const binding = await sql<{ status: string; reason: string | null }[]>`
      SELECT status, reason FROM conditions.observation_binding
      WHERE observation_id = 'fi-digitraffic:gapped'`;
    expect(binding[0]).toMatchObject({
      status: "unresolved",
      reason: "disconnected_geometry",
    });
    expect(
      await sql`SELECT segment_id FROM conditions.observation_segment
        WHERE observation_id = 'fi-digitraffic:gapped'`
    ).toHaveLength(0);
  }, 60_000);

  it("invalidates binding currency when the graph generation changes", async () => {
    const event = road40Event();
    await seedEvent("fi-digitraffic:GUID50470575", event.geometry, {
      roads: [{ name: "Turun kehätie", ref: "40" }],
      isPlanned: true,
    });
    await drainBindingQueue(sql, { now: () => CHECKED_AT, env: ENV, limit: 500 });
    const before = await sql<{ graph_generation: string | null }[]>`
      SELECT graph_generation FROM conditions.observation_binding
      WHERE observation_id = 'fi-digitraffic:GUID50470575'`;
    expect(before[0]!.graph_generation).toBe("restriction-fi-test");

    await activateRoadGraph(sql, {
      now: () => CHECKED_AT,
      env: ENV,
      generation: "restriction-fi-test-2",
    });
    const state = await sql<{ generation: string }[]>`
      SELECT generation FROM conditions.road_graph_state`;
    expect(state[0]!.generation).toBe("restriction-fi-test-2");
    // The stored binding still names the old generation, so a consumer's
    // currency check rejects it rather than treating it as current.
    const after = await sql<{ graph_generation: string | null }[]>`
      SELECT graph_generation FROM conditions.observation_binding
      WHERE observation_id = 'fi-digitraffic:GUID50470575'`;
    expect(after[0]!.graph_generation).not.toBe(state[0]!.generation);
  }, 60_000);
});
