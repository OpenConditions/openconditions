import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { observationsByBbox, type QueryRunner } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { sweepStaleObservations } from "../pipeline/sweep.js";
import { upsertSourceStatus } from "../pipeline/source-status.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const HOUR_MS = 3600_000;

/** Adapt postgres-js to the QueryRunner (`execute`) interface observationsByBbox expects. */
function runner(): QueryRunner {
  return {
    async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
      const rows = p ? await sql.unsafe(q, p as never[]) : await sql.unsafe(q);
      return rows as T;
    },
  };
}

async function insertRow(
  id: string,
  opts: {
    source?: string;
    fetchedAt: Date;
    validTo?: Date | null;
    expiresAt?: Date | null;
    staleAfter?: Date | null;
  }
): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, severity, headline,
       geom, origin, data_updated_at, fetched_at, valid_to, expires_at, stale_after)
    VALUES (${id}, ${opts.source ?? "sweeptest"}, 'seed', 'roads', 'event', 'accident', 'high', ${id},
       ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[13.4,52.5]}'), 4326),
       ${sql.json({ kind: "feed", attribution: { provider: "test" } })},
       now(), ${opts.fetchedAt}, ${opts.validTo ?? null}, ${opts.expiresAt ?? null}, ${opts.staleAfter ?? null})`;
}

/** Directly controls last_success_at (including backdating it) so tests can
 * simulate "this source's last success was N hours ago" without waiting. */
async function setSourceStatus(
  source: string,
  opts: { lastSuccessAt: Date | null; freshnessWindowSec: number }
): Promise<void> {
  await sql`
    INSERT INTO conditions.source_status (source, last_attempt_at, last_success_at, freshness_window_sec)
    VALUES (${source}, now(), ${opts.lastSuccessAt}, ${opts.freshnessWindowSec})
    ON CONFLICT (source) DO UPDATE SET
      last_success_at = excluded.last_success_at,
      freshness_window_sec = excluded.freshness_window_sec`;
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
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("sweepStaleObservations — per-row expiry", () => {
  it("removes rows past valid_to/expires_at regardless of source_status", async () => {
    const now = new Date();
    await setSourceStatus("sweeptest", { lastSuccessAt: now, freshnessWindowSec: 300 });
    await insertRow("keep", { fetchedAt: now });
    await insertRow("exp-validto", { fetchedAt: now, validTo: new Date(now.getTime() - HOUR_MS) });
    await insertRow("exp-expiresat", {
      fetchedAt: now,
      expiresAt: new Date(now.getTime() - HOUR_MS),
    });
    await insertRow("future", { fetchedAt: now, validTo: new Date(now.getTime() + HOUR_MS) });

    const result = await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(result.deleted).toBe(2);

    const remaining = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE source = 'sweeptest' ORDER BY id`;
    expect(remaining.map((r) => r.id)).toEqual(["future", "keep"]);
  }, 60_000);

  it("returns 0 when nothing is stale", async () => {
    const result = await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(result.deleted).toBe(0);
  }, 30_000);
});

