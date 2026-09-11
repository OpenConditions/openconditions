import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readObservations, scanObservations, type QueryRunner } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import type { RoadEvent } from "@openconditions/roads";
import { parquetReadObjects } from "hyparquet";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDailyArchive } from "../pipeline/archive-build.js";
import { atomicSwap } from "../pipeline/write-postgis.js";

function baseEvent(overrides: Partial<RoadEvent>): RoadEvent {
  return {
    id: "base",
    source: "arch-test",
    sourceFormat: "wzdx",
    domain: "roads",
    kind: "event",
    type: "roadworks",
    category: "planned",
    isPlanned: true,
    severity: "low",
    severitySource: "derived",
    headline: "Roadworks",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    status: "active",
    roads: [{ name: "A1" }],
    origin: { kind: "feed", attribution: { provider: "p", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-06-23T10:00:00Z",
    fetchedAt: "2026-06-23T10:00:00Z",
    isStale: false,
    ...overrides,
  };
}

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://oc:oc@${host}:${port}/conditions_test`;
  sql = postgres(url, { max: 3 });

  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.observations CASCADE`;
  await sql`TRUNCATE conditions.road_graph_state`;
});

function runner(client: postgres.Sql | postgres.TransactionSql): QueryRunner {
  return {
    execute: async <T>(q: string, p?: unknown[]) => (await client.unsafe(q, p as never[])) as T,
  };
}

describe("nightly static-archive build", () => {
  it("writes a GeoParquet of the published view, dropping share-alike records", async () => {
    await atomicSwap(sql, "arch-test", [
      baseEvent({
        id: "arch-perm",
        headline: "Permissive roadworks",
        origin: { kind: "feed", attribution: { provider: "ok-feed", license: "CC-BY-4.0" } },
      }),
      baseEvent({
        id: "arch-sa",
        headline: "Share-alike roadworks",
        geometry: { type: "Point", coordinates: [13.45, 52.55] },
        origin: { kind: "feed", attribution: { provider: "osm", license: "ODbL-1.0" } },
      }),
    ]);

    const dir = await mkdtemp(path.join(tmpdir(), "oc-archive-"));
    try {
      const result = await buildDailyArchive(sql, {
        now: () => new Date("2026-07-01T04:30:00Z"),
        outputDir: dir,
      });
      expect(result).not.toBeNull();
      expect(result!.path).toBe(path.join(dir, "archive-2026-07-01.parquet"));

      const buf = await readFile(result!.path);
      const rows = (await parquetReadObjects({
        file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      })) as { id: string }[];
      const ids = rows.map((r) => r.id);
      expect(ids).toContain("arch-perm");
      expect(ids).not.toContain("arch-sa");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("warns and does not throw when the output dir is unwritable", async () => {
    // Point the output dir at a path *under a regular file* so mkdir fails with
    // ENOTDIR — the job must log and return null, never throw.
    const filePath = path.join(await mkdtemp(path.join(tmpdir(), "oc-archive-")), "not-a-dir");
    await writeFile(filePath, "x");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await buildDailyArchive(sql, {
        now: () => new Date("2026-07-02T04:30:00Z"),
        outputDir: path.join(filePath, "sub"),
      });
      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await rm(filePath, { force: true });
    }
  }, 30_000);
});

describe("canonical observation and complete archive contract", () => {
  it("exports more than 2000 rows without deduping sources and preserves released crowd metadata", async () => {
    const now = new Date();
    const all = Array.from({ length: 2105 }, (_, i) =>
      baseEvent({
        id: `complete:${String(i).padStart(5, "0")}`,
        headline: `Event ${i}`,
      })
    );
    await atomicSwap(sql, "arch-test", all);
    await sql`
      UPDATE conditions.observations
      SET source = 'other-source', canonical_id = 'canonical:duplicate',
          source_uri = 'https://source.test/record', source_license = 'CC0-1.0'
      WHERE id = 'complete:00001'`;
    const identity = "REPORTER_IDENTITY_SENTINEL";
    await sql`
      UPDATE conditions.observations
      SET origin = ${sql.json({ kind: "crowd", attribution: { provider: "crowd", license: "CC0-1.0" }, reporter: { keyId: identity } })},
          privacy_class = 'crowd_pseudonym', evidence_state = 'corroborated',
          confidence_score = 0.7, canonical_id = 'canonical:crowd'
      WHERE id = 'complete:00002'`;
    await sql`
      UPDATE conditions.observations
      SET origin = ${sql.json({ kind: "crowd", attribution: { provider: "crowd", license: "CC0-1.0" } })}, privacy_class = 'unknown'
      WHERE id = 'complete:00003'`;
    const complete = await readObservations(runner(sql), {
      bbox: [-180, -90, 180, 90],
      requireComplete: true,
    });
    expect(complete).toHaveLength(2105);
    const display = await readObservations(runner(sql), {
      bbox: [-180, -90, 180, 90],
      dedupe: false,
    });
    expect(display).toHaveLength(2000);
    const dir = await mkdtemp(path.join(tmpdir(), "oc-complete-archive-"));
    try {
      const result = await buildDailyArchive(sql, { now: () => now, outputDir: dir });
      expect(result).not.toBeNull();
      const buffer = await readFile(result!.path);
      const rows = await parquetReadObjects({
        file: buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        ) as ArrayBuffer,
      });
      expect(rows).toHaveLength(2104);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2104);
      expect(rows.find((row) => row.id === "complete:00001")).toMatchObject({
        canonicalId: "canonical:duplicate",
        sourceUri: "https://source.test/record",
        sourceLicense: "CC0-1.0",
      });
      expect(rows.find((row) => row.id === "complete:00002")).toMatchObject({
        canonicalId: "canonical:crowd",
        privacyClass: "crowd_pseudonym",
        confidenceScore: 0.7,
      });
      expect(rows.some((row) => row.id === "complete:00003")).toBe(false);
      expect(JSON.stringify(rows)).not.toContain(identity);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("honors canonical filters and marks old binding generations obsolete", async () => {
    await atomicSwap(sql, "arch-test", [
      baseEvent({ id: "read:feed" }),
      baseEvent({ id: "read:denied" }),
      baseEvent({ id: "read:crowd" }),
    ]);
    await sql`UPDATE conditions.observations SET source = 'denied' WHERE id = 'read:denied'`;
    await sql`UPDATE conditions.observations SET origin = ${sql.json({ kind: "crowd", attribution: { provider: "crowd", license: "CC0-1.0" } })}, routing_eligible = false WHERE id = 'read:crowd'`;
    await sql`INSERT INTO conditions.road_graph_state (generation, regions, highway_classes, pbf_provenance, imported_at, activated_at)
      VALUES ('current', '[]', '[]', '{}', now(), now())`;
    await sql`INSERT INTO conditions.observation_binding (observation_id, status, resolver_version, geom_hash, bound_at, observation_revision, graph_generation)
      SELECT id, 'exact', 'resolver', 'geom', now(), content_hash, 'old' FROM conditions.observations WHERE id = 'read:feed'`;
    await sql`INSERT INTO conditions.observation_segment (observation_id, seq, segment_id, way_id, dir, start_fraction, end_fraction)
      VALUES ('read:feed', 0, '1:f', 1, 'f', 0, 1)`;
    const rows = await readObservations(runner(sql), {
      bbox: [-180, -90, 180, 90],
      kind: "event",
      routingEligibleOnly: true,
      excludedSourceIds: ["denied"],
      includeBindings: true,
      requireComplete: true,
    });
    expect(rows.map((row) => row.id)).toEqual(["read:feed"]);
    expect(rows[0]!.binding?.status).toBe("obsolete");
    expect(rows[0]!.segments).toBeUndefined();
    expect(rows[0]!.privacyClass).toBe("authoritative");
    expect(rows[0]!.canonicalId).toBeTruthy();
    expect(rows[0]!.sourceLicense).toBe("CC0-1.0");
    expect(
      await readObservations(runner(sql), { bbox: [-180, -90, 180, 90], kind: "measurement" })
    ).toEqual([]);
  });

  it("keeps one snapshot across keyset pages while another transaction changes later rows", async () => {
    await atomicSwap(sql, "arch-test", [
      baseEvent({ id: "scan:a", headline: "original a" }),
      baseEvent({ id: "scan:b", headline: "original b" }),
    ]);
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      const pages = scanObservations(runner(tx), { asOf: new Date().toISOString(), pageSize: 1 });
      const first = await pages.next();
      expect(first.value?.map((row) => row.id)).toEqual(["scan:a"]);
      await sql`UPDATE conditions.observations SET headline = 'new b' WHERE id = 'scan:b'`;
      const second = await pages.next();
      expect(second.value?.[0]).toMatchObject({ id: "scan:b", headline: "original b" });
      expect((await pages.next()).done).toBe(true);
    });
  });
});
