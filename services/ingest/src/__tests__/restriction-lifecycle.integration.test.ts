import { readFileSync } from "node:fs";
import { readSegmentConditionRows } from "@openconditions/core";
import type { LookupFn } from "@openconditions/ingest-framework";
import { segmentConditionsToJson } from "@openconditions/publishers";
import { RESOLVER_VERSION } from "@openconditions/roads";
import { sweepRecords } from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBindingMetricsReader } from "../pipeline/binding-metrics.js";
import { runSource } from "../pipeline/run.js";
import { testFeed } from "./helpers/catalog.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { bindSituation, registry } from "./helpers/situations.js";

/**
 * The full record lifecycle against a real disposable PostGIS: update,
 * unchanged confirmation, 304, failure, staleness and orphan cleanup.
 *
 * Source timestamps are shifted relative to the database's own `now()` and are
 * labelled synthetic where they are: the frozen source fixture is pinned to its
 * research date, so a future execution of this suite must not depend on
 * September 2026 still falling inside the fixture's event window.
 */

const FIXTURE_URL = new URL(
  "../../../../packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json",
  import.meta.url,
);

const V2 = "https://tie.digitraffic.fi/api/traffic-message/v2";
const ROADWORKS = `${V2}/roadworks`;
const SOURCE = "fi-digitraffic-events";
const WEIGHT_ID = `oc:situation:${SOURCE}:GUID50465935`;
const LANES = `${WEIGHT_ID}#GUID50465935/lane_restriction`;

const feed = testFeed({
  id: SOURCE,
  operator: "digitraffic",
  name: "Digitraffic (Finland)",
  format: "digitraffic",
  endpoints: {
    main: {
      urls: [
        `${V2}/traffic-announcements`,
        ROADWORKS,
        `${V2}/weight-restrictions`,
        `${V2}/exempted-transports`,
      ],
      cadenceSec: 120,
    },
  },
  snapshot: { completeness: "complete", recordsPath: "features" },
  freshnessWindowSec: 600,
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
  terms: { url: "https://example.test/digitraffic-terms", reviewedAt: "2026-09-01" },
});

const MODEL = { registry, instanceId: "test.local" };
const GENERATION = "graph-lifecycle";

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const EMPTY = { type: "FeatureCollection", features: [] };

type Collection = { type: string; features: Array<Record<string, unknown>> };

function roadworks(): Collection {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Collection;
}

/**
 * Keep only the weight record, and open-end its window so the case exercises
 * lifecycle rather than the fixture's own dates. Synthetic where noted.
 */
function weightOnly(mutate?: (props: Record<string, unknown>) => void): Collection {
  const all = roadworks();
  const feature = all.features.find(
    (f) => (f["properties"] as Record<string, unknown>)["situationId"] === "GUID50465935",
  )!;
  const clone = structuredClone(feature);
  const props = clone["properties"] as Record<string, unknown>;
  const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
  // Synthetic: the source's own end date is in the past relative to a future
  // test run, so the record is opened-ended to keep it publishable.
  announcement["timeAndDuration"] = {
    startTime: "2026-06-11T21:00:00.000Z",
    endTime: null,
  };
  for (const phase of announcement["roadWorkPhases"] as Array<Record<string, unknown>>) {
    phase["timeAndDuration"] = { startTime: "2026-07-19T21:00:00.000Z", endTime: null };
  }
  mutate?.(props);
  return { type: "FeatureCollection", features: [clone] };
}

/** Serve every configured partition; only the roadworks URL carries records. */
function serve(payload: unknown, opts: { etag?: string } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    const body = url.startsWith(ROADWORKS) ? payload : EMPTY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...(opts.etag ? { etag: opts.etag } : {}) },
    });
  }) as unknown as typeof fetch;
}

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.record_binding, conditions.record_segment,
    conditions.binding_queue, conditions.road_graph_state, conditions.road_segment CASCADE`;
  await sql`DELETE FROM conditions.source_status WHERE source = ${SOURCE}`;
});

const runner = {
  async execute<T>(query: string, params?: unknown[]): Promise<T> {
    return (await sql.unsafe(query, params as never)) as T;
  },
};

/** Live situations of the feed: a withdrawn or expired one is tombstoned, not deleted. */
async function ids(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.situation
     WHERE source_id = ${SOURCE} AND tombstoned_at IS NULL ORDER BY id`;
  return rows.map((r) => r.id);
}

