import { runMigrations } from "@openconditions/core/server";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeAbandonedPollAttempts,
  openPollAttempt,
  pruneSourcePollAttempts,
  readSourceOperationalStatus,
  upsertSourceStatus,
} from "../pipeline/source-status.js";

let sql: postgres.Sql;
let stop: () => Promise<unknown>;

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
  stop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.source_poll_attempt, conditions.source_status`;
});

describe("durable source operational status", () => {
  it("records the payload hashes an attempt received, and none when it downloaded nothing", async () => {
    const hashes = ["a".repeat(64), "b".repeat(64)];
    await upsertSourceStatus(sql, "status-payloads", {
      attemptAt: "2026-09-11T10:00:00.000Z",
      freshnessWindowSec: 900,
      outcome: "partial",
      networkValidated: false,
      payloadHashes: hashes,
    });
    await upsertSourceStatus(sql, "status-payloads", {
      attemptAt: "2026-09-11T10:05:00.000Z",
      freshnessWindowSec: 900,
      outcome: "validated_unchanged",
      networkValidated: true,
    });
    const rows = await sql<{ payload_hashes: string[] | null }[]>`
      SELECT payload_hashes FROM conditions.source_poll_attempt
      WHERE source = 'status-payloads' ORDER BY attempted_at`;
    expect(rows.map((r) => r.payload_hashes)).toEqual([hashes, null]);
  });

  it("does not renew network freshness for an overlap skip", async () => {
    await upsertSourceStatus(sql, "status-cadence", {
      attemptAt: "2026-09-11T10:00:00.000Z",
      freshnessWindowSec: 900,
      outcome: "validated_unchanged",
      networkValidated: true,
      durationMs: 20,
    });
    await upsertSourceStatus(sql, "status-cadence", {
      attemptAt: "2026-09-11T10:05:00.000Z",
      freshnessWindowSec: 900,
      outcome: "skipped_overlap",
      networkValidated: false,
      durationMs: 0,
    });

    const status = (await readSourceOperationalStatus(sql)).get("status-cadence");
    expect(status).toMatchObject({
      lastOutcome: "skipped_overlap",
      lastAttemptAt: "2026-09-11T10:05:00.000Z",
      lastNetworkSuccessAt: "2026-09-11T10:00:00.000Z",
      freshnessDeadline: "2026-09-11T10:15:00.000Z",
    });
  });

  it("keeps publication facts through failures and records a complete empty publication as zero", async () => {
    await upsertSourceStatus(sql, "status-stock", {
      attemptAt: "2026-09-11T11:00:00.000Z",
      freshnessWindowSec: 600,
      outcome: "changed",
      networkValidated: true,
      publication: { activeEvents: 4, inserted: 3, updated: 1, deleted: 2, rejected: 1 },
      durationMs: 80,
    });
    await upsertSourceStatus(sql, "status-stock", {
      attemptAt: "2026-09-11T11:01:00.000Z",
      freshnessWindowSec: 600,
      outcome: "failed",
      networkValidated: false,
      error: "bad token SECRET at https://example.test/feed?key=SECRET",
      durationMs: 15,
    });

    let status = (await readSourceOperationalStatus(sql)).get("status-stock");
    expect(status).toMatchObject({
      lastOutcome: "failed",
      activeEvents: 4,
      lastInserted: 3,
      lastUpdated: 1,
      lastDeleted: 2,
      lastRejected: 1,
      publicationRevision: 1,
      consecutiveFailures: 1,
    });
    expect(status?.lastError).not.toContain("SECRET");

    await upsertSourceStatus(sql, "status-stock", {
      attemptAt: "2026-09-11T11:02:00.000Z",
      freshnessWindowSec: 600,
      outcome: "complete_empty",
      networkValidated: true,
      publication: { activeEvents: 0, inserted: 0, updated: 0, deleted: 4, rejected: 0 },
      durationMs: 33,
    });
    status = (await readSourceOperationalStatus(sql)).get("status-stock");
    expect(status).toMatchObject({
      lastOutcome: "complete_empty",
      activeEvents: 0,
      publicationRevision: 2,
      consecutiveFailures: 0,
    });
  });

  it("does not let an older completion replace the latest attempt", async () => {
    await upsertSourceStatus(sql, "status-order", {
      attemptAt: "2026-09-11T12:05:00.000Z",
      freshnessWindowSec: 300,
      outcome: "failed",
      networkValidated: false,
      error: "new failure",
      durationMs: 4,
    });
    await upsertSourceStatus(sql, "status-order", {
      attemptAt: "2026-09-11T12:00:00.000Z",
      freshnessWindowSec: 300,
      outcome: "changed",
      networkValidated: true,
      publication: { activeEvents: 9, inserted: 9, updated: 0, deleted: 0, rejected: 0 },
      durationMs: 50,
    });

    const status = (await readSourceOperationalStatus(sql)).get("status-order");
    expect(status).toMatchObject({
      lastAttemptAt: "2026-09-11T12:05:00.000Z",
      lastOutcome: "failed",
      lastError: "new failure",
    });
    expect(status?.publicationRevision).toBe(1);
  });

  it("keeps a restart-safe seven-day attempt history", async () => {
    for (const [index, outcome] of ["changed", "failed", "complete_empty"].entries()) {
      await upsertSourceStatus(sql, "status-history", {
        attemptAt: `2026-09-11T11:0${index}:00.000Z`,
        freshnessWindowSec: 600,
        outcome: outcome as "changed" | "failed" | "complete_empty",
        networkValidated: outcome !== "failed",
      });
    }
    const rows = await sql<{ outcome: string; network_validated: boolean }[]>`
      SELECT outcome, network_validated
      FROM conditions.source_poll_attempt
      WHERE source = 'status-history'
      ORDER BY attempted_at
    `;
    expect(rows).toEqual([
      { outcome: "changed", network_validated: true },
      { outcome: "failed", network_validated: false },
      { outcome: "complete_empty", network_validated: true },
    ]);
  });

  it("prunes only expired history in bounded batches and never while publishing status", async () => {
    const now = "2026-09-11T12:00:00.000Z";
    for (let index = 0; index < 4; index++) {
      await upsertSourceStatus(sql, `old-${index}`, {
        attemptAt: "2026-08-01T12:00:00.000Z",
        freshnessWindowSec: 600,
        outcome: "failed",
      });
    }
    for (const [source, attemptAt] of [
      ["boundary", "2026-08-11T12:00:00.000Z"],
      ["recent", now],
    ]) {
      await upsertSourceStatus(sql, source!, {
        attemptAt,
        freshnessWindowSec: 600,
        outcome: "validated_unchanged",
      });
    }
    const count = async () =>
      Number((await sql`SELECT count(*) AS n FROM conditions.source_poll_attempt`)[0]!.n);
    expect(await count()).toBe(6); // status writes never perform retention
    expect(await pruneSourcePollAttempts(sql, { now, batchSize: 2 })).toEqual({ deleted: 2 });
    expect(await count()).toBe(4);
    expect(await pruneSourcePollAttempts(sql, { now, batchSize: 2 })).toEqual({ deleted: 2 });
    expect(await pruneSourcePollAttempts(sql, { now, batchSize: 2 })).toEqual({ deleted: 0 });
    expect(
      (await sql`SELECT source FROM conditions.source_poll_attempt ORDER BY source`).map(
        (row) => row.source,
      ),
    ).toEqual(["boundary", "recent"]);
    expect((await readSourceOperationalStatus(sql)).size).toBe(6);
  });

  it("rolls back publication status and its poll fact with the caller's transaction", async () => {
    await expect(
      sql.begin(async (tx) => {
        await upsertSourceStatus(tx, "rolled-back", {
          freshnessWindowSec: 600,
          outcome: "changed",
          networkValidated: true,
          publication: { activeEvents: 1, inserted: 1, updated: 0, deleted: 0, rejected: 0 },
        });
        throw new Error("publication failed");
      }),
    ).rejects.toThrow("publication failed");
    expect(await sql`SELECT source FROM conditions.source_status`).toHaveLength(0);
    expect(await sql`SELECT source FROM conditions.source_poll_attempt`).toHaveLength(0);
  });

  it("closes, at boot, the attempts a stopped service left running", async () => {
    const abandoned = await openPollAttempt(sql, "nl-ndw-events", "2026-10-01T10:00:00.000Z");
    const finished = await openPollAttempt(sql, "nl-ndw-events", "2026-10-01T10:05:00.000Z");
    await upsertSourceStatus(sql, "nl-ndw-events", {
      freshnessWindowSec: 900,
      outcome: "changed",
      attemptAt: "2026-10-01T10:05:00.000Z",
      attemptId: finished,
    });
    expect(await closeAbandonedPollAttempts(sql)).toBe(1);
    const rows = await sql<{ id: string; outcome: string; finished: boolean }[]>`
      SELECT id, outcome, finished_at IS NOT NULL AS finished
        FROM conditions.source_poll_attempt ORDER BY id`;
    expect(rows).toEqual([
      { id: String(abandoned), outcome: "failed", finished: true },
      { id: String(finished), outcome: "changed", finished: true },
    ]);
  });
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
