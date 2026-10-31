import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import {
  pruneRollups,
  rollupObservations,
  rollupParameters,
  rollupStatement,
} from "../observation-rollup.js";
import { writeSnapshot } from "../write-records.js";
import { observationDraft } from "./drafts.js";
import { historyRegistry } from "./history-registry.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
// Fuel prices no longer keep a history; they still show the daily rollup by amount.
const registry = historyRegistry();
const NOW = new Date("2026-10-01T16:30:00Z");
const PRODUCT = { kind: "feature", featureId: "oc:feature:es-minetur:42", componentKey: "e5" };

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, { classes: retentionClasses(registry), now: NOW });
  const write = (source: string, observations: Record<string, unknown>[]) =>
    writeSnapshot(
      sql,
      source,
      { observations },
      { registry, instanceId: "test.local", now: NOW.toISOString(), complete: true },
    );
  // Five speeds in the 08:00 hour, two in the 12:00 hour (still open for late readings at 16:30).
  const speeds: [string, number][] = [
    ["08:00", 81],
    ["08:01", 80.5],
    ["08:02", 79],
    ["08:03", 120],
    ["08:59", 81.9],
    ["12:00", 50],
    ["12:30", 52],
  ];
  for (const [at, value] of speeds) {
    await write("nl-ndw-flow", [
      observationDraft(
        "traffic.speed",
        { type: "quantity", value, unit: "km/h" },
        { at: `2026-10-01T${at}:00Z`, aggregation: "mean" },
      ),
    ]);
  }
  // A forecast of the 08:00 hour says what was expected, not what was measured: no rollup counts it.
  await write("nl-ndw-flow", [
    observationDraft(
      "traffic.speed",
      { type: "quantity", value: 30, unit: "km/h" },
      {
        at: "2026-10-01T08:30:00Z",
        aggregation: "mean",
        temporality: "forecast",
        forecast: { issuedAt: "2026-10-01T07:00:00.000Z", leadTime: { value: 5400, unit: "s" } },
      },
    ),
  ]);
  for (const [at, amount] of [
    ["2026-09-29T07:00:00Z", "1.4590"],
    ["2026-09-29T15:00:00Z", "1.4790"],
    ["2026-09-30T07:00:00Z", "1.4690"],
  ]) {
    await write("es-minetur", [
      observationDraft(
        "fuel.price",
        { type: "money", amount, currency: "EUR", per: "L" },
        { at, subject: PRODUCT, sourceId: "es-minetur" },
      ),
    ]);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

interface PlanNode extends Record<string, unknown> {
  Plans?: PlanNode[];
}

const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];

/**
 * The joins with an aggregate on both sides. Estimated at one row each, such
 * a join of two aggregates of every series is planned as a nested loop.
 */
function aggregateJoins(plan: PlanNode): PlanNode[] {
  const aggregates = (n: PlanNode) =>
    nodesOf(n).some((m) => m["Node Type"] === "Aggregate" || m["Node Type"] === "CTE Scan");
  return nodesOf(plan).filter(
    (n) =>
      ["Nested Loop", "Hash Join", "Merge Join"].includes(n["Node Type"] as string) &&
      (n.Plans ?? []).every(aggregates),
  );
}

