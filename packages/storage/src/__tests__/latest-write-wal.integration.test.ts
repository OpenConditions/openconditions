import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { recordOf } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { observationId } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "../bulk.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { writeObservationsIn } from "../write-observations.js";
import type { Rejection } from "../write-records.js";

type Rec = Record<string, unknown>;
const source = "nl-ndw-flow";
const registry = productionRegistry();
const start = Date.parse("2026-11-04T00:00:00.000Z");
const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../../scripts/fixtures/ndw-latest-readings.json", import.meta.url),
    "utf8",
  ),
) as { template: Rec; reading: Rec }[];
const samples = fixtures.map((f) => recordOf(f.template, f.reading));
// Approximately one site speed and one site volume per ten channel readings.
const sampleIndices = [0, 1, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3];
let ownedContainer: StartedTestContainer | undefined;
let ownedSql: postgres.Sql | undefined;
afterAll(async () => {
  try {
    await ownedSql?.end({ timeout: 5 });
  } finally {
    await ownedContainer?.stop();
  }
}, 30_000);
const expanded = process.env["OC_RUN_LATEST_WRITE_BENCHMARK"] === "1";

function drafts(rows: number, cycle: number): Rec[] {
  return Array.from({ length: rows }, (_, i) => {
    const original = samples[sampleIndices[i % sampleIndices.length]!]!;
    const {
      canonicalId: _c,
      domain: _d,
      contentHash: _h,
      revision: _r,
      recordedAt: _at,
      sinceAt: _since,
      evidence: _e,
      ...draft
    } = original;
    const subject = draft["subject"] as Rec;
    const nextSubject = {
      ...subject,
      featureId: `${subject["featureId"]}-bench-${Math.floor(i / sampleIndices.length)}`,
      ...(subject["componentKey"] === undefined
        ? {}
        : {
            componentKey: `${subject["componentKey"]}-${Math.floor((i % sampleIndices.length) / 2)}`,
          }),
    };
    const end = new Date(start + cycle * 300_000).toISOString();
    const next: Rec = {
      ...draft,
      subject: nextSubject,
      phenomenonTime: { start: new Date(start + cycle * 300_000 - 60_000).toISOString(), end },
      freshness: { fetchedAt: end },
    };
    return {
      ...next,
      id: observationId(source, next as unknown as Parameters<typeof observationId>[1]),
    };
  });
}

/**
 * Restore the previous on-disk representation at the SQL boundary. Both
 * arms execute the same production writer, sealing, history and receipts.
 * The template hash remains the writer's, so it reuses the stored template
 * pointer just as the previous writer did; it is not an API record field.
 */
function legacyWriter(tx: postgres.TransactionSql): Sql {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
      return (query: string, params?: unknown[]) => {
        if (/(?:UPDATE|INSERT INTO) conditions\.observation_latest/.test(query) && params?.[0]) {
          const rows = JSON.parse(params[0] as string) as Rec[];
          for (const row of rows) {
            if (row["reading"] === undefined) continue;
            const reading = row["reading"] as Rec;
            const full = recordOf({ namespace: source }, reading);
            row["reading"] = {
              ...reading,
              id: full["id"],
              canonicalId: full["canonicalId"],
              revision: 1,
              temporality: "live",
              aggregation: "mean",
            };
            if (row["template"] != null) {
              const {
                revision: _r,
                temporality: _t,
                aggregation: _a,
                ...template
              } = row["template"] as Rec;
              row["template"] = template;
            }
          }
          params = [JSON.stringify(rows), ...params.slice(1)];
        }
        return target.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
      };
    },
  }) as Sql;
}

