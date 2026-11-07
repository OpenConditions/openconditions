import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { recordOf, templateHash } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { observationId } from "@openconditions/model";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, expect, it } from "vitest";
import type { Sql } from "../bulk.js";
import { refreshFused } from "../fused-rows.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { syncSources } from "../sources.js";
import { writeObservationsIn } from "../write-observations.js";
import { type Rejection, writeSnapshotIn } from "../write-records.js";
import { goldenFacilities, polled, registry } from "./facility-fixtures.js";
import { lookupDrafts } from "./latest-lookup-fixture.js";

type Rec = Record<string, unknown>;
const start = Date.parse("2026-11-04T00:00:00.000Z");
const fuel = "es-minetur-fuel",
  restricted = "es-fuel-test";
const indices = [0, 1, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3];
const fence =
  "template = CASE WHEN observation_latest.template_hash = excluded.template_hash THEN observation_latest.template ELSE excluded.template END";
let owned: StartedTestContainer | undefined;
let client: postgres.Sql | undefined;
let admin: postgres.Sql | undefined;
afterAll(async () => {
  try {
    await client?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  } finally {
    await owned?.stop();
  }
}, 30_000);

/** Restore the prior stored lineage and ordinary full-template upsert. */
function reference(tx: postgres.TransactionSql): Sql {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
      return (query: string, parameters?: postgres.ParameterOrJSON<never>[]) => {
        if (
          query.startsWith("INSERT INTO conditions.observation_latest") &&
          query.includes("fused_public")
        ) {
          if (!query.includes(fence))
            throw new Error("Fused reference needs updating for this writer");
          const rows = JSON.parse(parameters![0] as string) as Rec[];
          for (const row of rows) {
            const template = row["template"] as Rec,
              reading = row["reading"] as Rec;
            if (!Array.isArray(reading["_ocFusionRecordIds"]))
              throw new Error("Expected compact fusion input");
            const record = recordOf(template, reading),
              p = record["provenance"] as Rec;
            row["template"] = {
              ...template,
              provenance: {
                ...(template["provenance"] as Rec),
                recordId: p["recordId"],
                mergedSources: p["mergedSources"],
                derivedFrom: p["derivedFrom"],
              },
            };
            row["template_hash"] = templateHash(row["template"] as Rec);
            const { _ocFusionRecordIds: _ids, ...legacy } = reading;
            row["reading"] = legacy;
          }
          return target.unsafe(query.replace(fence, "template = excluded.template"), [
            JSON.stringify(rows),
          ]);
        }
        return target.unsafe(query, parameters);
      };
    },
  }) as Sql;
}

async function snapshot(sql: postgres.Sql, container: StartedTestContainer, pg18: boolean) {
  await sql`SELECT pg_stat_force_next_flush()`;
  await sql`SELECT pg_stat_clear_snapshot()`;
  const [io] = await sql.unsafe(
    `SELECT sum(${pg18 ? "write_bytes" : "writes*op_bytes"})::float8 AS writes FROM pg_stat_io WHERE object='relation'`,
  );
  const [table] =
    await sql`SELECT n_tup_upd::float8 AS updates,n_tup_hot_upd::float8 AS hot,autovacuum_count::float8 AS vacuums FROM pg_stat_user_tables WHERE relid='conditions.observation_latest'::regclass`;
  const [toast] =
    await sql`SELECT n_tup_ins::float8 AS inserts,n_tup_del::float8 AS deletes FROM pg_stat_all_tables WHERE relid=(SELECT reltoastrelid FROM pg_class WHERE oid='conditions.observation_latest'::regclass)`;
  const [wal] = await sql`SELECT pg_current_wal_insert_lsn()::text AS lsn`;
  const cg = await container.exec(["cat", "/sys/fs/cgroup/io.stat"]);
  if (cg.exitCode !== 0 || !cg.output.trim()) throw new Error("Owned cgroup counters unavailable");
  const devices = Object.fromEntries(
    cg.output
      .trim()
      .split("\n")
      .map((line) => {
        const [device, ...parts] = line.split(/\s+/);
        const bytes = parts.find((p) => p.startsWith("wbytes="));
        if (!bytes) throw new Error("Missing device write counter");
        return [device!, Number(bytes.slice(7))];
      }),
  );
  return { io: io!, table: table!, toast: toast!, lsn: wal!["lsn"] as string, devices };
}

