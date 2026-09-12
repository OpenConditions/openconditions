import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readObservations } from "@openconditions/core";
import type { LookupFn } from "@openconditions/ingest-framework";
import { FEED_SOURCES, type OsmWay, type SpineSubgraph } from "@openconditions/roads";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildDomainRegistry } from "../domains.js";
import { FeedStatusStore } from "../feed-status.js";
import { drainBindingQueue } from "../pipeline/bind-observations.js";
import { activateRoadGraph } from "../pipeline/graph-state.js";
import { importOsmRoads } from "../pipeline/osm-import.js";
import { type DomainFeedSource, runSource } from "../pipeline/run.js";
import { buildSegments } from "../pipeline/segment-build.js";
import { sweepStaleObservations } from "../pipeline/sweep.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * The NDW slice end to end against a real disposable PostGIS: fetch the
 * reviewed gzip capture through the shipped descriptor, accept it, import the
 * frozen A76 spine, bind, then publish through the real HTTP routes.
 *
 * The source fixture is NDW data under CC0-1.0; the spine is OpenStreetMap data
 * under ODbL (see its own manifest). Source timestamps are the capture's own;
 * where a case needs a clock relative to the database's `now()` it shifts
 * source status explicitly and says so.
 */

const SOURCE = "nl-ndw";
const CHECKED_AT = "2026-09-12T07:14:00.000Z";
const HEIGHT_ID = `${SOURCE}:RWS01_M1080891_NARROW_LANES_D2_WWA`;
const EMERGENCY_ID = `${SOURCE}:RWS01_M1080891_EMERGENCY_SERVICES_D2_WWA`;
const DISPLACEMENT_ID = `${SOURCE}:RWS01_M1080891_DISPLACEMENT_D2_WWA`;
const LORRY_POSITIVE_ID = `${SOURCE}:NLRWS_0005382945_1`;
const LORRY_NEGATIVE_ID = `${SOURCE}:NLRWS_0005406494_1`;
const OBSTRUCTION_ID = `${SOURCE}:NDW08_2e188db4-9bff-492d-bf28-90e17bffac8c`;

const REGION = {
  id: "ndw-a76-test",
  bbox: [5.99, 50.8, 6.04, 50.85] as [number, number, number, number],
  tz: "Europe/Amsterdam",
};
const ENV = { SEGMENT_REGIONS: JSON.stringify([REGION]), BIND_ENABLED: "true" };
/** Wide enough to read every record of the national capture. */
const NL_BBOX = "3,50,8,54";

const xml = readFileSync(
  new URL(
    "../../../../packages/roads/src/__tests__/fixtures/ndw/restrictions-v3.xml",
    import.meta.url,
  ),
  "utf8",
);

const spine = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/roads/src/bind/__tests__/fixtures/ndw-a76/spine.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as SpineSubgraph;

const ndwFeed = {
  ...FEED_SOURCES.find((f) => f.id === SOURCE),
  domain: "roads",
} as unknown as DomainFeedSource;

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

const CONTROL_SOURCE = "control-datex";

