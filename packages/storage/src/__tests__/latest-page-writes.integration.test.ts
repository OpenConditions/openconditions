import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { runMigrations } from "@openconditions/core/server";
import { productionRegistry } from "@openconditions/model-registry";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, expect, it } from "vitest";
import type { Sql } from "../bulk.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { writeObservationsIn } from "../write-observations.js";
import type { Rejection } from "../write-records.js";
import { lookupDrafts } from "./latest-lookup-fixture.js";

type Rec = Record<string, unknown>;
const registry = productionRegistry();
const start = Date.parse("2026-11-04T00:00:00.000Z");
const indices = [0, 1, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3];
let owned: StartedTestContainer | undefined;
let client: postgres.Sql | undefined;
afterAll(async () => {
  try {
    await client?.end({ timeout: 5 });
  } finally {
    await owned?.stop();
  }
}, 30_000);

/** Execute the pre-optimization lookup while keeping every other writer path identical. */
function referenceLookup(tx: postgres.TransactionSql): Sql {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
      return (query: string, params?: postgres.ParameterOrJSON<never>[]) => {
        const fence = "CASE WHEN l.template_hash = r.template_hash THEN NULL ELSE";
        if (query.includes("AS credit_provenance") && !query.includes(fence))
          throw new Error("Reference lookup needs updating for the current writer");
        return target.unsafe(query.replace(fence, "CASE WHEN false THEN NULL ELSE"), params);
      };
    },
  }) as Sql;
}

async function cgroupWrites(container: StartedTestContainer): Promise<Rec> {
  const result = await container.exec(["cat", "/sys/fs/cgroup/io.stat"]);
  if (result.exitCode !== 0) throw new Error("Owned benchmark cgroup I/O is unavailable");
  if (!result.output.trim()) throw new Error("Owned benchmark cgroup has no device counters");
  return Object.fromEntries(
    result.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [device, ...fields] = line.split(/\s+/);
        const bytes = fields.find((f) => f.startsWith("wbytes="));
        if (bytes === undefined) throw new Error("Missing cgroup write bytes");
        return [device!, Number(bytes.slice(7))];
      }),
  );
}

async function snapshot(sql: postgres.Sql, container: StartedTestContainer, pg18: boolean) {
  await sql`SELECT pg_stat_force_next_flush()`;
  await sql`SELECT pg_stat_clear_snapshot()`;
  const [io] =
    await sql.unsafe(`SELECT COALESCE(sum(${pg18 ? "write_bytes" : "writes*op_bytes"}),0)::float8 AS relation_bytes,
    COALESCE(sum(evictions),0)::float8 AS evictions FROM pg_stat_io WHERE object='relation'`);
  const [table] = await sql`SELECT n_tup_upd::float8 AS updates,n_tup_hot_upd::float8 AS hot,
    autovacuum_count::float8 AS autovacuums FROM pg_stat_user_tables WHERE relid='conditions.observation_latest'::regclass`;
  const [toast] = await sql`SELECT (toast_blks_hit+toast_blks_read)::float8 AS accesses,
    toast_blks_read::float8 AS reads FROM pg_statio_user_tables WHERE relid='conditions.observation_latest'::regclass`;
  const [wal] = await sql`SELECT pg_current_wal_insert_lsn()::text AS lsn`;
  return { io, table, toast, lsn: wal!["lsn"] as string, cgroup: await cgroupWrites(container) };
}

