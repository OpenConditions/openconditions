import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  maintainPartitions,
  maintainPartitionsAtBoot,
  maintainPartitionsHourly,
} from "../record-jobs.js";

let db: TestDatabase;
let pools: typeof import("../db.js");
const registry = productionRegistry();
const NOW = new Date("2026-10-10T12:00:00Z");

beforeAll(async () => {
  db = await createTestDatabase();
  vi.stubEnv("DATABASE_URL", db.url);
  pools = await import("../db.js");
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([pools?.sql.end(), pools?.apiSql.end(), pools?.maintenanceSql.end()]);
  await db?.close();
});

async function settings(sql: postgres.Sql) {
  const [row] = await sql<
    { statement: string; lock: string; idle: string; transaction: string }[]
  >`SELECT current_setting('statement_timeout') AS statement,
           current_setting('lock_timeout') AS lock,
           current_setting('idle_in_transaction_session_timeout') AS idle,
           current_setting('transaction_timeout', true) AS transaction`;
  return row;
}

/**
 * Holds a lock on the observation history, as a publication writing readings
 * does, until the returned release is called.
 */
async function holdHistory(): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = db.sql.begin(async (tx) => {
    await tx`LOCK TABLE conditions.observation IN ROW EXCLUSIVE MODE`;
    locked();
    await gate;
  });
  await holding;
  return async () => {
    release();
    await holder;
  };
}

const partitionCount = async () =>
  (
    await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_inherits
       WHERE inhparent = 'conditions.observation'::regclass`
  )[0]!.n;

describe("the ingest pools", () => {
  it("open their connections with their own timeouts", async () => {
    expect(await settings(pools.sql)).toMatchObject({
      statement: "5min",
      lock: "1min",
      idle: "10min",
    });
    expect(await settings(pools.apiSql)).toMatchObject({
      statement: "20s",
      lock: "5s",
      idle: "1min",
    });
    expect(await settings(pools.maintenanceSql)).toMatchObject({
      statement: "1h",
      lock: "5s",
      idle: "15min",
    });
    for (const pool of [pools.sql, pools.apiSql, pools.maintenanceSql]) {
      const { transaction } = (await settings(pool))!;
      // Unset on a server that has the setting, absent on one before PostgreSQL 17.
      expect([null, "", "0"]).toContain(transaction);
    }
  });
});

describe("partition maintenance on the maintenance pool", () => {
  it("gives up on a held lock after its lock_timeout, and the hourly run leaves it for the next", async () => {
    const before = await partitionCount();
    const release = await holdHistory();
    try {
      await expect(maintainPartitions(pools.maintenanceSql, registry, NOW)).rejects.toMatchObject({
        code: "55P03",
      });
      await expect(
        maintainPartitionsHourly(pools.maintenanceSql, registry, NOW),
      ).resolves.toBeUndefined();
      expect(await partitionCount()).toBe(before);
    } finally {
      await release();
    }
  }, 60_000);

  it("is tried again at boot until the lock is free", async () => {
    const release = await holdHistory();
    const pauses: number[] = [];
    await maintainPartitionsAtBoot(
      pools.maintenanceSql,
      registry,
      () => NOW,
      async (ms) => {
        pauses.push(ms);
        await release();
      },
    );
    expect(pauses).toHaveLength(1);
    expect(await partitionCount()).toBeGreaterThan(0);
  }, 60_000);
});