/** An unconditional closure on a way this graph imported. Entirely synthetic. */
function controlXml(): string {
  // A long referenced way, so the control binds exactly on this graph.
  const way = spine.segments.find((s) => s.dir === "f" && String(s.wayId) === "721090702")!;
  const posList = (way.coords as [number, number][]).map(([lon, lat]) => `${lat} ${lon}`).join(" ");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><mc:messageContainer xmlns:sit="http://datex2.eu/schema/3/situation" xmlns:mc="http://datex2.eu/schema/3/messageContainer" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:com="http://datex2.eu/schema/3/common" modelBaseVersion="3"><mc:payload xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="sit:SituationPublication" lang="nl" modelBaseVersion="3"><com:publicationTime>2026-09-12T07:13:00Z</com:publicationTime><sit:situation id="CONTROL_SITUATION"><sit:situationVersionTime>2026-09-12T07:00:00Z</sit:situationVersionTime><sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="CONTROL_CLOSURE_1" version="1"><sit:situationRecordCreationTime>2025-01-01T00:00:00Z</sit:situationRecordCreationTime><sit:situationRecordVersionTime>2026-09-12T07:00:00Z</sit:situationRecordVersionTime><sit:validity><com:validityStatus>active</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2025-01-01T00:00:00Z</com:overallStartTime></com:validityTimeSpecification></sit:validity><sit:generalPublicComment><sit:comment><com:values><com:value lang="en">Control closure</com:value></com:values></sit:comment></sit:generalPublicComment><sit:locationReference xsi:type="loc:LinearLocation"><loc:roadNumber>N300</loc:roadNumber><loc:gmlLineString srsName="WGS 84"><loc:posList>${posList}</loc:posList></loc:gmlLineString></sit:locationReference><sit:operatorActionStatus>implemented</sit:operatorActionStatus><sit:complianceOption>mandatory</sit:complianceOption><sit:roadOrCarriagewayOrLaneManagementType>roadClosed</sit:roadOrCarriagewayOrLaneManagementType></sit:situationRecord></sit:situation></mc:payload></mc:messageContainer>`;
}

const controlFeed = {
  id: CONTROL_SOURCE,
  domain: "roads",
  operator: "control",
  name: "Synthetic unconditional control",
  format: "datex2",
  url: "https://control.invalid/situations.xml.gz",
  gzip: true,
  snapshot: {
    completeness: "complete",
    rootElement: "messageContainer",
    publicationElement: "payload",
    publicationType: "SituationPublication",
    recordElement: "situationRecord",
  },
  cadenceSec: 60,
  freshnessWindowSec: 300,
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  attribution: "Synthetic control",
  country: "NL",
  rights: {
    sourceRedistribution: true,
    derivedRedistribution: true,
    commercialUse: true,
    attributionRequired: false,
    retention: true,
    evidenceOrigin: "publisher",
    evidenceVersion: "CC0-1.0",
    reviewedAt: "2026-09-12T00:00:00.000Z",
  },
} as unknown as DomainFeedSource;

/**
 * Convert the frozen directed spine into the `OsmWay` rows the importer
 * consumes: one forward segment per way. `oneway` is inferred false only where
 * the capture also holds the paired backward segment.
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

/** Serve one gzip XML body, as the real endpoint does. */
function serveXml(body: string, init: { status?: number; etag?: string } = {}): typeof fetch {
  const status = init.status ?? 200;
  return (async () =>
    new Response(status === 200 ? new Uint8Array(gzipSync(Buffer.from(body, "utf8"))) : null, {
      status,
      headers: {
        "content-type": "application/xml",
        ...(init.etag ? { etag: init.etag } : {}),
      },
    })) as unknown as typeof fetch;
}

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // The ingest run binds accepted observations itself, and that binder reads the
  // process environment, so the region must be configured the way the service
  // configures it rather than only passed to the explicit calls below.
  for (const key of ["SEGMENT_REGIONS", "BIND_ENABLED"]) {
    savedEnv[key] = process.env[key];
    process.env[key] = ENV[key as keyof typeof ENV];
  }
  db = await createRestrictionDatabase();
  sql = db.sql;
  await importOsmRoads(sql, {
    source: { fetchRegion: async () => spineToWays(spine) },
    now: () => CHECKED_AT,
    regions: [REGION],
  });
  await buildSegments(sql, () => CHECKED_AT, { region: REGION.id });
  await activateRoadGraph(sql, { now: () => CHECKED_AT, env: ENV, generation: "ndw-a76-test" });
}, 240_000);

afterAll(async () => {
  await db?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 30_000);

beforeEach(async () => {
  await sql`DELETE FROM conditions.binding_queue`;
  await sql`DELETE FROM conditions.observations WHERE source = ${SOURCE}`;
  await sql`DELETE FROM conditions.source_status WHERE source = ${SOURCE}`;
});

const runner = {
  async execute<T>(query: string, params?: unknown[]): Promise<T> {
    return (await sql.unsafe(query, params as never)) as T;
  },
};

async function ids(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.observations WHERE source = ${SOURCE} ORDER BY id`;
  return rows.map((r) => r.id);
}

