import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { RESOLVER_VERSION } from "@openconditions/roads";
import type { DomainRegistry } from "@openconditions/ingest-framework";
import { FeedStatusStore } from "../feed-status.js";
import { buildDomainRegistry } from "../domains.js";
import { registerPublishRoutes } from "../publish-routes.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-09-06T00:00:00.000Z";
const VALID_FROM = "2026-09-06T06:00:00.000Z";
const VALID_TO = "2026-09-06T18:00:00.000Z";

// A single west-to-east segment on the A57 near Krefeld, exactly 0.1 degrees
// of longitude long, so ST_LineSubstring's fractions land on round coordinates.
const SEGMENT_ID = "10:f";
const SEGMENT_WKT = "LINESTRING(6.8 51.2, 6.9 51.2)";
// The span bound to it starts 20 % along, i.e. at lon 6.82.
const SPAN_START = 0.2;
const SPAN_START_LON = 6.82;
// A span pointing at a segment that is NOT in road_segment: the binding tables
// carry no FK to the spine, so a rebuilt spine can drop a segment out from
// under a live binding and the emitter must survive it with geometry: null.
const VANISHED_SEGMENT_ID = "999:f";
// The seeded `length_m` of that segment, and the half-width the route widens a
// zero-length (point-located) span to. 10 m either side => a ~20 m line.
const SEGMENT_LENGTH_M = 7000;
const POINT_SPAN_HALF_M = 10;
const POINT_SPAN_FRACTION = 0.5;

async function insertEvent(
  id: string,
  license: string,
  attributes: postgres.JSONValue,
  validFrom: string = VALID_FROM
): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, category, severity, severity_source,
       headline, status, geom, attributes, valid_from, valid_to, origin,
       data_updated_at, fetched_at, source_license, content_hash)
    VALUES (${id}, 'bind-test', 'datex2', 'roads', 'event', 'road_closure', 'incident',
      'high', 'declared', 'Closure', 'active',
      ST_SetSRID(ST_GeomFromText('POINT(6.85 51.2)'), 4326),
      ${sql.json(attributes)}, ${validFrom}, ${VALID_TO},
      ${sql.json({ kind: "feed", attribution: { provider: "bind-test", license } })},
      ${NOW}, ${NOW}, ${license}, ${`revision-${id}`})`;
}

async function insertBinding(id: string, status: string, confidence: number): Promise<void> {
  await sql`
    INSERT INTO conditions.observation_binding
      (observation_id, status, confidence, direction_mode, candidate_count,
       alternative_confidence, reason, resolver_version, geom_hash, bound_at)
    VALUES (${id}, ${status}, ${confidence}, 'single', 1, null, null,
      ${RESOLVER_VERSION}, ${`hash-${id}`}, ${NOW})`;
  await sql`UPDATE conditions.observation_binding
    SET observation_revision=${`revision-${id}`}, graph_generation='graph-route-test'
    WHERE observation_id=${id}`;
}

async function insertSpan(
  id: string,
  seq: number,
  segmentId: string,
  wayId: number,
  startFraction: number,
  endFraction: number
): Promise<void> {
  await sql`
    INSERT INTO conditions.observation_segment
      (observation_id, seq, segment_id, way_id, dir, start_fraction, end_fraction)
    VALUES (${id}, ${seq}, ${segmentId}, ${wayId}, 'f', ${startFraction}, ${endFraction})`;
}

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
  await sql`INSERT INTO conditions.road_graph_state
    (singleton,generation,regions,highway_classes,pbf_provenance,imported_at,activated_at)
    VALUES (true,'graph-route-test','[]','["motorway"]','[]',${NOW},${NOW})`;
  await sql`INSERT INTO conditions.source_status
    (source,last_success_at,last_network_success_at,freshness_deadline,freshness_window_sec,updated_at)
    VALUES ('bind-test',${NOW},${NOW},'2030-01-01T00:00:00Z',3600,${NOW})`;

  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${SEGMENT_ID}, 10, 'f',
      ST_SetSRID(ST_GeomFromText(${SEGMENT_WKT}), 4326),
      'motorway', 'A57', ${SEGMENT_LENGTH_M}, 5, 100, ${NOW})`;

  // Bound, permissive, in effect at 10:00 -- the row the routing consumer wants.
  await insertEvent("a:1", "CC0-1.0", { roadState: "closed", vehiclesAffected: ["truck"] });
  await insertBinding("a:1", "exact", 0.96);
  await insertSpan("a:1", 0, SEGMENT_ID, 10, SPAN_START, 1);

  // Share-alike: bound exactly, but must never reach a permissive export.
  await insertEvent("a:sa", "ODbL-1.0", { roadState: "closed" });
  await insertBinding("a:sa", "exact", 0.94);
  await insertSpan("a:sa", 0, SEGMENT_ID, 10, 0, 1);

  // Ambiguous is still routing-relevant (the consumer decides what to trust),
  // and its second span points at a segment the spine no longer has.
  await insertEvent("a:amb", "CC0-1.0", { roadState: "closed" });
  await insertBinding("a:amb", "ambiguous", 0.4);
  await insertSpan("a:amb", 0, SEGMENT_ID, 10, 0, 0.5);
  await insertSpan("a:amb", 1, VANISHED_SEGMENT_ID, 999, 0, 1);

  // A point-located event: the resolver binds it to a ZERO-LENGTH span
  // (start_fraction = end_fraction), which ST_LineSubstring would return as a
  // GeoJSON Point unless the route widens the cut.
  await insertEvent("a:pt", "CC0-1.0", { roadState: "obstruction" });
  await insertBinding("a:pt", "exact", 0.9);
  await insertSpan("a:pt", 0, SEGMENT_ID, 10, POINT_SPAN_FRACTION, POINT_SPAN_FRACTION);

  // Announced for 12:00, so it survives every SQL predicate at ?at=10:00 and
  // can only be excluded by the emitter's own isInEffectAt call.
  await insertEvent("a:future", "CC0-1.0", { roadState: "closed" }, "2026-09-06T12:00:00.000Z");
  await insertBinding("a:future", "exact", 0.95);
  await insertSpan("a:future", 0, SEGMENT_ID, 10, 0, 1);

  // Unbound: no observation_binding row at all -- the INNER JOIN drops it.
  await insertEvent("a:unb", "CC0-1.0", { roadState: "closed" });

  // Unresolved binding: a status outside ('exact','likely','ambiguous').
  await insertEvent("a:unres", "CC0-1.0", { roadState: "closed" });
  await insertBinding("a:unres", "unresolved", 0.1);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

