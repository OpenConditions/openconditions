import { runMigrations } from "@openconditions/core/server";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertSourceStatus } from "../pipeline/source-status.js";
import { sweepStaleObservations } from "../pipeline/sweep.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const HOUR_MS = 3600_000;

async function insertRow(
  id: string,
  opts: {
    source?: string;
    originKind?: "feed" | "crowd";
    fetchedAt: Date;
    validTo?: Date | null;
    expiresAt?: Date | null;
    staleAfter?: Date | null;
  },
): Promise<void> {
  const origin =
    opts.originKind === "crowd"
      ? { kind: "crowd", reporter: { keyId: "k-test" } }
      : { kind: "feed", attribution: { provider: "test" } };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, metric,
       geom, origin, data_updated_at, fetched_at, valid_to, expires_at, stale_after)
    VALUES (${id}, ${opts.source ?? "sweeptest"}, 'seed', 'roads', 'measurement', 'flow',
       ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[13.4,52.5]}'), 4326),
       ${sql.json(origin)},
       now(), ${opts.fetchedAt}, ${opts.validTo ?? null}, ${opts.expiresAt ?? null}, ${opts.staleAfter ?? null})`;
}

/** Directly controls last_success_at (including backdating it) so tests can
 * simulate "this source's last success was N hours ago" without waiting. */
async function setSourceStatus(
  source: string,
  opts: { lastSuccessAt: Date | null; freshnessWindowSec: number },
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

describe("sweepStaleObservations — crowd rows are not orphan-swept", () => {
  it("KEEPS a non-expired crowd report though 'crowd' has no source_status (the orphan check is feed-only)", async () => {
    const now = new Date();
    // A fresh crowd report: origin.kind 'crowd', source 'crowd' (which never has
    // a source_status row), NULL expires_at and a future expires_at variant.
    await insertRow("crowd:live-null-exp", {
      source: "crowd",
      originKind: "crowd",
      fetchedAt: now,
    });
    await insertRow("crowd:live-future-exp", {
      source: "crowd",
      originKind: "crowd",
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + HOUR_MS),
    });

    const result = await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(result.deleted).toBe(0);

    const remaining = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE source = 'crowd' ORDER BY id`;
    expect(remaining.map((r) => r.id)).toEqual(["crowd:live-future-exp", "crowd:live-null-exp"]);
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