async function stored(id: string) {
  const [row] = await sql<
    {
      content_hash: string;
      revision: number;
      tombstone_reason: string | null;
      record: Record<string, unknown>;
    }[]
  >`SELECT content_hash, revision, tombstone_reason, record FROM conditions.situation
     WHERE id = ${id}`;
  return row;
}

async function queued(id: string): Promise<number[]> {
  const rows = await sql<{ record_revision: number }[]>`
    SELECT record_revision FROM conditions.binding_queue
     WHERE record_class = 'situation' AND record_id = ${id}`;
  return rows.map((r) => r.record_revision);
}

/** The road graph, held out of `ready` so the polls below leave their binding work queued. */
async function createGraph(status: "ready" | "rebuilding"): Promise<void> {
  await sql`INSERT INTO conditions.road_graph_state
    (singleton, generation, status, regions, highway_classes, pbf_provenance, imported_at,
     activated_at)
    VALUES (true, ${GENERATION}, ${status}, '[]', '["primary"]', '[]', now(), now())`;
  await sql`INSERT INTO conditions.road_segment
    (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, computed_at)
    VALUES ('1:f', 1, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(23.53 60.09, 23.55 60.09)'), 4326),
      'primary', '104', 1100, 5, now())`;
}

/** Places the weight restriction's situation on the graph at its stored revision. */
async function placeOnGraph(): Promise<void> {
  await sql`UPDATE conditions.road_graph_state SET status = 'ready'`;
  await sql`DELETE FROM conditions.record_binding WHERE record_id = ${WEIGHT_ID}`;
  const row = await stored(WEIGHT_ID);
  await bindSituation(sql, WEIGHT_ID, {
    status: "exact",
    confidence: 0.95,
    spans: [{ segmentId: "1:f", wayId: 1, start: 0, end: 1 }],
    revision: row!.revision,
    generation: GENERATION,
    resolverVersion: RESOLVER_VERSION,
  });
}

function sweep() {
  return sweepRecords(sql, {
    ...MODEL,
    now: new Date().toISOString(),
    maxAgeSec: 3600,
    historyDays: 7,
  });
}

/** The routing read and its projection, evaluated at `at`, with the stored feed rights. */
async function routed(at: Date) {
  const rows = await readSegmentConditionRows(runner, { at, resolverVersion: RESOLVER_VERSION });
  return segmentConditionsToJson(
    rows.map((r) => ({ ...r, rights: r.provenance_attribution.rights ?? null })),
    at,
    { resolverVersion: RESOLVER_VERSION, evaluatedAt: at },
  ).conditions;
}