async function withApp<T>(
  fn: (app: ReturnType<typeof Fastify>, registry: DomainRegistry) => Promise<T>
): Promise<T> {
  const app = Fastify();
  const loaded = await buildDomainRegistry();
  const registry = {
    ...loaded,
    roads: {
      ...loaded.roads,
      feeds: [
        {
          id: "bind-test",
          name: "Binding test",
          format: "datex2",
          operator: "test",
          country: "DE",
          cadenceSec: 60,
          freshnessWindowSec: 3600,
          license: "CC0-1.0",
          attribution: "bind-test",
          privacyUrl: "https://example.test/privacy",
          rights: {
            sourceRedistribution: true,
            derivedRedistribution: true,
            commercialUse: true,
            attributionRequired: false,
            retention: true,
            reviewedAt: NOW,
            evidenceOrigin: "test",
            evidenceVersion: "1",
          },
        },
      ],
    },
  } as typeof loaded;
  registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
  await app.ready();
  try {
    return await fn(app, registry);
  } finally {
    await app.close();
  }
}

type ConditionsBody = {
  generated_at: string;
  at: string;
  resolver_version: string;
  conditions: {
    id: string;
    source: string;
    type: string | null;
    road_state: string | null;
    speed_limit_kph: number | null;
    vehicles_affected: string[];
    origin_kind: string;
    routing_eligible: boolean;
    valid_from: string | null;
    valid_to: string | null;
    binding: { status: string; confidence: number | null; direction_mode: string };
    segments: {
      way_id: number;
      dir: string;
      start_fraction: number;
      end_fraction: number;
      geometry: { type: string; coordinates: [number, number][] } | null;
    }[];
  }[];
};

