import { observationId } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { writeObservationsIn } from "../write-observations.js";
import type { Rejection } from "../write-records.js";
import { historyRegistry } from "./history-registry.js";
import { lookupDrafts } from "./latest-lookup-fixture.js";

type Rec = Record<string, unknown>;
const source = "nl-ndw-flow";
const registry = productionRegistry();
const start = Date.parse("2026-11-04T00:00:00.000Z");

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 1 } });
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: [...new Set([...retentionClasses(registry), ...retentionClasses(historyRegistry())])],
    now: new Date(start),
  });
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await sql`TRUNCATE conditions.observation_latest RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE conditions.observation`;
});

async function write(drafts: Rec[], cycle: number) {
  const rejected: Rejection[] = [];
  const counts = await sql.begin((tx) =>
    writeObservationsIn(
      tx,
      source,
      drafts,
      {
        registry,
        instanceId: "lookup.local",
        complete: false,
        now: new Date(start + cycle * 300_000).toISOString(),
      },
      rejected,
    ),
  );
  expect(rejected).toEqual([]);
  return counts;
}

async function toastReads() {
  // This pool has one connection: publish that backend's pending counters
  // at transaction end before taking a fresh statistics snapshot.
  await sql`SELECT pg_stat_force_next_flush()`;
  await sql`SELECT pg_stat_clear_snapshot()`;
  const [row] = await sql`SELECT toast_blks_read + toast_blks_hit AS accesses
    FROM pg_statio_user_tables WHERE relid='conditions.observation_latest'::regclass`;
  return Number(row!["accesses"]);
}

describe("latest template lookup", () => {
  it("keeps every new sample without fetching a matching static template", async () => {
    await write(lookupDrafts(100, 0), 0);
    const [stored] = await sql`SELECT pg_relation_size(c.reltoastrelid) AS bytes
      FROM pg_class c WHERE c.oid='conditions.observation_latest'::regclass`;
    expect(Number(stored!["bytes"])).toBeGreaterThan(0);
    const before = await toastReads();
    const counts = await write(lookupDrafts(100, 1), 1);
    const after = await toastReads();
    expect(counts).toMatchObject({ latest: 100, history: 100, unchanged: 0 });
    const [history] = await sql`SELECT count(*)::int AS samples FROM conditions.observation`;
    expect(history!["samples"]).toBe(200);
    expect(after - before).toBe(0);
  });

  it("compares the stored credit when templates differ, including an older template encoding", async () => {
    const category = (cycle: number, provider: string) => {
      const draft = lookupDrafts(1, cycle)[0]!;
      draft["aggregation"] = "instantaneous";
      draft["property"] = "traffic.los";
      draft["result"] = { type: "category", value: "free_flow", vocabulary: "los" };
      draft["provenance"] = {
        ...(draft["provenance"] as Rec),
        attribution: { provider, license: "CC0-1.0" },
      };
      draft["id"] = observationId(source, draft as Parameters<typeof observationId>[1]);
      return draft;
    };
    const poll = async (cycle: number, provider: string) => {
      const rejected: Rejection[] = [];
      const counts = await sql.begin((tx) =>
        writeObservationsIn(
          tx,
          source,
          [category(cycle, provider)],
          {
            registry: historyRegistry(),
            instanceId: "lookup.local",
            complete: false,
            now: new Date(start + cycle * 300_000).toISOString(),
          },
          rejected,
        ),
      );
      expect(rejected).toEqual([]);
      return counts;
    };
    await poll(0, "Original publisher");
    await sql`UPDATE conditions.observation_latest SET template_hash='older-template-encoding'`;
    expect(await poll(1, "Original publisher")).toMatchObject({
      latest: 0,
      history: 0,
      unchanged: 1,
    });
    expect(await poll(2, "New publisher")).toMatchObject({ latest: 1, history: 1, unchanged: 0 });
    const [latest] = await sql`SELECT template #>> '{provenance,attribution,provider}' AS provider,
      effective_from FROM conditions.observation_latest`;
    expect(latest).toEqual({
      provider: "New publisher",
      effective_from: new Date("2026-11-04T00:09:00.000Z"),
    });
    const samples = await sql`SELECT r.provenance #>> '{attribution,provider}' AS provider
      FROM conditions.observation o JOIN conditions.contributor_receipt r
      ON r.id=o.extra #>> '{provenance,creditReceiptId}' ORDER BY phenomenon_start`;
    expect(samples.map((r) => r["provider"])).toEqual(["Original publisher", "New publisher"]);
  });

  it("keeps validation at the write boundary for an invalid draft that compares unchanged", async () => {
    const draft = lookupDrafts(1, 0)[0]!;
    await write([draft], 0);
    const invalid = { ...draft, freshness: { fetchedAt: "invalid-time" } };
    expect(await write([invalid], 0)).toMatchObject({ latest: 0, history: 0, unchanged: 1 });
    const rejected: Rejection[] = [];
    const counts = await sql.begin((tx) =>
      writeObservationsIn(
        tx,
        source,
        [{ ...lookupDrafts(1, 1)[0]!, freshness: { fetchedAt: "invalid-time" } }],
        {
          registry,
          instanceId: "lookup.local",
          complete: false,
          now: new Date(start + 300_000).toISOString(),
        },
        rejected,
      ),
    );
    expect(counts).toMatchObject({ latest: 0, history: 0, unchanged: 0 });
    expect(rejected).toHaveLength(1);
  });
});