describe("rollupObservations", () => {
  it("rolls finished hours into a histogram of the declared bin width, leaving open hours", async () => {
    const result = await rollupObservations(sql, { registry, period: "hourly", now: NOW });
    expect(result).toEqual({ through: "2026-10-01T10:00:00.000Z", rows: 1 });
    const [hour] = await sql`
      SELECT hour_utc, sample_count, bins, counts, min, max, mean
      FROM conditions.observation_rollup_hourly`;
    expect(hour).toEqual({
      hour_utc: new Date("2026-10-01T08:00:00Z"),
      sample_count: 5,
      bins: [39, 40, 60],
      counts: [1, 3, 1],
      min: 79,
      max: 120,
      mean: (81 + 80.5 + 79 + 120 + 81.9) / 5,
    });
  });

  it("does nothing again until another hour finishes", async () => {
    expect(await rollupObservations(sql, { registry, period: "hourly", now: NOW })).toEqual({
      rows: 0,
    });
    const later = new Date("2026-10-01T19:10:00Z");
    expect(await rollupObservations(sql, { registry, period: "hourly", now: later })).toEqual({
      through: "2026-10-01T13:00:00.000Z",
      rows: 1,
    });
  });

  it("rolls slow series up by day, by amount", async () => {
    await rollupObservations(sql, { registry, period: "daily", now: NOW });
    const days =
      await sql`SELECT day_utc, sample_count, min, max FROM conditions.observation_rollup_daily
      ORDER BY day_utc`;
    expect(days).toEqual([
      { day_utc: new Date("2026-09-29T00:00:00Z"), sample_count: 2, min: 1.459, max: 1.479 },
      { day_utc: new Date("2026-09-30T00:00:00Z"), sample_count: 1, min: 1.469, max: 1.469 },
    ]);
  });

  it("prunes rollups past their retention", async () => {
    const pruned = await pruneRollups(sql, {
      now: new Date("2026-11-20T00:00:00Z"),
      hourlyDays: 35,
      dailyDays: 400,
      registry,
    });
    expect(pruned).toEqual({ hourly: 2, daily: 0, retired: 0 });
  });

  it("prunes the rollups of a property that no longer rolls up", async () => {
    await rollupObservations(sql, { registry, period: "daily", now: NOW });
    const pruned = await pruneRollups(sql, {
      now: NOW,
      hourlyDays: 35,
      dailyDays: 400,
      registry: productionRegistry(),
    });
    expect(pruned).toEqual({ hourly: 0, daily: 0, retired: 2 });
    const [{ count }] =
      await sql`SELECT count(*)::int AS count FROM conditions.observation_rollup_daily`;
    expect(count).toBe(0);
  });

  it("keeps the hourly rollups of a property that still rolls up, and finds nothing the next time", async () => {
    // Hours of every series: the speed still rolls up hourly, the fuel price no longer does.
    await sql`
      INSERT INTO conditions.observation_rollup_hourly (series_id, hour_utc, sample_count, min, max, mean)
      SELECT l.series_id, h, 1, 1, 1, 1
        FROM conditions.observation_latest l,
             generate_series('2026-10-01T00:00:00Z'::timestamptz, '2026-10-01T05:00:00Z', '1 hour') h
       WHERE l.property IN ('traffic.speed', 'fuel.price')
      ON CONFLICT DO NOTHING`;
    const counts = () => sql<{ property: string; n: number }[]>`
      SELECT l.property, count(*)::int AS n FROM conditions.observation_rollup_hourly h
        JOIN conditions.observation_latest l USING (series_id) GROUP BY 1 ORDER BY 1`;
    expect(await counts()).toEqual([
      { property: "fuel.price", n: 6 },
      { property: "traffic.speed", n: 6 },
    ]);
    const prune = () =>
      pruneRollups(sql, {
        now: NOW,
        hourlyDays: 35,
        dailyDays: 400,
        registry: productionRegistry(),
      });
    expect(await prune()).toEqual({ hourly: 0, daily: 0, retired: 6 });
    expect(await counts()).toEqual([{ property: "traffic.speed", n: 6 }]);
    expect(await prune()).toEqual({ hourly: 0, daily: 0, retired: 0 });
  });

  it("joins no aggregate to another, whatever a stale estimate makes of the hour", async () => {
    // Planned as the rollup runs, with the custom plan of these parameters.
    const plan = await sql.begin(async (tx) => {
      const [{ "QUERY PLAN": plans }] = (await tx.unsafe(
        `EXPLAIN (FORMAT JSON) ${rollupStatement("hourly")}`,
        rollupParameters(
          [{ property: "traffic.speed", bin_width: 2 }],
          new Date("2026-10-01T08:00:00Z"),
          new Date("2026-10-01T09:00:00Z"),
        ),
      )) as { "QUERY PLAN": { Plan: PlanNode }[] }[];
      return plans![0]!.Plan;
    });
    expect(aggregateJoins(plan)).toEqual([]);
  });

  it("reads an hour of history through a block range index, not the whole day", async () => {
    const indexes = await sql<{ method: string; def: string }[]>`
      SELECT am.amname AS method, pg_get_indexdef(i.indexrelid) AS def
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
       WHERE i.indrelid = 'conditions.observation'::regclass`;
    expect(indexes.some((i) => i.method === "brin" && i.def.includes("(phenomenon_start)"))).toBe(
      true,
    );
  });
});