async function hashOf(id: string): Promise<string | null> {
  const rows = await sql<{ content_hash: string | null }[]>`
    SELECT content_hash FROM conditions.observations WHERE id = ${id}`;
  return rows[0]?.content_hash ?? null;
}

async function ingest(
  body = xml,
  init: { status?: number; etag?: string; now?: string } = {},
): Promise<Awaited<ReturnType<typeof runSource>>> {
  return runSource(ndwFeed, {
    sql,
    fetch: serveXml(body, init),
    lookup: fakeLookup,
    now: () => init.now ?? CHECKED_AT,
  });
}

async function seed(): Promise<void> {
  const result = await ingest(xml, { etag: 'W/"v1"' });
  expect(result.error).toBeUndefined();
}

async function app() {
  const instance = Fastify();
  const registry = await buildDomainRegistry();
  registerPublishRoutes(instance, sql, new FeedStatusStore(), registry);
  await instance.ready();
  return instance;
}

describe("ndw record lifecycle against a real database", () => {
  it("accepts the capture and keeps the source's own freshness window", async () => {
    const result = await ingest();
    expect(result.error).toBeUndefined();
    expect(await ids()).toHaveLength(6);
    const status = await sql<{ freshness_window_sec: number | null }[]>`
      SELECT freshness_window_sec FROM conditions.source_status WHERE source = ${SOURCE}`;
    // NDW's own 300 seconds, never Finland's inherited 600.
    expect(status[0]!.freshness_window_sec).toBe(300);
  }, 180_000);

  it("walks update, unchanged, 304, failure, staleness and orphan cleanup", async () => {
    await seed();
    const firstHash = await hashOf(HEIGHT_ID);
    expect(firstHash).not.toBeNull();

    await sql`INSERT INTO conditions.observation_binding
      (observation_id, observation_revision, graph_generation, resolver_version,
       status, direction_mode, confidence, candidate_count, geom_hash, bound_at)
      VALUES (${HEIGHT_ID}, ${firstHash}, 'ndw-a76-test', '1.0.0', 'ambiguous', 'unknown', 0.69, 2,
              'geom-1', now())
      ON CONFLICT (observation_id) DO NOTHING`;
    await sql`DELETE FROM conditions.binding_queue`;

    // Synthetic: the publisher raises the conditioned height to 4.7 m.
    const raised = xml
      .replace(
        "<com:vehicleHeight>4.5</com:vehicleHeight>",
        "<com:vehicleHeight>4.7</com:vehicleHeight>",
      )
      .replace(
        'id="RWS01_M1080891_NARROW_LANES_D2_WWA" version="133"',
        'id="RWS01_M1080891_NARROW_LANES_D2_WWA" version="134"',
      );
    const updated = await ingest(raised, { etag: 'W/"v2"', now: "2026-09-12T07:16:00.000Z" });
    expect(updated.error).toBeUndefined();
    const secondHash = await hashOf(HEIGHT_ID);
    expect(secondHash).not.toBe(firstHash);
    // No binding may stay current against the superseded content: the stored
    // revision tracks the new hash, so nothing routes on the 4.5 m version.
    const binding = await sql<{ status: string; observation_revision: string | null }[]>`
      SELECT status, observation_revision FROM conditions.observation_binding
      WHERE observation_id = ${HEIGHT_ID}`;
    expect(binding[0]!.observation_revision).not.toBe(firstHash);
    expect(binding[0]!.observation_revision).toBe(secondHash);

    // An accepted unchanged 200 leaves content and the queue alone.
    await sql`DELETE FROM conditions.binding_queue`;
    const unchanged = await ingest(raised, { now: "2026-09-12T07:18:00.000Z" });
    expect(unchanged.error).toBeUndefined();
    expect(await hashOf(HEIGHT_ID)).toBe(secondHash);
    expect(
      await sql`SELECT observation_id FROM conditions.binding_queue WHERE observation_id = ${HEIGHT_ID}`,
    ).toHaveLength(0);

    // A 304 advances checked time only.
    const validated = await ingest("", { status: 304, now: "2026-09-12T07:20:00.000Z" });
    expect(validated.outcome).toBe("validated_unchanged");
    expect(await hashOf(HEIGHT_ID)).toBe(secondHash);

    // A failed fetch preserves the last-good publication.
    const failing = (async () => {
      throw new Error("upstream unreachable");
    }) as unknown as typeof fetch;
    const failed = await runSource(ndwFeed, {
      sql,
      fetch: failing,
      lookup: fakeLookup,
      now: () => "2026-09-12T07:22:00.000Z",
    });
    expect(failed.error).toBeDefined();
    expect(await ids()).toHaveLength(6);

    // Past 300 seconds the read reports the rows stale; the orphan sweep still
    // keeps them until the source's own 3600-second threshold.
    await sql`UPDATE conditions.source_status
      SET last_success_at = now() - interval '301 seconds' WHERE source = ${SOURCE}`;
    const stale = await readObservations(runner, {
      domain: "roads",
      bbox: [3, 50, 8, 54],
      dedupe: false,
      includeBindings: true,
    });
    const height = stale.find((o) => o.id === HEIGHT_ID)!;
    expect(height.isStale).toBe(true);
    await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(await ids()).toHaveLength(6);

    await sql`UPDATE conditions.source_status
      SET last_success_at = now() - interval '3601 seconds' WHERE source = ${SOURCE}`;
    await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(await ids()).toEqual([]);
  }, 240_000);

  it("keeps the open-ended lorry record despite an old source update time", async () => {
    await seed();
    await sql`UPDATE conditions.source_status SET last_success_at = now() WHERE source = ${SOURCE}`;
    const rows = await readObservations(runner, {
      domain: "roads",
      bbox: [3, 50, 8, 54],
      dedupe: false,
      includeBindings: true,
    });
    const lorry = rows.find((o) => o.id === LORRY_POSITIVE_ID)!;
    expect(lorry.isStale).toBe(false);
    expect(lorry.validTo).toBeNull();
    await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(await ids()).toContain(LORRY_POSITIVE_ID);
  }, 180_000);

  it("rejects a candidate where a published record can no longer be located", async () => {
    await seed();
    const before = await ids();
    // Synthetic: the height record keeps its id but loses every locator.
    const unlocatable = xml.replace(
      /<sit:locationReference xsi:type="loc:ItineraryByIndexedLocations">[\s\S]*?<\/sit:locationReference>(<sit:operatorActionStatus>implemented<\/sit:operatorActionStatus><sit:complianceOption>mandatory<\/sit:complianceOption><sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic>)/,
      "$1",
    );
    const failed = await ingest(unlocatable, { now: "2026-09-12T07:16:00.000Z" });
    expect(failed.error).toBeDefined();
    expect(await ids()).toEqual(before);
  }, 180_000);

  it("withdraws a record only when it leaves an accepted snapshot", async () => {
    await seed();
    const withoutLorry = xml.replace(
      /<sit:situation id="NLRWS_0005406494">[\s\S]*?<\/sit:situation>/,
      "",
    );
    const result = await ingest(withoutLorry, { now: "2026-09-12T07:16:00.000Z" });
    expect(result.error).toBeUndefined();
    const remaining = await ids();
    expect(remaining).not.toContain(LORRY_NEGATIVE_ID);
    expect(remaining).toContain(HEIGHT_ID);
  }, 180_000);

  it("retires a record the publisher marks cancelled", async () => {
    await seed();
    const cancelled = xml.replace(
      '<sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="NLRWS_0005382945_1" version="536"><sit:situationRecordCreationTime>2026-08-16T05:15:13.121025Z</sit:situationRecordCreationTime><sit:situationRecordVersionTime>2026-09-12T04:35:25.588336Z</sit:situationRecordVersionTime><sit:probabilityOfOccurrence>certain</sit:probabilityOfOccurrence>',
      '<sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="NLRWS_0005382945_1" version="537"><sit:situationRecordCreationTime>2026-08-16T05:15:13.121025Z</sit:situationRecordCreationTime><sit:situationRecordVersionTime>2026-09-12T05:35:25.588336Z</sit:situationRecordVersionTime><sit:probabilityOfOccurrence>certain</sit:probabilityOfOccurrence>',
    );
    const result = await ingest(cancelled, { now: "2026-09-12T07:16:00.000Z" });
    expect(result.error).toBeUndefined();
    const stored = await sql<{ attributes: Record<string, unknown> }[]>`
      SELECT attributes FROM conditions.observations WHERE id = ${LORRY_POSITIVE_ID}`;
    const details = stored[0]!.attributes["restrictionDetails"] as {
      source: { recordVersion: string };
    };
    expect(details.source.recordVersion).toBe("537");
  }, 180_000);
});