describe("sweepStaleObservations — orphan status derived from source_status", () => {
  it("keeps rows whose own fetched_at is old but whose source polled successfully recently (the 304 case)", async () => {
    const now = new Date();
    // A row that hasn't been rewritten in 2h (e.g. unchanged content across
    // many diff-upsert swaps) — old enough to be swept by the old
    // fetched_at-based rule, but its source is still healthy.
    await insertRow("poll304:row", {
      source: "poll304",
      fetchedAt: new Date(now.getTime() - 2 * HOUR_MS),
    });
    await setSourceStatus("poll304", { lastSuccessAt: now, freshnessWindowSec: 300 });

    const result = await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(result.deleted).toBe(0);

    const remaining = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE source = 'poll304'`;
    expect(remaining.map((r) => r.id)).toEqual(["poll304:row"]);
  }, 30_000);

  it("removes rows once the source itself stops succeeding (last_success_at ages out)", async () => {
    // Same row as above, still with a fresh fetched_at (never touched) — but
    // now the source's last success is old: orphan status is per-SOURCE, not
    // per-row, so this must still be swept.
    await setSourceStatus("poll304", {
      lastSuccessAt: new Date(Date.now() - 2 * HOUR_MS),
      freshnessWindowSec: 300,
    });

    const result = await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(result.deleted).toBe(1);

    const remaining = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE source = 'poll304'`;
    expect(remaining.length).toBe(0);
  }, 30_000);

  it("removes rows for a source with no source_status row at all (stopped polling/never registered)", async () => {
    const now = new Date();
    await insertRow("unregistered:row", { source: "unregistered", fetchedAt: now });

    const result = await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(result.deleted).toBe(1);

    const remaining = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE source = 'unregistered'`;
    expect(remaining.length).toBe(0);
  }, 30_000);
});

describe("upsertSourceStatus — the unchanged/304 write path", () => {
  it("advances last_success_at and clears last_error on an unchanged (304) success", async () => {
    await upsertSourceStatus(sql, "upsert-src", {
      freshnessWindowSec: 120,
      outcome: "error",
      error: "boom",
    });
    let row = await sql<{ last_error: string | null; last_success_at: Date | null }[]>`
      SELECT last_error, last_success_at FROM conditions.source_status WHERE source = 'upsert-src'`;
    expect(row[0]!.last_error).toBe("boom");
    expect(row[0]!.last_success_at).toBeNull();

    // Simulates the 304/unchanged early-return path in runSource: a success
    // with no row-count recomputation.
    await upsertSourceStatus(sql, "upsert-src", { freshnessWindowSec: 120, outcome: "success" });

    row = await sql<{ last_error: string | null; last_success_at: Date | null }[]>`
      SELECT last_error, last_success_at FROM conditions.source_status WHERE source = 'upsert-src'`;
    expect(row[0]!.last_error).toBeNull();
    expect(row[0]!.last_success_at).not.toBeNull();
  }, 30_000);

  it("keeps the prior last_row_count when a success omits rowCount (304 case)", async () => {
    await upsertSourceStatus(sql, "upsert-rowcount", {
      freshnessWindowSec: 60,
      outcome: "success",
      rowCount: 42,
    });
    await upsertSourceStatus(sql, "upsert-rowcount", {
      freshnessWindowSec: 60,
      outcome: "success",
    });

    const row = await sql<{ last_row_count: number | null }[]>`
      SELECT last_row_count FROM conditions.source_status WHERE source = 'upsert-rowcount'`;
    expect(row[0]!.last_row_count).toBe(42);
  }, 30_000);
});

describe("observationsByBbox is_stale derivation (from source_status, not per-row stale_after)", () => {
  it("flags a row as fresh when its source polled successfully within its freshness window, even if fetched_at is old", async () => {
    const now = new Date();
    await insertRow("bbox:fresh-source", {
      source: "bbox-fresh",
      fetchedAt: new Date(now.getTime() - 2 * HOUR_MS),
    });
    await setSourceStatus("bbox-fresh", { lastSuccessAt: now, freshnessWindowSec: 300 });

    // dedupe: false — several tests in this describe block deliberately reuse
    // the same geometry/type across different sources, which is exactly what
    // the cross-source dedup pass (unrelated to this test) would merge.
    const fc = await observationsByBbox(runner(), {
      domain: "roads",
      bbox: [13, 52, 14, 53],
      dedupe: false,
    });
    const row = fc.features.find((f) => f.properties?.id === "bbox:fresh-source");
    expect(row?.properties?.is_stale).toBe(false);
  }, 30_000);

  it("flags a row as stale once its source's last success falls outside the freshness window", async () => {
    const now = new Date();
    await insertRow("bbox:stale-source", { source: "bbox-stale", fetchedAt: now });
    await setSourceStatus("bbox-stale", {
      lastSuccessAt: new Date(now.getTime() - 2 * HOUR_MS),
      freshnessWindowSec: 300,
    });

    const fc = await observationsByBbox(runner(), {
      domain: "roads",
      bbox: [13, 52, 14, 53],
      dedupe: false,
    });
    const row = fc.features.find((f) => f.properties?.id === "bbox:stale-source");
    expect(row?.properties?.is_stale).toBe(true);
  }, 30_000);

  it("flags a row as stale when its source has no source_status row at all", async () => {
    const now = new Date();
    await insertRow("bbox:no-status", { source: "bbox-no-status", fetchedAt: now });

    const fc = await observationsByBbox(runner(), {
      domain: "roads",
      bbox: [13, 52, 14, 53],
      dedupe: false,
    });
    const row = fc.features.find((f) => f.properties?.id === "bbox:no-status");
    expect(row?.properties?.is_stale).toBe(true);
  }, 30_000);
});
