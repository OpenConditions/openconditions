import { readFileSync } from "node:fs";
import type { LookupFn } from "@openconditions/ingest-framework";
import type { OsmWay, SpineSubgraph } from "@openconditions/roads";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { buildDomainRegistry } from "../domains.js";
import { FeedStatusStore } from "../feed-status.js";
import { bindRecords, drainBindingQueue } from "../pipeline/bind-records.js";
import { activateRoadGraph } from "../pipeline/graph-state.js";
import { importOsmRoads } from "../pipeline/osm-import.js";
import { type DomainFeedSource, runSource } from "../pipeline/run.js";
import { buildSegments } from "../pipeline/segment-build.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { registry as model, situationDraft, writeSituations } from "./helpers/situations.js";

/**
 * Situation binding through the real graph tables: import the frozen Road 40
 * spine, build segments, activate the graph, publish the reviewed records the
 * way a poll does and bind them.
 *
 * The spine is OpenStreetMap data under ODbL (see its manifest); the records
 * are the reviewed Fintraffic records under CC BY 4.0. The assertion that
 * matters is negative: binding the parent situation never establishes where a
 * phase or detour restriction applies.
 */

const CHECKED_AT = "2026-09-12T07:14:00.000Z";
const REGION = {
  id: "fi-road40-test",
  bbox: [22.38, 60.455, 22.42, 60.475] as [number, number, number, number],
  tz: "Europe/Helsinki",
};
const ENV = { SEGMENT_REGIONS: JSON.stringify([REGION]), BIND_ENABLED: "true" };
const ROADWORKS = "https://tie.digitraffic.fi/api/traffic-message/v2/roadworks";

const spine = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/roads/src/bind/__tests__/fixtures/finland-road40/spine.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as SpineSubgraph;

type Feature = { geometry: unknown; properties: Record<string, unknown> };

function sourceFeatures(): Feature[] {
  return (
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { features: Feature[] }
  ).features;
}

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

const ROAD40 = "GUID50470575";
const situationId = (local: string) => `oc:situation:fi-digitraffic:${local}`;

function feature(local: string): Feature {
  return structuredClone(sourceFeatures().find((f) => f.properties["situationId"] === local)!);
}

/**
 * Synthetic: opens the record's windows so it stays active whenever the suite
 * runs; the frozen capture's own dates would eventually lie in the past.
 */
function openEnded(f: Feature): Feature {
  for (const announcement of f.properties["announcements"] as Array<Record<string, unknown>>) {
    announcement["timeAndDuration"] = { startTime: "2026-06-11T21:00:00.000Z", endTime: null };
    for (const phase of (announcement["roadWorkPhases"] ?? []) as Array<Record<string, unknown>>) {
      phase["timeAndDuration"] = { startTime: "2026-07-19T21:00:00.000Z", endTime: null };
    }
  }
  return f;
}

const feed = {
  id: "fi-digitraffic",
  domain: "roads",
  operator: "digitraffic",
  name: "Digitraffic (Finland)",
  format: "digitraffic",
  url: [ROADWORKS],
  snapshot: { completeness: "complete", recordsPath: "features" },
  cadenceSec: 120,
  freshnessWindowSec: 600,
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
} as unknown as DomainFeedSource;

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  // Polls only publish here; each case binds explicitly against the test region.
  process.env["BIND_ENABLED"] = "false";
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
  delete process.env["BIND_ENABLED"];
  await db?.close();
}, 30_000);

