import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations, scanRecords } from "@openconditions/core/server";
import { parquetReadObjects } from "hyparquet";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDailyArchive } from "../pipeline/archive-build.js";
import { situationDraft, writeSituations } from "./helpers/situations.js";

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
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation CASCADE`;
});

async function readIds(file: string): Promise<string[]> {
  const buf = await readFile(file);
  const rows = (await parquetReadObjects({
    file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  })) as { id: string }[];
  return rows.map((r) => r.id);
}

const shareAlike = {
  origin: "feed",
  sourceId: "de-autobahn",
  sourceFormat: "autobahn",
  accessMode: "bulk",
  recordId: "sa",
  attribution: { provider: "OpenStreetMap", license: "ODbL-1.0" },
  privacy: { class: "authoritative" },
};

describe("nightly static archive", () => {
  it("writes one GeoParquet file per record class of the published view, and names each latest", async () => {
    await writeSituations(sql, "de-autobahn", [
      situationDraft("open"),
      situationDraft("sa", { provenance: shareAlike }),
    ]);
    await writeSituations(sql, "de-gone", [situationDraft("gone", {}, "de-gone")]);
    await writeSituations(sql, "de-gone", [], "2026-09-06T11:00:00.000Z");

    const dir = await mkdtemp(path.join(tmpdir(), "oc-archive-"));
    try {
      const result = await buildDailyArchive(sql, {
        now: () => new Date("2026-09-07T03:30:00Z"),
        outputDir: dir,
      });
      expect(result).not.toBeNull();
      for (const cls of ["situation", "feature", "offer", "observation"] as const) {
        expect(result![cls].path).toBe(path.join(dir, `archive-${cls}-2026-09-07.parquet`));
        const latest = path.join(dir, `archive-${cls}.parquet`);
        expect((await stat(latest)).ino).toBe((await stat(result![cls].path)).ino);
      }
      // Share-alike and withdrawn records stay out of a permissive mirror.
      expect(await readIds(result!.situation.path)).toEqual(["oc:situation:de-autobahn:open"]);
      expect(await readIds(result!.feature.path)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("moves each latest name to the newest build", async () => {
    await writeSituations(sql, "de-autobahn", [situationDraft("first")]);
    const dir = await mkdtemp(path.join(tmpdir(), "oc-archive-"));
    try {
      await buildDailyArchive(sql, { now: () => new Date("2026-09-07T03:30:00Z"), outputDir: dir });
      await writeSituations(sql, "de-autobahn", [situationDraft("second")], "2026-09-07T10:00:00Z");
      await buildDailyArchive(sql, { now: () => new Date("2026-09-08T03:30:00Z"), outputDir: dir });
      expect(await readIds(path.join(dir, "archive-situation.parquet"))).toEqual([
        "oc:situation:de-autobahn:second",
      ]);
      expect(await readIds(path.join(dir, "archive-situation-2026-09-07.parquet"))).toEqual([
        "oc:situation:de-autobahn:first",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("warns and does not throw when the output dir is unwritable", async () => {
    // Point the output dir at a path *under a regular file* so mkdir fails with
    // ENOTDIR — the job must log and return null, never throw.
    const filePath = path.join(await mkdtemp(path.join(tmpdir(), "oc-archive-")), "not-a-dir");
    await writeFile(filePath, "x");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await buildDailyArchive(sql, {
        now: () => new Date("2026-09-07T03:30:00Z"),
        outputDir: path.join(filePath, "sub"),
      });
      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await rm(filePath, { force: true });
    }
  }, 30_000);

  it("reads one snapshot across keyset pages while another transaction changes later records", async () => {
    await writeSituations(sql, "de-autobahn", [situationDraft("a"), situationDraft("b")]);
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      const pages = scanRecords(tx, "situation", { pageSize: 1 });
      const idsOf = (page: Record<string, unknown>[] | undefined) => page?.map((r) => r["id"]);
      expect(idsOf((await pages.next()).value ?? undefined)).toEqual([
        "oc:situation:de-autobahn:a",
      ]);
      await writeSituations(sql, "de-autobahn", [situationDraft("a")], "2026-09-06T12:00:00Z");
      expect(idsOf((await pages.next()).value ?? undefined)).toEqual([
        "oc:situation:de-autobahn:b",
      ]);
      expect((await pages.next()).done).toBe(true);
    });
  }, 30_000);
});
