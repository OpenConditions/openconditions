import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations } from "@openconditions/core/server";
import type { RoadEvent } from "@openconditions/roads";
import { parquetReadObjects } from "hyparquet";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
