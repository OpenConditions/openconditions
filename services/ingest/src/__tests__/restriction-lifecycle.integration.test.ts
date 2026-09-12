import { readFileSync } from "node:fs";
import { readObservations } from "@openconditions/core";
import type { LookupFn } from "@openconditions/ingest-framework";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DomainFeedSource, runSource } from "../pipeline/run.js";
import { sweepStaleObservations } from "../pipeline/sweep.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

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
const SOURCE = "fi-digitraffic";
const WEIGHT_ID = `${SOURCE}:GUID50465935`;

const feed: DomainFeedSource = {
  id: SOURCE,
  domain: "roads",
  operator: "digitraffic",
  name: "Digitraffic (Finland)",
  format: "digitraffic",
  url: [
    `${V2}/traffic-announcements`,
    ROADWORKS,
    `${V2}/weight-restrictions`,
    `${V2}/exempted-transports`,
  ],
  snapshot: { completeness: "complete", recordsPath: "features" },
  cadenceSec: 120,
  freshnessWindowSec: 600,
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
} as unknown as DomainFeedSource;

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
  await sql`DELETE FROM conditions.binding_queue`;
  await sql`DELETE FROM conditions.observations WHERE source = ${SOURCE}`;
  await sql`DELETE FROM conditions.source_status WHERE source = ${SOURCE}`;
});

const runner = {
  async execute<T>(query: string, params?: unknown[]): Promise<T> {
    return (await sql.unsafe(query, params as never)) as T;
  },
};

async function readFinland() {
  return readObservations(runner, {
    domain: "roads",
    bbox: [19, 59, 32, 71],
    dedupe: false,
    includeBindings: true,
  });
}

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

describe("restriction record lifecycle", () => {
  it("walks update, unchanged, 304, failure, staleness and orphan cleanup", async () => {
    const seeded = await runSource(feed, {
      sql,
      fetch: serve(weightOnly(), { etag: 'W/"v31"' }),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
    });
    expect(seeded.error).toBeUndefined();
    expect(await ids()).toEqual([WEIGHT_ID]);
    const firstHash = await hashOf(WEIGHT_ID);
    expect(firstHash).not.toBeNull();

    // An updated restriction changes the content revision, obsoletes the old
    // binding result and re-queues the event.
    await sql`INSERT INTO conditions.observation_binding
      (observation_id, observation_revision, graph_generation, resolver_version,
       status, direction_mode, confidence, candidate_count, geom_hash, bound_at)
      VALUES (${WEIGHT_ID}, ${firstHash}, 'graph-1', '1.0.0', 'exact', 'single', 0.99, 1,
              'geom-1', now())
      ON CONFLICT (observation_id) DO NOTHING`;
    await sql`DELETE FROM conditions.binding_queue`;

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
    });
    expect(updated.error).toBeUndefined();
    const secondHash = await hashOf(WEIGHT_ID);
    expect(secondHash).not.toBe(firstHash);
    const binding = await sql<{ status: string }[]>`
      SELECT status FROM conditions.observation_binding WHERE observation_id = ${WEIGHT_ID}`;
    expect(binding[0]!.status).toBe("obsolete");
    const queued = await sql<{ observation_id: string }[]>`
      SELECT observation_id FROM conditions.binding_queue WHERE observation_id = ${WEIGHT_ID}`;
    expect(queued).toHaveLength(1);

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
    });
    expect(unchanged.error).toBeUndefined();
    expect(await hashOf(WEIGHT_ID)).toBe(secondHash);
    expect(
      await sql`SELECT observation_id FROM conditions.binding_queue WHERE observation_id = ${WEIGHT_ID}`,
    ).toHaveLength(0);

    // A 304 advances checked time only.
    const notModified = (async () =>
      new Response(null, { status: 304 })) as unknown as typeof fetch;
    const validated = await runSource(feed, {
      sql,
      fetch: notModified,
      lookup: fakeLookup,
      now: () => "2026-09-12T07:20:00.000Z",
    });
    expect(validated.outcome).toBe("validated_unchanged");
    expect(await hashOf(WEIGHT_ID)).toBe(secondHash);

    // A failed fetch preserves the last-good publication.
    const failing = (async () => {
      throw new Error("upstream unreachable");
    }) as unknown as typeof fetch;
    const failed = await runSource(feed, {
      sql,
      fetch: failing,
      lookup: fakeLookup,
      now: () => "2026-09-12T07:22:00.000Z",
    });
    expect(failed.error).toBeDefined();
    expect(await ids()).toEqual([WEIGHT_ID]);

    // Past the freshness window the read reports the row as stale, and the
    // orphan sweep still keeps it until the source's own threshold.
    await sql`UPDATE conditions.source_status
      SET last_success_at = now() - interval '601 seconds' WHERE source = ${SOURCE}`;
    const stale = await readFinland();
    expect(stale.find((o) => o.source === SOURCE)?.isStale).toBe(true);
    await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(await ids()).toEqual([WEIGHT_ID]);

    await sql`UPDATE conditions.source_status
      SET last_success_at = now() - interval '3601 seconds' WHERE source = ${SOURCE}`;
    await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(await ids()).toEqual([]);
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
    });
    expect(seeded.error).toBeUndefined();
    await sql`UPDATE conditions.source_status SET last_success_at = now() WHERE source = ${SOURCE}`;
    await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(await ids()).toEqual([WEIGHT_ID]);
  }, 120_000);

  it("removes a record whose own end has passed, however fresh the source is", async () => {
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
    });
    expect(seeded.error).toBeUndefined();
    await sql`UPDATE conditions.observations
      SET valid_to = now() - interval '1 day' WHERE source = ${SOURCE}`;
    await sql`UPDATE conditions.source_status SET last_success_at = now() WHERE source = ${SOURCE}`;
    await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(await ids()).toEqual([]);
  }, 120_000);

  it("projects source checked time and freshness through the read path", async () => {
    await runSource(feed, {
      sql,
      fetch: serve(weightOnly()),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
    });
    const rows = await readFinland();
    const row = rows.find((o) => o.source === SOURCE)!;
    expect(row.freshnessWindowSec).toBe(600);
    expect(row.sourceCheckedAt).not.toBeNull();
    expect(Number.isFinite(Date.parse(row.sourceCheckedAt!))).toBe(true);
    // Read metadata must never be persisted into the attributes bag.
    const stored = await sql<{ attributes: Record<string, unknown> }[]>`
      SELECT attributes FROM conditions.observations WHERE id = ${WEIGHT_ID}`;
    expect(stored[0]!.attributes).not.toHaveProperty("sourceCheckedAt");
    expect(stored[0]!.attributes).not.toHaveProperty("freshnessWindowSec");
    expect(stored[0]!.attributes["restrictionDetails"]).toBeDefined();
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
    });
    const stored = await sql<{ attributes: Record<string, unknown> }[]>`
      SELECT attributes FROM conditions.observations WHERE id = ${WEIGHT_ID}`;
    const source = (
      stored[0]!.attributes["restrictionDetails"] as { source: Record<string, unknown> }
    ).source;
    expect(source["license"]).toBe("CC-BY-4.0");
    expect(source["licenseUrl"]).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(source["publisher"]).toBe("Fintraffic / Digitraffic");
    expect(source["feedUrls"]).toEqual(feed.url);
    expect(source["modificationNotice"]).toContain("Normalized by OpenConditions");
  }, 120_000);
});
