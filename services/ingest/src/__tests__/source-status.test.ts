import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { readSourceOperationalStatus, upsertSourceStatus } from "../pipeline/source-status.js";

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

describe("durable source operational status", () => {
  it("does not renew network freshness for a cadence skip", async () => {
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
      outcome: "skipped_cadence",
      networkValidated: false,
      durationMs: 0,
    });

    const status = (await readSourceOperationalStatus(sql)).get("status-cadence");
    expect(status).toMatchObject({
      lastOutcome: "skipped_cadence",
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
    const rows = await sql<{ outcome: string; network_validated: boolean }[]>`
      SELECT outcome, network_validated
      FROM conditions.source_poll_attempt
      WHERE source = 'status-stock'
      ORDER BY attempted_at
    `;
    expect(rows).toEqual([
      { outcome: "changed", network_validated: true },
      { outcome: "failed", network_validated: false },
      { outcome: "complete_empty", network_validated: true },
    ]);
  });
});