it.runIf(process.env["OC_RUN_FUSED_WRITE_BENCHMARK"] === "1")(
  "compares durable mixed native and fused point writes without losing lineage",
  async () => {
    const profile = postgisProfile();
    const rows = Number(process.env["OC_FUSED_BENCH_NATIVE_ROWS"] ?? 24000);
    const sites = Number(process.env["OC_FUSED_BENCH_SITES"] ?? 600);
    const cycles = Number(process.env["OC_FUSED_BENCH_CYCLES"] ?? 12);
    const buffers = Number(process.env["OC_FUSED_BENCH_BUFFERS_MB"] ?? 64);
    if (
      ![rows, sites, cycles, buffers].every((n) => Number.isSafeInteger(n) && n > 0) ||
      sites % 2 !== 0
    )
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
      ])
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start();
    owned = container;
    const prefix = `postgres://bench:bench@${container.getHost()}:${container.getMappedPort(5432)}/`;
    const maintenance = postgres(prefix + "bench", { max: 1, onnotice: () => {} });
    admin = maintenance;
    const fixture = goldenFacilities().get(fuel)!;
    const station = fixture.features.find((f) => f["id"] === `oc:feature:${fuel}:3119`)!;
    const price = fixture.observations.find(
      (o) => (o["subject"] as Rec)["featureId"] === station["id"] && o["property"] === "fuel.price",
    )!;
    const credit = lookupDrafts(1, 0)[0]!["provenance"] as Rec;
    const features = Array.from({ length: sites }, (_, i) => ({
      ...station,
      id: `oc:feature:${fuel}:bench-${i}`,
      externalIds: [{ scheme: "provider", id: `bench-${i}`, authority: fuel }],
      provenance: { ...(station["provenance"] as Rec), recordId: `bench-${i}` },
      location: {
        ...(station["location"] as Rec),
        geometry: {
          type: "Point",
          coordinates: [-3.7 + (i % 100) * 0.01, 40.4 + Math.floor(i / 100) * 0.01],
        },
      },
    }));
    const states = (source: string, cycle: number) =>
      features.flatMap((feature, i) => {
        if (source === restricted && i % 2 === 0) return [];
        const time = new Date(
          start + cycle * 300_000 - (source === fuel ? 60_000 : 0),
        ).toISOString();
        const provider =
          cycle >= Math.ceil(cycles / 2) && i % 10 === 0 ? "Revised publisher" : undefined;
        const record: Rec = {
          ...price,
          subject: { ...(price["subject"] as Rec), featureId: feature.id },
          location: feature.location,
          result: {
            type: "money",
            amount: (1.649 + cycle * 0.01 + (source === restricted ? 0.05 : 0)).toFixed(3),
            currency: "EUR",
            per: "L",
          },
          phenomenonTime: { instant: time },
          freshness: { fetchedAt: time },
          provenance: {
            ...(price["provenance"] as Rec),
            sourceId: source,
            recordId: `bench-${i}`,
            attribution: { ...(credit["attribution"] as Rec), ...(provider ? { provider } : {}) },
            upstream: credit["upstream"],
          },
        };
        record["id"] = observationId(source, record as Parameters<typeof observationId>[1]);
        return [record];
      });
    const arms: Rec[] = [];
    for (const [index, arm] of ["reference", "candidate", "candidate", "reference"].entries()) {
      const name = `fusion_arm_${index}`;
      await maintenance.unsafe(`CREATE DATABASE ${name}`);
      const url = prefix + name;
      await runMigrations(url);
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      client = sql;
      await assertPostgisProfile(sql, profile, {
        fixture: `fused-page-writes/${arm}/${index}`,
        containerId: container.getId(),
      });
      await ensureObservationPartitions(sql, {
        classes: retentionClasses(registry),
        now: new Date(start),
      });
      await syncSources(
        sql,
        [fuel, restricted].map((id) => ({
          id,
          domain: "facilities",
          format: "minetur",
          product: "facilities",
          tier: "authoritative" as const,
          country: "ES",
          operator: "Publisher",
          license: "CC0-1.0",
          attribution: "Publisher",
          restricted: id === restricted,
          cadenceSec: 300,
          freshnessWindowSec: 900,
        })),
      );
      for (const source of [fuel, restricted])
        await polled(sql, source, new Date(start).toISOString());
      const ctx = {
        registry,
        instanceId: "fusion-benchmark.local",
        complete: false,
        now: new Date(start).toISOString(),
      };
      const measured = (tx: postgres.TransactionSql) => (arm === "reference" ? reference(tx) : tx);
      const seed = await sql.begin((tx) =>
        writeSnapshotIn(measured(tx), fuel, { features, observations: states(fuel, 0) }, ctx),
      );
      expect(seed.rejected).toEqual([]);
      const canonical = (
        await sql`SELECT canonical_feature_id FROM conditions.feature_canonical WHERE member_ids && ${features.map((f) => f.id)}::text[]`
      ).map((r) => r["canonical_feature_id"] as string);
      expect(canonical).toHaveLength(sites);
      const scopes = canonical.map((featureId) => ({ featureId }));
      const fuelPoll = async (cycle: number) => {
        const rejected: Rejection[] = [],
          now = new Date(start + cycle * 300_000).toISOString();
        return sql.begin(async (raw) => {
          const tx = measured(raw);
          await writeObservationsIn(tx, fuel, states(fuel, cycle), { ...ctx, now }, rejected);
          await writeObservationsIn(
            tx,
            restricted,
            states(restricted, cycle),
            { ...ctx, now },
            rejected,
          );
          const counts = await refreshFused(tx, registry, scopes, {
            instanceId: ctx.instanceId,
            now,
            freshSources: [fuel, restricted],
          });
          expect(rejected).toEqual([]);
          expect(counts.written).toBe(cycle === 0 ? sites : sites * 1.5);
          return counts;
        });
      };
      await fuelPoll(0);
      const primary = async (cycle: number, drafts = lookupDrafts(rows, cycle, { indices })) => {
        const rejected: Rejection[] = [];
        const count = await sql.begin((tx) =>
          writeObservationsIn(
            measured(tx),
            "nl-ndw-flow",
            drafts,
            { ...ctx, now: new Date(start + cycle * 300_000).toISOString() },
            rejected,
          ),
        );
        expect(rejected).toEqual([]);
        return count;
      };
      const initial = lookupDrafts(rows, 0, { indices });
      for (let i = 0; i < initial.length; i += 1000) await primary(0, initial.slice(i, i + 1000));
      await sql`ANALYZE conditions.observation_latest`;
      await sql`CHECKPOINT`;
      const [size] =
        await sql`SELECT pg_total_relation_size('conditions.observation_latest')::float8 AS bytes`;
      expect(Number(size!["bytes"])).toBeGreaterThan(buffers * 1024 * 1024);
      const settings =
        await sql`SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','fsync','full_page_writes','synchronous_commit','autovacuum','autovacuum_naptime','wal_compression') ORDER BY name`;
      for (const key of ["fsync", "full_page_writes", "synchronous_commit", "autovacuum"])
        expect(settings.find((r) => r["name"] === key)?.["setting"]).toBe("on");
      const before = await snapshot(sql, container, profile === "pg18");
      const latency: number[] = [],
        counts = { native: 0, history: 0, fused: 0 };
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const drafts = lookupDrafts(rows, cycle, { indices }),
          t = performance.now();
        const count = await primary(cycle, drafts),
          fused = await fuelPoll(cycle);
        counts.native += count.latest;
        counts.history += count.history;
        counts.fused += fused.written;
        latency.push(performance.now() - t);
        await sql`SELECT count(*) FROM conditions.observation_latest WHERE expires_at<now()`;
        await sql`SELECT pg_sleep(0.25)`;
      }
      await sql.unsafe("VACUUM (ANALYZE) conditions.observation_latest");
      await sql.unsafe("VACUUM (ANALYZE) conditions.observation");
      await sql`CHECKPOINT`;
      await sql`SELECT pg_sleep(1.1)`;
      const after = await snapshot(sql, container, profile === "pg18");
      const [wal] =
        await sql`SELECT pg_wal_lsn_diff(${after.lsn}::pg_lsn,${before.lsn}::pg_lsn)::float8 AS bytes`;
      const [records] =
        await sql`SELECT md5(string_agg(md5(conditions.observation_record(template,reading)::text),'' ORDER BY source_id,subject_key,property,qualifier_key)) AS digest FROM conditions.observation_latest`;
      const [history] =
        await sql`SELECT md5(string_agg(md5(to_jsonb(o)::text),'' ORDER BY series_id,phenomenon_start)) AS digest FROM conditions.observation o`;
      const result = {
        arm,
        rows,
        sites,
        cycles,
        size,
        settings,
        counts,
        latency_ms: latency,
        wal_bytes: wal!["bytes"],
        relation_bytes: Number(after.io["writes"]) - Number(before.io["writes"]),
        updates: Number(after.table["updates"]) - Number(before.table["updates"]),
        hot: Number(after.table["hot"]) - Number(before.table["hot"]),
        autovacuums: Number(after.table["vacuums"]) - Number(before.table["vacuums"]),
        toast_inserts: Number(after.toast["inserts"]) - Number(before.toast["inserts"]),
        toast_deletes: Number(after.toast["deletes"]) - Number(before.toast["deletes"]),
        cgroup_write_bytes: Object.fromEntries(
          Object.entries(after.devices).map(([d, n]) => [d, n - (before.devices[d] ?? 0)]),
        ),
        records: records!["digest"],
        history: history!["digest"],
      };
      arms.push(result);
      expect(result.records).toBe(arms[0]!["records"]);
      expect(result.history).toBe(arms[0]!["history"]);
      expect(result.counts).toEqual(arms[0]!["counts"]);
      console.info("FUSED_WRITE_ARM", JSON.stringify(result));
      await sql.end({ timeout: 5 });
      client = undefined;
      await maintenance.unsafe(`DROP DATABASE ${name}`);
    }
    const receipt = {
      profile,
      image: POSTGIS_IMAGES[profile],
      container: container.getId(),
      buffers_mb: buffers,
      arms,
    };
    const output = process.env["OC_FUSED_BENCH_RECEIPT"];
    if (output) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
    }
    console.info("FUSED_WRITE_BENCHMARK", JSON.stringify(receipt));
  },
  1_800_000,
);
