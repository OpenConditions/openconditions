import type { Catalog, CatalogFeed } from "@openconditions/ingest-framework";
import { RESOLVER_VERSION } from "@openconditions/roads";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { REPO_CATALOG, testFeed } from "./helpers/catalog.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { bindSituation, situationDraft, writeSituations } from "./helpers/situations.js";

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

const NOW = "2026-09-06T00:00:00.000Z";
const SOURCE = "bind-test";
const GENERATION = "graph-route-test";
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
// under a live binding.
const VANISHED_SEGMENT_ID = "999:f";
const SEGMENT_LENGTH_M = 7000;
const POINT_SPAN_HALF_M = 10;
const POINT_SPAN_FRACTION = 0.5;

const id = (local: string) => `oc:situation:${SOURCE}:${local}`;
const conditionId = (local: string) => `${id(local)}#${local}/closure`;

/** A closure of `local` from `SOURCE` under `license`, valid from `start` to 18:00. */
function closure(local: string, license = "CC0-1.0", start = VALID_FROM) {
  const draft = situationDraft(
    local,
    { validity: { status: "active", start, end: VALID_TO } },
    SOURCE,
  );
  const provenance = draft["provenance"] as Record<string, unknown>;
  return {
    ...draft,
    location: {
      geometry: { type: "Point", coordinates: [6.85, 51.2] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      admin: { country: "DE" },
    },
    provenance: { ...provenance, attribution: { provider: SOURCE, license } },
  };
}

const bind = (local: string, status: string, spans: Parameters<typeof bindSituation>[2]["spans"]) =>
  bindSituation(sql, id(local), {
    status,
    confidence: 0.9,
    spans,
    generation: GENERATION,
    resolverVersion: RESOLVER_VERSION,
  });

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await sql`INSERT INTO conditions.road_graph_state
    (singleton,generation,regions,highway_classes,pbf_provenance,imported_at,activated_at)
    VALUES (true,${GENERATION},'[]','["motorway"]','[]',${NOW},${NOW})`;
  await sql`INSERT INTO conditions.source_status
    (source,last_success_at,last_network_success_at,freshness_deadline,freshness_window_sec,updated_at)
    VALUES (${SOURCE},${NOW},${NOW},'2030-01-01T00:00:00Z',3600,${NOW})`;
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${SEGMENT_ID}, 10, 'f', ST_SetSRID(ST_GeomFromText(${SEGMENT_WKT}), 4326),
      'motorway', 'A57', ${SEGMENT_LENGTH_M}, 5, 100, ${NOW})`;

  await writeSituations(sql, SOURCE, [
    // Bound, public licence, in effect at 10:00: the condition the routing consumer wants.
    closure("a1"),
    // Share-alike: bound exactly, but must never reach a public export.
    closure("sa", "ODbL-1.0"),
    // Ambiguous, with a second span on a segment the spine no longer has.
    closure("amb"),
    // Bound to a zero-length span, which ST_LineSubstring would return as a Point.
    closure("pt"),
    // Announced for 12:00: it passes the SQL predicates at 10:00, only the effect state drops it.
    closure("future", "CC0-1.0", "2026-09-06T12:00:00.000Z"),
    // Never bound.
    closure("unb"),
    // Bound, but unresolved.
    closure("unres"),
  ]);
  await bind("a1", "exact", [{ segmentId: SEGMENT_ID, wayId: 10, start: SPAN_START, end: 1 }]);
  await bind("sa", "exact", [{ segmentId: SEGMENT_ID, wayId: 10, start: 0, end: 1 }]);
  await bind("amb", "ambiguous", [
    { segmentId: SEGMENT_ID, wayId: 10, start: 0, end: 0.5 },
    { segmentId: VANISHED_SEGMENT_ID, wayId: 999, start: 0, end: 1 },
  ]);
  await bind("pt", "exact", [
    { segmentId: SEGMENT_ID, wayId: 10, start: POINT_SPAN_FRACTION, end: POINT_SPAN_FRACTION },
  ]);
  await bind("future", "exact", [{ segmentId: SEGMENT_ID, wayId: 10, start: 0, end: 1 }]);
  await bind("unres", "unresolved", []);
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

/** The repo catalogue with one scheduled test feed, open to changes a test makes. */
interface TestCatalog extends Catalog {
  feeds: CatalogFeed[];
  discovered: CatalogFeed[];
}

async function withApp<T>(
  fn: (app: ReturnType<typeof Fastify>, catalog: TestCatalog) => Promise<T>,
): Promise<T> {
  const app = Fastify();
  const catalog: TestCatalog = {
    ...REPO_CATALOG,
    feeds: [
      testFeed({
        id: SOURCE,
        name: "Binding test",
        cadenceSec: 60,
        freshnessWindowSec: 3600,
        license: "CC0-1.0",
        attribution: SOURCE,
        terms: { note: "test grant", reviewedAt: NOW },
      }),
    ],
    discovered: [...REPO_CATALOG.discovered],
  };
  registerPublishRoutes(app, sql, new FeedStatusStore(), catalog);
  await app.ready();
  try {
    return await fn(app, catalog);
  } finally {
    await app.close();
  }
}

type ConditionsBody = {
  schema_version: number;
  at: string;
  resolver_version: string;
  conditions: {
    id: string;
    source: string;
    kind: string;
    effect: { kind: string };
    routing_eligible: boolean;
    binding: { status: string; confidence: number | null; direction_mode: string };
    routing_evidence: { valid_from: string | null; valid_to: string | null };
    segments: {
      way_id: number;
      dir: string;
      start_fraction: number;
      end_fraction: number;
      geometry: { type: string; coordinates: [number, number][] } | null;
    }[];
  }[];
};

const AT_10 = "/segments/conditions.json?at=2026-09-06T10:00:00Z";

async function conditionIds(app: ReturnType<typeof Fastify>, url = AT_10) {
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  return (res.json() as ConditionsBody).conditions.map((c) => c.id);
}

/** Runs `fn` with the stored grant of a1 replaced, restoring it after. */
async function withStoredRights(fn: () => Promise<void>) {
  const [{ record }] = await sql<{ record: postgres.JSONValue }[]>`
    SELECT record FROM conditions.situation WHERE id = ${id("a1")}`;
  try {
    await sql`UPDATE conditions.situation
      SET record = jsonb_set(record, '{provenance,attribution,rights}', ${sql.json({
        source_redistribution: "yes",
        derived_redistribution: "yes",
        commercial_use: "yes",
        retention: "yes",
        attribution_required: "no",
        reviewed_at: NOW,
        evidence_origin: "stored old grant",
        evidence_version: "1",
      })})
      WHERE id = ${id("a1")}`;
    await fn();
  } finally {
    await sql`UPDATE conditions.situation SET record = ${sql.json(record)} WHERE id = ${id("a1")}`;
  }
}

describe("GET /segments/conditions.json", () => {
  it("withdraws retained routing evidence when a catalogue child is no longer scheduled", async () => {
    await withStoredRights(() =>
      withApp(async (app, catalog) => {
        const published = async () => [
          await conditionIds(app),
          (
            (
              await app.inject({
                method: "GET",
                url: "/valhalla/exclusions.json?bbox=6.8,51.1,6.9,51.3&at=2026-09-06T10:00:00Z",
              })
            ).json() as { routing_evidence: ConditionsBody }
          ).routing_evidence.conditions.map((c) => c.id),
        ];
        for (const ids of await published()) expect(ids).toContain(conditionId("a1"));

        const child = catalog.feeds[0]!;
        child.parentSourceId = "catalog-parent";
        // Discovery may still carry an approved review after operators remove
        // this child from the catalogue's selected scheduling ids.
        child.selectionState = "approved";
        catalog.feeds.length = 0;
        catalog.discovered.push(child);
        for (const ids of await published()) expect(ids).not.toContain(conditionId("a1"));

        // A source absent from the local catalogue can be federated; its stored
        // provenance remains authoritative, unlike an explicitly unselected child.
        catalog.discovered.length = 0;
        for (const ids of await published()) expect(ids).toContain(conditionId("a1"));
      }),
    );
  });

  it.each([false, undefined])(
    "uses current catalogue rights instead of a stored grant: commercialUse=%s",
    async (commercialUse) => {
      await withStoredRights(() =>
        withApp(async (app, catalog) => {
          const feed = catalog.feeds[0]!;
          feed.rights = { ...feed.rights, commercialUse: commercialUse ?? null };
          expect(await conditionIds(app)).not.toContain(conditionId("a1"));
        }),
      );
    },
  );

  it("scopes optional bbox queries while keeping the unscoped routing snapshot complete", async () => {
    await withApp(async (app) => {
      const scoped = `${AT_10}&bbox=6.8,51.1,6.9,51.3`;
      const before = await conditionIds(app, scoped);
      const far = Array.from({ length: 12 }, (_, i) => `far${i}`);
      try {
        await writeSituations(
          sql,
          SOURCE,
          far.map((local) => ({
            ...closure(local),
            location: {
              ...closure(local).location,
              geometry: { type: "Point", coordinates: [8, 52] },
            },
          })),
          NOW,
          false,
        );
        for (const local of far) {
          await bind(local, "exact", [{ segmentId: SEGMENT_ID, wayId: 10, start: 0, end: 1 }]);
        }
        expect(await conditionIds(app, scoped)).toEqual(before);
        expect(await conditionIds(app)).toEqual(expect.arrayContaining(far.map(conditionId)));
        expect(await conditionIds(app, `${AT_10}&bbox=1,1,2,2`)).toEqual([]);
      } finally {
        const ids = far.map(id);
        await sql`DELETE FROM conditions.record_segment WHERE record_id = ANY(${ids})`;
        await sql`DELETE FROM conditions.record_binding WHERE record_id = ANY(${ids})`;
        await sql`DELETE FROM conditions.situation WHERE id = ANY(${ids})`;
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
    },
  );

  it("does not relabel an older resolver binding or a non-active graph as current evidence", async () => {
    await sql`UPDATE conditions.record_binding SET resolver_version = 'old-resolver'
      WHERE record_id = ${id("a1")}`;
    try {
      await withApp(async (app) => {
        expect(await conditionIds(app)).not.toContain(conditionId("a1"));
      });
    } finally {
      await sql`UPDATE conditions.record_binding SET resolver_version = ${RESOLVER_VERSION}
        WHERE record_id = ${id("a1")}`;
    }
    await sql`UPDATE conditions.road_graph_state SET status = 'rebuilding' WHERE singleton`;
    try {
      await withApp(async (app) => {
        expect(await conditionIds(app)).toEqual([]);
      });
    } finally {
      await sql`UPDATE conditions.road_graph_state SET status = 'ready' WHERE singleton`;
    }
  }, 30_000);

  it("emits only bound, public-licence, in-effect effects, as schema version 2", async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: "GET", url: AT_10 });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=60");
      expect(res.headers["x-data-license"]).toBe("CC0-1.0");
      const body = res.json() as ConditionsBody;
      expect(body).toMatchObject({
        schema_version: 2,
        at: "2026-09-06T10:00:00.000Z",
        resolver_version: RESOLVER_VERSION,
      });
      // sa: share-alike; amb: ambiguous; future: not in effect until 12:00;
      // unb: never bound; unres: bound but unresolved.
      expect(body.conditions.map((c) => c.id)).toEqual([conditionId("a1"), conditionId("pt")]);
    });
  }, 30_000);

  it("carries the bound span with its geometry cut in travel direction", async () => {
    await withApp(async (app) => {
      const body = (await app.inject({ method: "GET", url: AT_10 })).json() as ConditionsBody;
      const a1 = body.conditions.find((c) => c.id === conditionId("a1"))!;
      expect(a1).toMatchObject({
        source: SOURCE,
        kind: "closure",
        effect: { kind: "closure" },
        routing_eligible: true,
        binding: { status: "exact", confidence: 0.9, direction_mode: "single" },
        routing_evidence: { valid_from: VALID_FROM, valid_to: VALID_TO },
      });
      expect(a1.segments).toHaveLength(1);
      const span = a1.segments[0]!;
      expect(span).toMatchObject({
        way_id: 10,
        dir: "f",
        start_fraction: SPAN_START,
        end_fraction: 1,
      });
      expect(span.geometry!.type).toBe("LineString");
      const coords = span.geometry!.coordinates;
      expect(coords[0]![0]).toBeCloseTo(SPAN_START_LON, 6);
      expect(coords[0]![1]).toBeCloseTo(51.2, 6);
      expect(coords.at(-1)).toEqual([6.9, 51.2]);
    });
  }, 30_000);

  it("widens a zero-length span's geometry to a short line instead of a Point", async () => {
    await withApp(async (app) => {
      const body = (await app.inject({ method: "GET", url: AT_10 })).json() as ConditionsBody;
      const span = body.conditions.find((c) => c.id === conditionId("pt"))!.segments[0]!;
      // The fractions stay equal: only the emitted geometry widens.
      expect(span.start_fraction).toBe(POINT_SPAN_FRACTION);
      expect(span.end_fraction).toBe(POINT_SPAN_FRACTION);
      expect(span.geometry!.type).toBe("LineString");
      const coords = span.geometry!.coordinates;
      const metresPerDegreeLon = 111_320 * Math.cos((51.2 * Math.PI) / 180);
      const extentM = (coords.at(-1)![0] - coords[0]![0]) * metresPerDegreeLon;
      expect(extentM).toBeGreaterThan(2 * POINT_SPAN_HALF_M - 2);
      expect(extentM).toBeLessThan(2 * POINT_SPAN_HALF_M + 2);
    });
  }, 30_000);

  it("emits an effect announced for later once it is in effect", async () => {
    await withApp(async (app) => {
      expect(await conditionIds(app)).not.toContain(conditionId("future"));
      expect(
        await conditionIds(app, "/segments/conditions.json?at=2026-09-06T13:00:00Z"),
      ).toContain(conditionId("future"));
    });
  }, 30_000);

  it("holds a roadworks phase effect without a window of its own to its phase", async () => {
    const local = "phased";
    const phaseFrom = "2026-09-06T12:00:00.000Z";
    const phaseTo = "2026-09-06T14:00:00.000Z";
    const base = closure(local);
    try {
      await writeSituations(
        sql,
        SOURCE,
        [
          {
            ...base,
            kind: "roadworks",
            type: "works",
            subtype: "maintenance",
            effects: [],
            details: {
              kind: "roadworks",
              v: 1,
              phases: [
                {
                  id: "p1",
                  validity: { status: "active", start: phaseFrom, end: phaseTo },
                  effects: [
                    {
                      id: `${local}/closure`,
                      kind: "closure",
                      v: 1,
                      scope: "road",
                      applicability: { kind: "all" },
                      compliance: "mandatory",
                      normalization: "complete",
                    },
                  ],
                },
              ],
            },
          },
        ],
        NOW,
        false,
      );
      await bind(local, "exact", [{ segmentId: SEGMENT_ID, wayId: 10, start: 0, end: 1 }]);
      await withApp(async (app) => {
        // 10:00 is inside the situation's window but before the phase.
        expect(await conditionIds(app)).not.toContain(conditionId(local));
        const res = await app.inject({
          method: "GET",
          url: "/segments/conditions.json?at=2026-09-06T13:00:00Z",
        });
        const phased = (res.json() as ConditionsBody).conditions.find(
          (c) => c.id === conditionId(local),
        );
        expect(phased?.routing_evidence).toMatchObject({
          valid_from: phaseFrom,
          valid_to: phaseTo,
        });
      });
    } finally {
      await sql`DELETE FROM conditions.record_segment WHERE record_id = ${id(local)}`;
      await sql`DELETE FROM conditions.record_binding WHERE record_id = ${id(local)}`;
      await sql`DELETE FROM conditions.situation WHERE id = ${id(local)}`;
    }
  }, 30_000);

  it("returns nothing once every effect's validity has passed", async () => {
    await withApp(async (app) => {
      expect(await conditionIds(app, "/segments/conditions.json?at=2026-09-06T20:00:00Z")).toEqual(
        [],
      );
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