it.runIf(process.env["OC_RUN_PAGE_WRITE_BENCHMARK"] === "1")(
  "compares durable page writes with a working set larger than shared buffers",
  async () => {
    const profile = postgisProfile();
    const rows = Number(process.env["OC_PAGE_WRITE_ROWS"] ?? 24000);
    const cycles = Number(process.env["OC_PAGE_WRITE_CYCLES"] ?? 12);
    const buffers = Number(process.env["OC_PAGE_WRITE_BUFFERS_MB"] ?? 64);
    const vacuumNaptime = Number(process.env["OC_PAGE_WRITE_AUTOVACUUM_NAPTIME_SEC"] ?? 60);
    if (![rows, cycles, buffers, vacuumNaptime].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error("Invalid benchmark dimensions");
    const container = await new GenericContainer(POSTGIS_IMAGES[profile])
      .withEnvironment({ POSTGRES_DB: "bench", POSTGRES_USER: "bench", POSTGRES_PASSWORD: "bench" })
      .withCommand([
        "postgres",
        "-c",
        `shared_buffers=${buffers}MB`,
        "-c",
        "wal_compression=zstd",
        "-c",
        "checkpoint_timeout=1h",
        "-c",
        "max_wal_size=4GB",
        "-c",
        `autovacuum_naptime=${vacuumNaptime}s`,
      ])
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start();
    owned = container;
    const url = `postgres://bench:bench@${container.getHost()}:${container.getMappedPort(5432)}/bench`;
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    client = sql;
    await assertPostgisProfile(sql, profile, {
      fixture: "latest-page-writes",
      containerId: container.getId(),
    });
    await runMigrations(url);
    await ensureObservationPartitions(sql, {
      classes: retentionClasses(registry),
      now: new Date(start),
    });
    const settings = await sql`SELECT name,setting,unit FROM pg_settings WHERE name IN
      ('shared_buffers','fsync','full_page_writes','synchronous_commit','autovacuum','autovacuum_naptime','wal_compression','checkpoint_timeout','bgwriter_lru_maxpages') ORDER BY name`;
    for (const name of ["fsync", "full_page_writes", "synchronous_commit", "autovacuum"])
      expect(settings.find((s) => s["name"] === name)?.["setting"]).toBe("on");
    const arms: Rec[] = [];
    for (const arm of ["reference", "candidate", "candidate", "reference"]) {
      await sql`TRUNCATE conditions.observation_latest RESTART IDENTITY CASCADE`;
      await sql`TRUNCATE conditions.observation`;
      const write = async (source: string, drafts: Rec[], cycle: number) => {
        const rejected: Rejection[] = [];
        const counts = await sql.begin((tx) =>
          writeObservationsIn(
            arm === "reference" ? referenceLookup(tx) : tx,
            source,
            drafts,
            {
              registry,
              instanceId: "benchmark.local",
              complete: false,
              now: new Date(start + cycle * 300_000).toISOString(),
            },
            rejected,
          ),
        );
        expect(rejected).toEqual([]);
        return counts;
      };
      for (const [source, count] of [
        ["nl-ndw-flow", rows],
        ["benchmark-other", Math.floor(rows / 3)],
      ] as const) {
        const seed = lookupDrafts(count, 0, { source, indices });
        for (let offset = 0; offset < seed.length; offset += 1000) {
          await write(source, seed.slice(offset, offset + 1000), 0);
          await sql`ANALYZE conditions.observation_latest`;
        }
      }
      await sql`CHECKPOINT`;
      const [size] = await sql`SELECT pg_relation_size(c.oid)::float8 AS heap,
        pg_indexes_size(c.oid)::float8 AS indexes,pg_total_relation_size(c.reltoastrelid)::float8 AS toast
        FROM pg_class c WHERE c.oid='conditions.observation_latest'::regclass`;
      expect(
        Number(size!["heap"]) + Number(size!["indexes"]) + Number(size!["toast"]),
      ).toBeGreaterThan(buffers * 1024 * 1024);
      const before = await snapshot(sql, container, profile === "pg18");
      const latency: number[] = [];
      const counts = { latest: 0, history: 0, unchanged: 0 };
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const drafts = lookupDrafts(rows, cycle, { indices });
        const t = performance.now();
        const count = await write("nl-ndw-flow", drafts, cycle);
        latency.push(performance.now() - t);
        expect(count.latest).toBe(rows);
        for (const k of ["latest", "history", "unchanged"] as const) counts[k] += count[k];
        // An unchanged second network still compares its readings; competing
        // index/heap reads and a sweep-like expiry check happen between polls.
        if (cycle % 2 === 0) {
          const other = await write(
            "benchmark-other",
            lookupDrafts(Math.floor(rows / 3), 0, { source: "benchmark-other", indices }),
            cycle,
          );
          expect(other.latest).toBe(0);
          expect(other.unchanged).toBe(Math.floor(rows / 3));
        }
        await sql`SELECT count(*) FROM conditions.observation_latest WHERE expires_at < now()`;
        // Let the default background writer and autovacuum run between polls.
        await sql`SELECT pg_sleep(0.25)`;
      }
      await sql.unsafe("VACUUM (ANALYZE) conditions.observation_latest");
      await sql`CHECKPOINT`;
      await sql`SELECT pg_sleep(1.1)`;
      const after = await snapshot(sql, container, profile === "pg18");
      const [wal] =
        await sql`SELECT pg_wal_lsn_diff(${after.lsn}::pg_lsn,${before.lsn}::pg_lsn)::float8 AS bytes`;
      const [records] =
        await sql`SELECT md5(string_agg(md5(conditions.observation_record(template,reading)::text),'' ORDER BY series_id)) AS digest FROM conditions.observation_latest`;
      const [samples] =
        await sql`SELECT md5(string_agg(md5(to_jsonb(o)::text),'' ORDER BY series_id,phenomenon_start)) AS digest FROM conditions.observation o`;
      const result = {
        arm,
        rows,
        cycles,
        buffers_mb: buffers,
        size,
        counts,
        latency_ms: latency,
        wal_bytes: wal!["bytes"],
        relation_bytes: Number(after.io!["relation_bytes"]) - Number(before.io!["relation_bytes"]),
        evictions: Number(after.io!["evictions"]) - Number(before.io!["evictions"]),
        updates: Number(after.table!["updates"]) - Number(before.table!["updates"]),
        hot: Number(after.table!["hot"]) - Number(before.table!["hot"]),
        autovacuums: Number(after.table!["autovacuums"]) - Number(before.table!["autovacuums"]),
        toast_accesses: Number(after.toast!["accesses"]) - Number(before.toast!["accesses"]),
        cgroup_write_bytes: Object.fromEntries(
          Object.entries(after.cgroup).map(([d, n]) => [
            d,
            Number(n) - Number(before.cgroup[d] ?? 0),
          ]),
        ),
        records: records!["digest"],
        samples: samples!["digest"],
      };
      console.info("PAGE_WRITE_ARM", JSON.stringify(result));
      arms.push(result);
      expect(result.records).toBe(arms[0]!["records"]);
      expect(result.samples).toBe(arms[0]!["samples"]);
      expect(result.counts).toEqual(arms[0]!["counts"]);
    }
    const receipt = {
      profile,
      image: POSTGIS_IMAGES[profile],
      container: container.getId(),
      settings,
      arms,
    };
    const output = process.env["OC_PAGE_WRITE_RECEIPT"];
    if (output) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    console.info("PAGE_WRITE_BENCHMARK", JSON.stringify(receipt));
  },
  1_800_000,
);