/** Publishes `features` as one complete Digitraffic snapshot, as a poll would. */
async function publish(features: Feature[], now = CHECKED_AT): Promise<void> {
  const result = await runSource(feed, {
    sql,
    fetch: (async () =>
      new Response(JSON.stringify({ type: "FeatureCollection", features }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    lookup: fakeLookup,
    now: () => now,
  });
  expect(result.error).toBeUndefined();
}

function bind(ids: string[]) {
  return bindRecords(sql, ids, { now: () => CHECKED_AT, env: ENV });
}

async function binding(id: string) {
  const rows = await sql<
    { effect_id: string; status: string; reason: string | null; graph_generation: string | null }[]
  >`SELECT effect_id, status, reason, graph_generation FROM conditions.record_binding
     WHERE record_class = 'situation' AND record_id = ${id} ORDER BY effect_id`;
  return rows;
}

async function spans(id: string) {
  return sql<{ effect_id: string; segment_id: string; dir: string }[]>`
    SELECT effect_id, segment_id, dir FROM conditions.record_segment
     WHERE record_class = 'situation' AND record_id = ${id} ORDER BY effect_id, seq`;
}

describe("restriction situation binding against the real graph", () => {
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
    await publish([feature(ROAD40)]);
    const result = await bind([situationId(ROAD40)]);
    expect(result.attempted).toBe(1);
    const [own] = await binding(situationId(ROAD40));
    expect(own!.effect_id).toBe("");
    expect(["exact", "likely"]).toContain(own!.status);
    const bound = await spans(situationId(ROAD40));
    expect(bound.map((s) => s.segment_id)).toEqual(["1089416142:f", "724030614:f", "1117139737:f"]);
    // Every span names a segment the graph actually holds.
    const known = await sql<{ segment_id: string }[]>`
      SELECT segment_id FROM conditions.road_segment`;
    const set = new Set(known.map((k) => k.segment_id));
    for (const span of bound) expect(set.has(span.segment_id), span.segment_id).toBe(true);
  }, 60_000);

  it("never binds a restriction effect, whatever the situation bound to", async () => {
    const effects = await sql<{ effect_id: string }[]>`
      SELECT effect_id FROM conditions.situation_effect WHERE situation_id = ${situationId(ROAD40)}`;
    expect(effects.length).toBeGreaterThan(0);
    // Only the situation's own location is placed: no effect of the record
    // names a location of its own, so none gets a binding or spans.
    expect((await binding(situationId(ROAD40))).map((b) => b.effect_id)).toEqual([""]);
    const bound = await spans(situationId(ROAD40));
    expect(bound.length).toBeGreaterThan(0);
    expect(new Set(bound.map((s) => s.effect_id))).toEqual(new Set([""]));
  }, 60_000);

  it("reports no coverage for a situation outside the imported graph", async () => {
    const outside = feature(ROAD40);
    outside.geometry = { type: "Point", coordinates: [24.249493, 64.264338] };
    await publish([outside]);
    await bind([situationId(ROAD40)]);
    const [own] = await binding(situationId(ROAD40));
    expect(["unresolved", "no_coverage"]).toContain(own!.status);
    expect(await spans(situationId(ROAD40))).toHaveLength(0);
  }, 60_000);

  it("leaves a disconnected linear situation unbound with a diagnostic", async () => {
    const gapped = feature(ROAD40);
    const component = (gapped.geometry as { coordinates: number[][][] }).coordinates[0]!;
    const half = Math.floor(component.length / 2);
    gapped.geometry = {
      type: "MultiLineString",
      // Synthetic: the real line split and its second half moved away, so the
      // gap crosses roads the source never mentioned.
      coordinates: [
        component.slice(0, half),
        component.slice(half).map(([lon, lat]) => [lon! + 0.01, lat! + 0.005]),
      ],
    };
    await publish([gapped]);
    await bind([situationId(ROAD40)]);
    expect((await binding(situationId(ROAD40)))[0]).toMatchObject({
      status: "unresolved",
      reason: "disconnected_geometry",
    });
    expect(await spans(situationId(ROAD40))).toHaveLength(0);
  }, 60_000);

  it("invalidates binding currency when the graph generation changes", async () => {
    await publish([feature(ROAD40)]);
    await drainBindingQueue(sql, { now: () => CHECKED_AT, env: ENV, limit: 500 });
    const [before] = await binding(situationId(ROAD40));
    expect(before!.graph_generation).toBe("restriction-fi-test");

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
    const [after] = await binding(situationId(ROAD40));
    expect(after!.graph_generation).not.toBe(state[0]!.generation);
  }, 60_000);
});

describe("stored restriction publication through the real HTTP path", () => {
  const BBOX = "22.3,60.4,22.5,60.5";
  const CONDITIONAL = "GUID50465935";
  const CONDITIONAL_ID = situationId(CONDITIONAL);
  /** The 26 t gross weight limit of one roadworks phase, located only by a description. */
  const PHASE_RESTRICTION = `${CONDITIONAL}/dimension_limit`;

  /**
   * The reviewed weight-restricted roadworks, moved onto the imported Road 40
   * spine (synthetic) and published fresh, then bound.
   */
  async function seedConditional(): Promise<void> {
    const conditional = openEnded(feature(CONDITIONAL));
    conditional.geometry = feature(ROAD40).geometry;
    await publish([conditional], new Date().toISOString());
    await bind([CONDITIONAL_ID]);
  }

  async function app() {
    const instance = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(instance, sql, new FeedStatusStore(), registry);
    registerApiRoutes(instance, sql, { registry: model });
    await instance.ready();
    return instance;
  }

  type Condition = {
    id: string;
    record_id: string;
    effect: { kind: string };
    routing_evidence: { reason_codes: string[]; source_checked_at: string; fresh_until: string };
  };

  async function segmentConditions(instance: Awaited<ReturnType<typeof app>>) {
    const res = await instance.inject({
      method: "GET",
      url: `/segments/conditions.json?bbox=${BBOX}`,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { conditions: Condition[] }).conditions;
  }

  it("publishes the situation's effects with freshness read from the database", async () => {
    await seedConditional();
    const [status] = await sql<{ last_network_success_at: Date; freshness_deadline: Date }[]>`
      SELECT last_network_success_at, freshness_deadline FROM conditions.source_status
       WHERE source = 'fi-digitraffic'`;
    // The weight restriction itself is stored with the situation.
    const [weight] = await sql<{ value: { value: { value: number; unit: string } } }[]>`
      SELECT value FROM conditions.situation_effect
       WHERE situation_id = ${CONDITIONAL_ID} AND effect_id = ${PHASE_RESTRICTION}`;
    expect(weight!.value.value).toEqual({ value: 26000, unit: "kg" });
    const instance = await app();
    try {
      const lanes = (await segmentConditions(instance)).find(
        (c) => c.id === `${CONDITIONAL_ID}#${CONDITIONAL}/lane_restriction`,
      )!;
      expect(lanes.routing_evidence).toMatchObject({
        reason_codes: [],
        source_license: "CC-BY-4.0",
        license_url: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "Fintraffic / Digitraffic",
      });
      // Freshness is read from the database's source status, not from the
      // record's own timestamps.
      expect(Date.parse(lanes.routing_evidence.source_checked_at)).toBe(
        status!.last_network_success_at.getTime(),
      );
      expect(Date.parse(lanes.routing_evidence.fresh_until)).toBe(
        status!.freshness_deadline.getTime(),
      );
      expect(Date.parse(lanes.routing_evidence.fresh_until)).toBeGreaterThan(Date.now());
    } finally {
      await instance.close();
    }
  }, 120_000);

  it("emits no phase restriction into segments, Valhalla, DATEX or TraFF", async () => {
    await seedConditional();
    const instance = await app();
    try {
      // The phase restriction names no location the record places, so the
      // situation's binding never establishes where it applies.
      const conditions = await segmentConditions(instance);
      expect(conditions.some((c) => c.record_id === CONDITIONAL_ID)).toBe(true);
      for (const condition of conditions.filter(
        (c) => c.id === `${CONDITIONAL_ID}#${PHASE_RESTRICTION}`,
      )) {
        expect(condition.routing_evidence.reason_codes).not.toEqual([]);
      }

      const exclusions = await instance.inject({
        method: "GET",
        url: `/valhalla/exclusions.json?bbox=${BBOX}`,
      });
      expect(exclusions.statusCode).toBe(200);
      const body = exclusions.json() as {
        exclude_locations: unknown[];
        exclude_polygons: unknown[];
        speed_caps: Array<{ limit_kph: number }>;
      };
      expect(body.exclude_locations).toEqual([]);
      expect(body.exclude_polygons).toEqual([]);
      // Only the situation's own 30 km/h limit caps speeds.
      expect(new Set(body.speed_caps.map((c) => c.limit_kph))).toEqual(new Set([30]));

      for (const url of [`/datex2/situations.xml?bbox=${BBOX}`, `/traff.xml?bbox=${BBOX}`]) {
        const res = await instance.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);
        expect(res.body, url).not.toContain(CONDITIONAL);
        expect(res.body, url).not.toContain("26000");
        expect(res.body, url).not.toContain("Painorajoitus");
      }
    } finally {
      await instance.close();
    }
  }, 120_000);

  it("still publishes an independently bound unconditional control", async () => {
    await seedConditional();
    const control = situationDraft("closure", {}, "control-source");
    const provenance = control["provenance"] as Record<string, unknown>;
    // A second source so the conditional snapshot cannot withdraw it.
    await writeSituations(sql, "control-source", [
      {
        ...control,
        location: {
          geometry: feature(ROAD40).geometry,
          extent: "linear",
          geometryOrigin: "source",
          fuzziness: "exact",
          roads: [{ ref: "40" }],
          admin: { country: "FI" },
        },
        provenance: {
          ...provenance,
          attribution: {
            provider: "control",
            license: "CC0-1.0",
            rights: {
              source_redistribution: "yes",
              derived_redistribution: "yes",
              commercial_use: "yes",
              attribution_required: "no",
              retention: "yes",
              evidence_origin: "test",
              evidence_version: null,
              reviewed_at: null,
            },
          },
        },
      },
    ]);
    await sql`INSERT INTO conditions.source_status
      (source, last_success_at, last_network_success_at, freshness_deadline,
       freshness_window_sec, updated_at)
      VALUES ('control-source', now(), now(), now() + interval '600 seconds', 600, now())`;
    const controlId = "oc:situation:control-source:closure";
    await bind([controlId]);
    const instance = await app();
    try {
      const conditions = await segmentConditions(instance);
      const closure = conditions.find((c) => c.id === `${controlId}#closure/closure`);
      expect(closure?.routing_evidence.reason_codes).toEqual([]);
      // Two collocated situations with different identities both survive.
      expect(conditions.some((c) => c.record_id === CONDITIONAL_ID)).toBe(true);
    } finally {
      await instance.close();
      await writeSituations(sql, "control-source", []);
      await sql`DELETE FROM conditions.source_status WHERE source = 'control-source'`;
    }
  }, 120_000);
});