describe("restriction record lifecycle", () => {
  it("walks update, unchanged, 304, failure, staleness and orphan cleanup", async () => {
    await createGraph("rebuilding");
    const seeded = await runSource(feed, {
      sql,
      fetch: serve(weightOnly(), { etag: 'W/"v31"' }),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
      model: MODEL,
    });
    expect(seeded.error).toBeUndefined();
    expect(await ids()).toEqual([WEIGHT_ID]);
    const first = await stored(WEIGHT_ID);
    expect(first!.revision).toBe(1);
    expect(await queued(WEIGHT_ID)).toEqual([1]);

    // An updated restriction changes the content revision, fences off the old
    // binding result and re-queues the situation at its new revision.
    await bindSituation(sql, WEIGHT_ID, {
      status: "exact",
      confidence: 0.99,
      revision: 1,
      generation: GENERATION,
      resolverVersion: RESOLVER_VERSION,
    });
    await sql`DELETE FROM conditions.binding_queue`;
    expect((await createBindingMetricsReader(sql, 0)()).get(SOURCE)).toMatchObject({
      attemptedCurrent: 1,
      obsolete: 0,
    });

    const updated = await runSource(feed, {
      sql,
      fetch: serve(
        weightOnly((props) => {
          const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
          const phases = announcement["roadWorkPhases"] as Array<Record<string, unknown>>;
          for (const restriction of phases[1]!["restrictions"] as Array<Record<string, unknown>>) {
            // Synthetic: the publisher raises the weight limit to 30 t.
            if (restriction["type"] === "vehicle gross weight limit") {
              (restriction["restriction"] as Record<string, unknown>)["quantity"] = 30;
            }
          }
          props["version"] = 32;
          props["versionTime"] = "2026-09-12T07:00:00.000Z";
        }),
        { etag: 'W/"v32"' },
      ),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
      model: MODEL,
    });
    expect(updated.error).toBeUndefined();
    const second = await stored(WEIGHT_ID);
    expect(second!.content_hash).not.toBe(first!.content_hash);
    expect(second!.revision).toBe(2);
    expect((await createBindingMetricsReader(sql, 0)()).get(SOURCE)).toMatchObject({
      attemptedCurrent: 0,
      obsolete: 1,
    });
    expect(await queued(WEIGHT_ID)).toEqual([2]);

    // An accepted unchanged 200 leaves content and the queue alone.
    await sql`DELETE FROM conditions.binding_queue`;
    const unchanged = await runSource(feed, {
      sql,
      fetch: serve(
        weightOnly((props) => {
          const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
          const phases = announcement["roadWorkPhases"] as Array<Record<string, unknown>>;
          for (const restriction of phases[1]!["restrictions"] as Array<Record<string, unknown>>) {
            if (restriction["type"] === "vehicle gross weight limit") {
              (restriction["restriction"] as Record<string, unknown>)["quantity"] = 30;
            }
          }
          props["version"] = 32;
          props["versionTime"] = "2026-09-12T07:00:00.000Z";
        }),
      ),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:18:00.000Z",
      model: MODEL,
    });
    expect(unchanged.error).toBeUndefined();
    expect(await stored(WEIGHT_ID)).toMatchObject({
      content_hash: second!.content_hash,
      revision: 2,
    });
    expect(await queued(WEIGHT_ID)).toEqual([]);

    // A 304 advances checked time only.
    const notModified = (async () =>
      new Response(null, { status: 304 })) as unknown as typeof fetch;
    const validated = await runSource(feed, {
      sql,
      fetch: notModified,
      lookup: fakeLookup,
      now: () => "2026-09-12T07:20:00.000Z",
      model: MODEL,
    });
    expect(validated.outcome).toBe("validated_unchanged");
    expect(await stored(WEIGHT_ID)).toMatchObject({
      content_hash: second!.content_hash,
      revision: 2,
    });

    // A failed fetch preserves the last-good publication.
    const failing = (async () => {
      throw new Error("upstream unreachable");
    }) as unknown as typeof fetch;
    const failed = await runSource(feed, {
      sql,
      fetch: failing,
      lookup: fakeLookup,
      now: () => "2026-09-12T07:22:00.000Z",
      model: MODEL,
    });
    expect(failed.error).toBeDefined();
    expect(await ids()).toEqual([WEIGHT_ID]);

    // Past the freshness window the routing read fails the situation closed,
    // and the orphan sweep still keeps it until the source's own threshold.
    await placeOnGraph();
    const [status] = await sql<{ freshness_deadline: Date }[]>`
      SELECT freshness_deadline FROM conditions.source_status WHERE source = ${SOURCE}`;
    const deadline = status!.freshness_deadline.getTime();
    const fresh = await routed(new Date(deadline - 1000));
    expect(fresh.find((c) => c.id === LANES)?.routing_evidence.reason_codes).toEqual([]);
    const stale = await routed(new Date(deadline + 1000));
    expect(stale.map((c) => c.id)).not.toContain(LANES);

    await sql`UPDATE conditions.source_status
      SET last_success_at = now() - interval '601 seconds' WHERE source = ${SOURCE}`;
    await sweep();
    expect(await ids()).toEqual([WEIGHT_ID]);

    await sql`UPDATE conditions.source_status
      SET last_success_at = now() - interval '3601 seconds' WHERE source = ${SOURCE}`;
    await sweep();
    expect(await ids()).toEqual([]);
    expect((await stored(WEIGHT_ID))?.tombstone_reason).toBe("expired");
  }, 180_000);

  it("keeps a confirmed open-ended record with an old source update timestamp", async () => {
    const seeded = await runSource(feed, {
      sql,
      fetch: serve(
        weightOnly((props) => {
          // Synthetic: the publisher has not touched this record in months but
          // keeps serving it. Age of the source update is not expiry.
          props["versionTime"] = "2026-03-01T00:00:00.000Z";
        }),
      ),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
      model: MODEL,
    });
    expect(seeded.error).toBeUndefined();
    await sql`UPDATE conditions.source_status SET last_success_at = now() WHERE source = ${SOURCE}`;
    await sweep();
    expect(await ids()).toEqual([WEIGHT_ID]);
  }, 120_000);

  // A declared end is not a reason to end a record its source still
  // publishes; the routing read leaves the ended effects out instead.
  it("never routes a record whose own end has passed, however fresh the source is", async () => {
    await createGraph("rebuilding");
    const seeded = await runSource(feed, {
      sql,
      fetch: serve(
        weightOnly((props) => {
          const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
          // Synthetic: an explicit past end.
          announcement["timeAndDuration"] = {
            startTime: "2026-06-11T21:00:00.000Z",
            endTime: "2026-06-30T21:00:00.000Z",
          };
        }),
      ),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
      model: MODEL,
    });
    expect(seeded.error).toBeUndefined();
    expect(await ids()).toEqual([WEIGHT_ID]);
    await placeOnGraph();
    const [status] = await sql<{ freshness_deadline: Date }[]>`
      SELECT freshness_deadline FROM conditions.source_status WHERE source = ${SOURCE}`;
    // Inside the source's freshness window, so only the record's own end decides.
    const conditions = await routed(new Date(status!.freshness_deadline.getTime() - 1000));
    for (const condition of conditions) {
      expect(condition.routing_evidence.reason_codes).not.toEqual([]);
    }
    expect(conditions.map((c) => c.id)).not.toContain(LANES);
  }, 120_000);

  it("projects source checked time and freshness through the read path", async () => {
    await createGraph("rebuilding");
    await runSource(feed, {
      sql,
      fetch: serve(weightOnly()),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
      model: MODEL,
    });
    await placeOnGraph();
    const rows = await readSegmentConditionRows(runner, {
      at: new Date("2026-09-12T07:15:00.000Z"),
      resolverVersion: RESOLVER_VERSION,
    });
    const row = rows.find((r) => r.effect_id === "GUID50465935/lane_restriction")!;
    const checkedAt = new Date(row.source_checked_at!).getTime();
    expect(checkedAt).toBe(Date.parse("2026-09-12T07:14:00.000Z"));
    expect(new Date(row.fresh_until!).getTime() - checkedAt).toBe(600_000);
    // Read metadata must never be persisted into the stored record.
    const record = JSON.stringify((await stored(WEIGHT_ID))!.record);
    expect(record).not.toContain("sourceCheckedAt");
    expect(record).not.toContain("freshnessWindowSec");
    const effects = await sql<{ kind: string }[]>`
      SELECT kind FROM conditions.situation_effect WHERE situation_id = ${WEIGHT_ID}`;
    expect(effects.map((e) => e.kind)).toContain("dimension_limit");
  }, 120_000);

  it("stamps the trusted feed rights onto the stored restriction envelope", async () => {
    await runSource(feed, {
      sql,
      fetch: serve(
        weightOnly((props) => {
          const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
          void announcement;
        }),
      ),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
      model: MODEL,
    });
    const provenance = (await stored(WEIGHT_ID))!.record["provenance"] as {
      attribution: Record<string, unknown>;
    };
    expect(provenance.attribution).toEqual({
      provider: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      rights: {
        source_redistribution: "yes",
        derived_redistribution: "yes",
        commercial_use: "yes",
        attribution_required: "yes",
        retention: "yes",
        evidence_origin: "https://example.test/digitraffic-terms",
        evidence_version: "CC-BY-4.0",
        reviewed_at: "2026-09-01T00:00:00.000Z",
      },
    });
  }, 120_000);
});