describe("GET /segments/conditions.json", () => {
  it("withdraws retained routing evidence when a catalogue child is no longer scheduled", async () => {
    const original = (
      await sql<
        { origin: postgres.JSONValue }[]
      >`SELECT origin FROM conditions.observations WHERE id='a:1'`
    )[0]!.origin;
    try {
      await sql`UPDATE conditions.observations SET origin=jsonb_set(origin,'{attribution,rights}',${sql.json(
        {
          source_redistribution: "yes",
          derived_redistribution: "yes",
          commercial_use: "yes",
          retention: "yes",
          attribution_required: "no",
          reviewed_at: NOW,
          evidence_origin: "stored old grant",
          evidence_version: "1",
        }
      )}) WHERE id='a:1'`;
      await withApp(async (app, registry) => {
        const publishedIds = async () => {
          const conditions = await app.inject({
            method: "GET",
            url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
          });
          const exclusions = await app.inject({
            method: "GET",
            url: "/valhalla/exclusions.json?bbox=6.8,51.1,6.9,51.3&at=2026-09-06T10:00:00Z",
          });
          expect(conditions.statusCode).toBe(200);
          expect(exclusions.statusCode).toBe(200);
          return [
            (conditions.json() as ConditionsBody).conditions.map((condition) => condition.id),
            (
              exclusions.json() as { routing_evidence: ConditionsBody }
            ).routing_evidence.conditions.map((condition) => condition.id),
          ];
        };
        for (const ids of await publishedIds()) expect(ids).toContain("a:1");

        const child = registry.roads!.feeds[0]!;
        child.parentSourceId = "catalog-parent";
        // Discovery may still carry an approved evidence review after operators
        // remove this child from the catalogue's selected scheduling ids.
        child.selectionState = "approved";
        registry.roads!.feeds = [];
        registry.roads!.discoveredFeeds = [child];
        for (const ids of await publishedIds()) expect(ids).not.toContain("a:1");

        // A source absent from the local catalogue can be federated; its stored
        // provenance remains authoritative, unlike an explicitly unselected child.
        registry.roads!.discoveredFeeds = [];
        for (const ids of await publishedIds()) expect(ids).toContain("a:1");
      });
    } finally {
      await sql`UPDATE conditions.observations SET origin=${sql.json(original)} WHERE id='a:1'`;
    }
  });
  it.each([false, undefined])(
    "uses current registry rights instead of a stored grant: commercialUse=%s",
    async (commercialUse) => {
      const original = (
        await sql<
          { origin: postgres.JSONValue }[]
        >`SELECT origin FROM conditions.observations WHERE id='a:1'`
      )[0]!.origin;
      try {
        await sql`UPDATE conditions.observations SET origin=jsonb_set(origin,'{attribution,rights}',${sql.json(
          {
            source_redistribution: "yes",
            derived_redistribution: "yes",
            commercial_use: "yes",
            retention: "yes",
            attribution_required: "no",
            reviewed_at: NOW,
            evidence_origin: "stored old grant",
            evidence_version: "1",
          }
        )}) WHERE id='a:1'`;
        await withApp(async (app, registry) => {
          const feed = registry.roads!.feeds[0]!;
          feed.rights =
            commercialUse === undefined ? undefined : { ...feed.rights!, commercialUse };
          const res = await app.inject({
            method: "GET",
            url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
          });
          expect(res.statusCode).toBe(200);
          expect(
            (res.json() as ConditionsBody).conditions.some((condition) => condition.id === "a:1")
          ).toBe(false);
        });
      } finally {
        await sql`UPDATE conditions.observations SET origin=${sql.json(original)} WHERE id='a:1'`;
      }
    }
  );
  it("scopes optional bbox queries while keeping the unscoped routing snapshot complete", async () => {
    await withApp(async (app) => {
      const url = "/segments/conditions.json?at=2026-09-06T10:00:00Z";
      const scopedUrl = `${url}&bbox=6.8,51.1,6.9,51.3`;
      const ids = async (query: string) => {
        const res = await app.inject({ method: "GET", url: query });
        expect(res.statusCode).toBe(200);
        return (res.json() as ConditionsBody).conditions.map((condition) => condition.id);
      };
      const before = await ids(scopedUrl);
      const addedIds = Array.from({ length: 12 }, (_, index) => `bbox-outside:${index}`);
      try {
        for (const id of addedIds) {
          await insertEvent(id, "CC0-1.0", { roadState: "closed" });
          await sql`UPDATE conditions.observations SET geom=ST_SetSRID(ST_MakePoint(8,52),4326) WHERE id=${id}`;
          await insertBinding(id, "exact", 1);
          await insertSpan(id, 0, SEGMENT_ID, 10, 0, 1);
        }
        expect(await ids(scopedUrl)).toEqual(before);
        expect(await ids(url)).toEqual(expect.arrayContaining(addedIds));
        expect(await ids(`${url}&bbox=1,1,2,2`)).toEqual([]);
      } finally {
        await sql`DELETE FROM conditions.observations WHERE id = ANY(${addedIds})`;
      }
    });
  }, 30_000);

  it.each(["", "1,,3,4", "170,10,-170,20", "181,1,182,2", "1,2,3,4&bbox=2,3,4,5"])(
    "rejects a malformed optional bbox: %s",
    async (bbox) => {
      await withApp(async (app) => {
        const res = await app.inject({
          method: "GET",
          url: `/segments/conditions.json?bbox=${bbox}`,
        });
        expect(res.statusCode).toBe(400);
      });
    }
  );
  it("does not relabel an older resolver binding or a non-active graph as current evidence", async () => {
    await sql`UPDATE conditions.observation_binding SET resolver_version='old-resolver' WHERE observation_id='a:1'`;
    await withApp(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
      });
      const body = res.json() as ConditionsBody;
      expect(body.conditions.some((condition) => condition.id === "a:1")).toBe(false);
    });
    await sql`UPDATE conditions.observation_binding SET resolver_version=${RESOLVER_VERSION} WHERE observation_id='a:1'`;
    await sql`UPDATE conditions.road_graph_state SET status='rebuilding' WHERE singleton`;
    await withApp(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
      });
      expect((res.json() as ConditionsBody).conditions).toEqual([]);
    });
    await sql`UPDATE conditions.road_graph_state SET status='ready' WHERE singleton`;
  }, 30_000);

  it("emits only bound, permissive, in-effect conditions", async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=60");
      expect(res.headers["x-data-license"]).toBe("CC0-1.0");

      const body = res.json() as ConditionsBody;
      expect(body.at).toBe("2026-09-06T10:00:00.000Z");
      expect(body.resolver_version).toBe(RESOLVER_VERSION);
      // a:sa dropped by the license filter, a:unb has no binding, a:unres has
      // a non-routing binding status, a:future is not in effect until 12:00.
      expect(body.conditions.map((c) => c.id)).toEqual(["a:1", "a:pt"]);
    });
  }, 30_000);

  it("carries the bound span with its geometry cut in travel direction", async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
      });
      const body = res.json() as ConditionsBody;
      const closure = body.conditions.find((c) => c.id === "a:1")!;
      expect(closure).toMatchObject({
        source: "bind-test",
        type: "road_closure",
        road_state: "closed",
        speed_limit_kph: null,
        vehicles_affected: ["truck"],
        origin_kind: "feed",
        // The column defaults to false for feed rows; the emitter forces true.
        routing_eligible: true,
        valid_from: VALID_FROM,
        valid_to: VALID_TO,
        binding: { status: "exact", confidence: 0.96, direction_mode: "single" },
      });
      expect(closure.segments).toHaveLength(1);
      const span = closure.segments[0]!;
      expect(span.way_id).toBe(10);
      expect(span.dir).toBe("f");
      expect(span.start_fraction).toBe(SPAN_START);
      expect(span.end_fraction).toBe(1);
      expect(span.geometry!.type).toBe("LineString");
      const coords = span.geometry!.coordinates;
      expect(coords[0]![0]).toBeCloseTo(SPAN_START_LON, 6);
      expect(coords[0]![1]).toBeCloseTo(51.2, 6);
      expect(coords.at(-1)).toEqual([6.9, 51.2]);
    });
  }, 30_000);

  it("drops ambiguous bindings and spans whose segment is gone from the spine", async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
      });
      const body = res.json() as ConditionsBody;
      expect(body.conditions.find((c) => c.id === "a:amb")).toBeUndefined();
    });
  }, 30_000);

  it("widens a zero-length span's geometry to a short line instead of a Point", async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
      });
      const body = res.json() as ConditionsBody;
      const point = body.conditions.find((c) => c.id === "a:pt")!;
      const span = point.segments[0]!;
      // The fractions stay equal -- only the emitted geometry widens.
      expect(span.start_fraction).toBe(POINT_SPAN_FRACTION);
      expect(span.end_fraction).toBe(POINT_SPAN_FRACTION);
      expect(span.geometry!.type).toBe("LineString");
      const coords = span.geometry!.coordinates;
      expect(coords.length).toBeGreaterThanOrEqual(2);
      // The cut runs POINT_SPAN_HALF_M either side of the fraction, so its
      // extent is ~2x that. Measured along the parallel at lat 51.2.
      const metresPerDegreeLon = 111_320 * Math.cos((51.2 * Math.PI) / 180);
      const extentM = (coords.at(-1)![0] - coords[0]![0]) * metresPerDegreeLon;
      expect(extentM).toBeGreaterThan(2 * POINT_SPAN_HALF_M - 2);
      expect(extentM).toBeLessThan(2 * POINT_SPAN_HALF_M + 2);
    });
  }, 30_000);

  it("drops a condition that passes the SQL predicates but is not yet in effect", async () => {
    await withApp(async (app) => {
      // a:future starts at 12:00 with valid_to at 18:00, so the SQL
      // `valid_to > at` predicate keeps it at 10:00 -- only isInEffectAt can
      // exclude it.
      const early = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T10:00:00Z",
      });
      expect((early.json() as ConditionsBody).conditions.map((c) => c.id)).not.toContain(
        "a:future"
      );

      const later = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T13:00:00Z",
      });
      expect((later.json() as ConditionsBody).conditions.map((c) => c.id)).toContain("a:future");
    });
  }, 30_000);

  it("returns nothing once every condition's validity has passed", async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=2026-09-06T20:00:00Z",
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as ConditionsBody).conditions).toEqual([]);
    });
  }, 30_000);

  it("rejects a malformed `at`", async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/segments/conditions.json?at=not-a-date",
      });
      expect(res.statusCode).toBe(400);
    });
  }, 30_000);
});
