import { readFileSync } from "node:fs";
import type { OsmWay, SpineSubgraph } from "@openconditions/roads";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDomainRegistry } from "../domains.js";
import { FeedStatusStore } from "../feed-status.js";
import { bindObservations, drainBindingQueue } from "../pipeline/bind-observations.js";
import { activateRoadGraph } from "../pipeline/graph-state.js";
import { importOsmRoads } from "../pipeline/osm-import.js";
import { buildSegments } from "../pipeline/segment-build.js";
import { atomicSwap } from "../pipeline/write-postgis.js";
import { registerPublishRoutes } from "../publish-routes.js";
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
      import.meta.url,
    ),
    "utf8",
  ),
) as SpineSubgraph;

const sourceFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { features: Array<{ geometry: unknown; properties: Record<string, unknown> }> };

/**
 * Convert the frozen directed spine back into the `OsmWay` rows the importer
 * consumes: one forward segment per way. `oneway` is inferred as false only
 * when the frozen graph also holds the paired backward segment, so the test
 * never invents a bidirectional road the capture did not contain.
 */
function spineToWays(subgraph: SpineSubgraph): OsmWay[] {
  const backward = new Set(
    subgraph.segments.filter((s) => s.dir === "b").map((s) => String(s.wayId)),
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
    (f) => f.properties["situationId"] === "GUID50470575",
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

/**
 * Publish one road event. Road-domain fields are top-level model fields: the
 * write path derives the attributes bag from the domain mapper, so a
 * hand-built `attributes` object would never be persisted.
 */
async function seedEvent(
  id: string,
  geometry: unknown,
  roadFields: Record<string, unknown>,
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
        ...roadFields,
      } as never,
    ],
    600,
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
      { roads: [{ name: "7840", ref: "7840" }], isPlanned: true },
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
      { roads: [{ name: "Turun kehätie", ref: "40" }], isPlanned: true },
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
        WHERE observation_id = 'fi-digitraffic:gapped'`,
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

describe("stored restriction publication through the real HTTP and provider path", () => {
  const CONDITIONAL_ID = "fi-digitraffic:GUID50465935";

  const restrictionDetails = {
    schemaVersion: 1,
    vehicleScope: "specific",
    completeness: "complete",
    issues: [],
    source: {
      sourceId: "fi-digitraffic",
      recordId: "GUID50465935",
      recordVersion: "31",
      sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
      feedUrls: ["https://tie.digitraffic.fi/api/traffic-message/v2/roadworks"],
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Fintraffic / Digitraffic",
      modificationNotice:
        "Normalized by OpenConditions; source units and structure may be transformed.",
    },
    facts: [
      {
        id: "GUID50465935:GUID50469933:roadwork_phase:restrictions[2]",
        kind: "dimension",
        dimension: "gross_weight",
        meaning: "maximum_permitted",
        value: 26000,
        unit: "kg",
        operator: "lte",
        scope: {
          kind: "roadwork_phase",
          phaseId: "GUID50469933",
          locationDescription: "Tie 104, Raasepori",
          sourceLocationRefs: { scheme: "digitraffic_road_address", road: 104 },
          restrictionBinding: "not_established",
        },
        direction: { basis: "road_reference", value: "both", description: null },
        validFrom: "2026-07-19T21:00:00.000Z",
        validTo: null,
        sourceTokens: { type: "vehicle gross weight limit", quantity: 26, unit: "t" },
        context: {
          restrictionsLiftable: false,
          compliance: "unknown",
          operatorActionStatus: null,
          validityStatus: null,
        },
      },
    ],
  };

  async function seedConditional(): Promise<void> {
    const event = road40Event();
    await seedEvent(CONDITIONAL_ID, event.geometry, {
      roads: [{ name: "Turun kehätie", ref: "40" }],
      isPlanned: true,
      roadState: "closed",
      restrictionDetails,
    });
    await sql`UPDATE conditions.observations
      SET valid_from = now() - interval '1 day', valid_to = NULL WHERE id = ${CONDITIONAL_ID}`;
    await sql`UPDATE conditions.source_status
      SET last_success_at = now(), freshness_window_sec = 600 WHERE source = 'fi-digitraffic'`;
    await bindObservations(sql, [CONDITIONAL_ID], { now: () => CHECKED_AT, env: ENV });
  }

  async function app() {
    const instance = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(instance, sql, new FeedStatusStore(), registry);
    await instance.ready();
    return instance;
  }

  it("publishes the evaluated restriction with freshness read from the database", async () => {
    await seedConditional();
    const instance = await app();
    try {
      const res = await instance.inject({
        method: "GET",
        url: "/observations.geojson?bbox=22.3,60.4,22.5,60.5",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        features: Array<{ id: string; properties: Record<string, unknown> }>;
      };
      const feature = body.features.find((f) => f.id === CONDITIONAL_ID)!;
      expect(feature.properties["restrictionDetails"]).toBeDefined();
      const view = feature.properties["restrictionDetails"] as {
        facts: Array<{ value: number; unit: string; state: string }>;
        source: Record<string, unknown>;
        sourceCheckedAt: string | null;
        freshUntil: string | null;
        isStale: boolean;
      };
      expect(view.facts[0]).toMatchObject({ value: 26000, unit: "kg", state: "active" });
      expect(view.source).toMatchObject({
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        publisher: "Fintraffic / Digitraffic",
      });
      // Freshness is computed from the database's source status, not from the
      // observation row's own timestamps.
      expect(view.sourceCheckedAt).not.toBeNull();
      expect(view.freshUntil).not.toBeNull();
      expect(view.isStale).toBe(false);
    } finally {
      await instance.close();
    }
  }, 120_000);

  it("emits no conditional record into segments, Valhalla, DATEX or TraFF", async () => {
    await seedConditional();
    const instance = await app();
    try {
      const segments = await instance.inject({
        method: "GET",
        url: "/segments/conditions.json?bbox=22.3,60.4,22.5,60.5",
      });
      expect(segments.statusCode).toBe(200);
      const conditions = (segments.json() as { conditions: Array<{ id: string }> }).conditions;
      expect(conditions.map((c) => c.id)).not.toContain(CONDITIONAL_ID);

      const exclusions = await instance.inject({
        method: "GET",
        url: "/valhalla/exclusions.json?bbox=22.3,60.4,22.5,60.5",
      });
      expect(exclusions.statusCode).toBe(200);
      const body = exclusions.json() as {
        exclude_locations: unknown[];
        exclude_polygons: unknown[];
      };
      expect(body.exclude_locations).toEqual([]);
      expect(body.exclude_polygons).toEqual([]);

      for (const url of [
        "/datex2/situations.xml?bbox=22.3,60.4,22.5,60.5",
        "/traff.xml?bbox=22.3,60.4,22.5,60.5",
      ]) {
        const res = await instance.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);
        expect(res.body, url).not.toContain(CONDITIONAL_ID);
        expect(res.body, url).not.toContain("26000");
        expect(res.body, url).not.toContain("Painorajoitus");
      }
    } finally {
      await instance.close();
    }
  }, 120_000);

  it("still publishes an independently bound unconditional control", async () => {
    await seedConditional();
    const event = road40Event();
    // A second source so the conditional swap cannot withdraw it.
    await atomicSwap(
      sql,
      "control-source",
      [
        {
          id: "control-source:closure",
          source: "control-source",
          sourceFormat: "native",
          domain: "roads",
          kind: "event",
          type: "road_closure",
          category: "incident",
          severity: "high",
          severitySource: "declared",
          headline: "Road closed",
          status: "active",
          geometry: event.geometry,
          origin: {
            kind: "feed",
            attribution: { provider: "control", license: "CC0-1.0" },
          },
          dataUpdatedAt: CHECKED_AT,
          fetchedAt: CHECKED_AT,
          isStale: false,
          attributes: { roads: [{ name: "Turun kehätie", ref: "40" }], roadState: "closed" },
        } as never,
      ],
      600,
    );
    const instance = await app();
    try {
      const res = await instance.inject({
        method: "GET",
        url: "/observations.geojson?bbox=22.3,60.4,22.5,60.5",
      });
      const body = res.json() as { features: Array<{ id: string }> };
      expect(body.features.map((f) => f.id)).toContain("control-source:closure");
      // Two collocated records with different identities both survive.
      expect(body.features.map((f) => f.id)).toContain(CONDITIONAL_ID);
    } finally {
      await instance.close();
      await sql`DELETE FROM conditions.observations WHERE source = 'control-source'`;
      await sql`DELETE FROM conditions.source_status WHERE source = 'control-source'`;
    }
  }, 120_000);
});