describe("ndw binding and publication through the real graph and routes", () => {
  /**
   * Make a source's freshness current against wall-clock evaluation. The
   * publication routes evaluate at the real `now`, while the frozen fixture is
   * ingested at its own capture instant, so both checked-time columns are moved
   * forward explicitly rather than letting the record read as stale.
   */
  async function markFresh(source: string): Promise<void> {
    await sql`UPDATE conditions.source_status
      SET last_success_at = now(), last_network_success_at = now(),
          freshness_deadline = now() + interval '300 seconds'
      WHERE source = ${source}`;
  }

  async function seedAndBind(): Promise<void> {
    await seed();
    await markFresh(SOURCE);
    await drainBindingQueue(sql, { now: () => CHECKED_AT, env: ENV, limit: 500 });
  }

  it("binds the height event ambiguously and establishes no restriction extent", async () => {
    await seedAndBind();
    const binding = await sql<{ status: string; confidence: number | null }[]>`
      SELECT status, confidence FROM conditions.observation_binding
      WHERE observation_id = ${HEIGHT_ID}`;
    expect(binding[0]!.status).toBe("ambiguous");
    const stored = await sql<{ attributes: Record<string, unknown> }[]>`
      SELECT attributes FROM conditions.observations WHERE id = ${HEIGHT_ID}`;
    const details = stored[0]!.attributes["restrictionDetails"] as {
      facts: Array<{ scope: { restrictionBinding: string } }>;
    };
    for (const fact of details.facts) {
      expect(fact.scope.restrictionBinding).toBe("not_established");
    }
  }, 180_000);

  it("displays every conditional record with its provenance and source direction", async () => {
    await seedAndBind();
    const instance = await app();
    try {
      const res = await instance.inject({
        method: "GET",
        url: `/observations.geojson?bbox=${NL_BBOX}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        features: Array<{ id: string; properties: Record<string, unknown> }>;
      };
      const byId = new Map(body.features.map((f) => [f.id, f.properties]));
      for (const id of [HEIGHT_ID, EMERGENCY_ID, LORRY_POSITIVE_ID, LORRY_NEGATIVE_ID]) {
        expect(byId.get(id), id).toBeDefined();
        expect(byId.get(id)!["restrictionDetails"], id).toBeDefined();
      }
      // Collocated records with distinct identities all survive.
      expect(byId.has(DISPLACEMENT_ID)).toBe(true);
      expect(byId.has(OBSTRUCTION_ID)).toBe(true);

      const height = byId.get(HEIGHT_ID)!["restrictionDetails"] as {
        facts: Array<{
          value: number;
          unit: string;
          operator: string;
          state: string;
          direction: { basis: string; value: string };
        }>;
        source: Record<string, unknown>;
        sourceCheckedAt: string | null;
        freshUntil: string | null;
        isStale: boolean;
      };
      expect(height.facts[0]).toMatchObject({
        value: 4.5,
        unit: "m",
        operator: "gt",
        state: "active",
        direction: { basis: "alert_c", value: "positive" },
      });
      expect(height.source).toMatchObject({
        sourceId: SOURCE,
        recordId: "RWS01_M1080891_NARROW_LANES_D2_WWA",
        recordVersion: "133",
        license: "CC0-1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "NDW / Rijkswaterstaat",
      });
      expect(height.sourceCheckedAt).not.toBeNull();
      expect(height.freshUntil).not.toBeNull();
      expect(height.isStale).toBe(false);

      const lorry = byId.get(LORRY_POSITIVE_ID)!["restrictionDetails"] as {
        facts: Array<{
          kind: string;
          value: string;
          context: { comments: Array<{ text: string; language: string }> };
        }>;
      };
      expect(lorry.facts[0]).toMatchObject({ kind: "vehicle_class", value: "truck" });
      expect(lorry.facts[0]!.context.comments[0]).toEqual({
        text: "Verbod voor vrachtverkeer en autobussen (>3500kg). Lijnbussen toegestaan.",
        language: "nl",
      });
    } finally {
      await instance.close();
    }
  }, 180_000);

  it("emits no conditional record into segments, Valhalla, DATEX or TraFF", async () => {
    await seedAndBind();
    const instance = await app();
    try {
      const segments = await instance.inject({
        method: "GET",
        url: `/segments/conditions.json?bbox=${NL_BBOX}`,
      });
      expect(segments.statusCode).toBe(200);
      const conditions = (segments.json() as { conditions: Array<{ id: string }> }).conditions;
      for (const id of [HEIGHT_ID, EMERGENCY_ID, LORRY_POSITIVE_ID, LORRY_NEGATIVE_ID]) {
        expect(
          conditions.map((c) => c.id),
          id,
        ).not.toContain(id);
      }

      const exclusions = await instance.inject({
        method: "GET",
        url: `/valhalla/exclusions.json?bbox=${NL_BBOX}`,
      });
      expect(exclusions.statusCode).toBe(200);
      const body = exclusions.json() as {
        exclude_locations: unknown[];
        exclude_polygons: unknown[];
      };
      expect(body.exclude_locations).toEqual([]);
      expect(body.exclude_polygons).toEqual([]);

      for (const url of [`/datex2/situations.xml?bbox=${NL_BBOX}`, `/traff.xml?bbox=${NL_BBOX}`]) {
        const res = await instance.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);
        for (const id of ["RWS01_M1080891_NARROW_LANES_D2_WWA", "NLRWS_0005382945_1"]) {
          expect(res.body, `${url} ${id}`).not.toContain(id);
        }
        expect(res.body, url).not.toContain("Verbod voor vrachtverkeer");
      }
    } finally {
      await instance.close();
    }
  }, 180_000);

  it("still applies an independently bound unconditional control", async () => {
    await seedAndBind();
    // The control runs through the same acquisition path as NDW so it carries
    // real rights, freshness and a binding, and it lies on a way this graph
    // actually imported. Without it, "no conditional effect" could pass simply
    // because nothing in this region produces a shared effect at all.
    await runSource(controlFeed, {
      sql,
      fetch: serveXml(controlXml()),
      lookup: fakeLookup,
      now: () => CHECKED_AT,
    });
    await markFresh(CONTROL_SOURCE);
    await drainBindingQueue(sql, { now: () => CHECKED_AT, env: ENV, limit: 500 });

    const instance = await app();
    try {
      const segments = await instance.inject({
        method: "GET",
        url: `/segments/conditions.json?bbox=${NL_BBOX}`,
      });
      const conditions = (segments.json() as { conditions: Array<{ id: string }> }).conditions;
      expect(conditions.map((c) => c.id)).toContain(`${CONTROL_SOURCE}:CONTROL_CLOSURE_1`);
      for (const id of [HEIGHT_ID, EMERGENCY_ID, LORRY_POSITIVE_ID, LORRY_NEGATIVE_ID]) {
        expect(
          conditions.map((c) => c.id),
          id,
        ).not.toContain(id);
      }
    } finally {
      await instance.close();
      await sql`DELETE FROM conditions.observations WHERE source = ${CONTROL_SOURCE}`;
      await sql`DELETE FROM conditions.source_status WHERE source = ${CONTROL_SOURCE}`;
    }
  }, 180_000);
});