describe("latest reading write amplification", () => {
  it("preserves every record and sample with less WAL on an isolated server", async () => {
    const profile = postgisProfile();
    const container = await new GenericContainer(POSTGIS_IMAGES[profile])
      .withEnvironment({ POSTGRES_DB: "bench", POSTGRES_USER: "bench", POSTGRES_PASSWORD: "bench" })
      .withCommand([
        "postgres",
        "-c",
        "shared_buffers=256MB",
        "-c",
        "wal_compression=zstd",
        "-c",
        "checkpoint_timeout=1h",
        "-c",
        "max_wal_size=4GB",
        "-c",
        "autovacuum=off",
      ])
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start();
    ownedContainer = container;
    const url = `postgres://bench:bench@${container.getHost()}:${container.getMappedPort(5432)}/bench`;
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    ownedSql = sql;
    const results: Rec[] = [];
    try {
      await assertPostgisProfile(sql, profile, {
        fixture: "latest-write-wal",
        containerId: container.getId(),
      });
      await runMigrations(url);
      await ensureObservationPartitions(sql, {
        classes: retentionClasses(registry),
        now: new Date(start),
      });
      for (const rows of expanded ? [2_000, 20_000] : [600]) {
        const cycles = expanded ? 8 : 4;
        const arms: Rec[] = [];
        for (const arm of ["legacy", "compact"] as const) {
          await sql`TRUNCATE conditions.observation_latest RESTART IDENTITY CASCADE`;
          await sql`TRUNCATE conditions.observation`;
          const write = async (cycle: number) => {
            const rejected: Rejection[] = [];
            const counts = await sql.begin((tx) =>
              writeObservationsIn(
                arm === "legacy" ? legacyWriter(tx) : tx,
                source,
                drafts(rows, cycle),
                {
                  registry,
                  instanceId: "bench.local",
                  complete: false,
                  now: new Date(start + cycle * 300_000).toISOString(),
                },
                rejected,
              ),
            );
            expect(rejected).toEqual([]);
            expect(counts.latest).toBe(rows);
            return counts;
          };
          // Establish representative planner statistics before the timed
          // phase; disabling autovacuum must not leave an empty-table plan
          // walking an ever-growing seed as a nested loop.
          const seed = drafts(rows, 0);
          for (let offset = 0; offset < seed.length; offset += 1_000) {
            await sql.begin((tx) =>
              writeObservationsIn(
                arm === "legacy" ? legacyWriter(tx) : tx,
                source,
                seed.slice(offset, offset + 1_000),
                {
                  registry,
                  instanceId: "bench.local",
                  complete: false,
                  now: new Date(start).toISOString(),
                },
                [],
              ),
            );
            await sql`ANALYZE conditions.observation_latest`;
          }
          await sql`CHECKPOINT`;
          const [before] = await sql`SELECT pg_current_wal_insert_lsn()::text AS lsn`;
          const t = performance.now();
          const counts = { latest: 0, history: 0 };
          const wal: number[] = [];
          let previous = before!["lsn"] as string;
          for (let cycle = 1; cycle <= cycles; cycle++) {
            const count = await write(cycle);
            counts.latest += count.latest;
            counts.history += count.history;
            const [after] = await sql`SELECT pg_current_wal_insert_lsn()::text AS lsn,
              pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ${previous}::pg_lsn)::float8 AS bytes`;
            previous = after!["lsn"] as string;
            wal.push(after!["bytes"] as number);
          }
          const ms = performance.now() - t;
          await sql`CHECKPOINT`;
          const [sizes] = await sql`SELECT avg(pg_column_size(reading))::int AS reading_bytes,
            pg_relation_size('conditions.observation_latest')::float8 AS heap_bytes,
            pg_total_relation_size(c.reltoastrelid)::float8 AS toast_bytes
            FROM conditions.observation_latest l CROSS JOIN pg_class c
            WHERE c.oid='conditions.observation_latest'::regclass GROUP BY c.reltoastrelid`;
          const [digest] =
            await sql`SELECT md5(string_agg(md5(conditions.observation_record(template,reading)::text), '' ORDER BY series_id)) AS records FROM conditions.observation_latest`;
          const [history] =
            await sql`SELECT md5(string_agg(md5(to_jsonb(o)::text), '' ORDER BY series_id,phenomenon_start)) AS samples FROM conditions.observation o`;
          const result = {
            arm,
            rows,
            cycles,
            ...counts,
            ms,
            wal_bytes: wal.reduce((a, b) => a + b, 0),
            cold_wal_bytes: wal[0],
            warm_wal_bytes: wal.slice(1).reduce((a, b) => a + b, 0),
            ...sizes,
            ...digest,
            ...history,
          };
          arms.push(result);
          console.info("LATEST_WRITE_ARM", JSON.stringify(result));
        }
        const [legacy, compact] = arms as [Rec, Rec];
        expect(compact["records"]).toBe(legacy["records"]);
        expect(compact["samples"]).toBe(legacy["samples"]);
        expect(compact["history"]).toBe(legacy["history"]);
        expect(compact["wal_bytes"] as number).toBeLessThan((legacy["wal_bytes"] as number) * 0.9);
        expect(compact["toast_bytes"] as number).toBeLessThanOrEqual(
          legacy["toast_bytes"] as number,
        );
        results.push(...arms);
      }
      const receipt = {
        profile,
        image: POSTGIS_IMAGES[profile],
        container: container.getId(),
        results,
      };
      console.info("LATEST_WRITE_BENCHMARK", JSON.stringify(receipt));
      const output = process.env["OC_LATEST_WRITE_BENCHMARK_RECEIPT"];
      if (output) {
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
      }
    } finally {
      try {
        await sql.end({ timeout: 5 });
        ownedSql = undefined;
      } finally {
        await container.stop();
        ownedContainer = undefined;
      }
    }
  }, 600_000);
});
