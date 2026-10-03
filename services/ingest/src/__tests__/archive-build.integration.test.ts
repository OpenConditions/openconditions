import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations, scanRecords } from "@openconditions/core/server";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveKeepNights,
  buildDailyArchive,
  pruneErasedArchives,
} from "../pipeline/archive-build.js";
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
  await sql`TRUNCATE conditions.situation, conditions.archive_erasure CASCADE`;
});

type Rec = Record<string, unknown>;

async function bufferOf(file: string): Promise<ArrayBuffer> {
  const buf = await readFile(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function readIds(file: string): Promise<string[]> {
  const rows = (await parquetReadObjects({ file: await bufferOf(file) })) as { id: string }[];
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

  it("removes an erased record from every earlier night's file", async () => {
    await writeSituations(sql, "de-autobahn", [situationDraft("kept"), situationDraft("erased")]);
    const dir = await mkdtemp(path.join(tmpdir(), "oc-archive-"));
    const erased = "oc:situation:de-autobahn:erased";
    try {
      await buildDailyArchive(sql, { now: () => new Date("2026-09-07T03:30:00Z"), outputDir: dir });
      const firstNight = path.join(dir, "archive-situation-2026-09-07.parquet");
      expect(await readIds(firstNight)).toEqual([
        "oc:situation:de-autobahn:erased",
        "oc:situation:de-autobahn:kept",
      ]);
      const before = (await parquetReadObjects({ file: await bufferOf(firstNight) })) as Rec[];

      await sql`
        UPDATE conditions.situation
           SET tombstone_reason = 'rights_revoked', tombstoned_at = '2026-09-07T09:00:00Z',
               record = record || jsonb_build_object('tombstone',
                 jsonb_build_object('reason', 'rights_revoked', 'at', '2026-09-07T09:00:00Z'))
         WHERE id = ${erased}`;
      await buildDailyArchive(sql, { now: () => new Date("2026-09-08T03:30:00Z"), outputDir: dir });

      expect(await readIds(firstNight)).toEqual(["oc:situation:de-autobahn:kept"]);
      expect(await readIds(path.join(dir, "archive-situation-2026-09-08.parquet"))).toEqual([
        "oc:situation:de-autobahn:kept",
      ]);
      // The rows that stay are as they were, geometry and metadata included.
      const after = (await parquetReadObjects({ file: await bufferOf(firstNight) })) as Rec[];
      expect(after).toEqual(before.filter((r) => r["id"] !== erased));
      const meta = parquetMetadata(await bufferOf(firstNight));
      expect(meta.key_value_metadata?.some((kv) => kv.key === "geo")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("moves the latest name along with the rewritten file it points at", async () => {
    await writeSituations(sql, "de-autobahn", [situationDraft("kept"), situationDraft("erased")]);
    const dir = await mkdtemp(path.join(tmpdir(), "oc-archive-"));
    try {
      await buildDailyArchive(sql, { now: () => new Date("2026-09-07T03:30:00Z"), outputDir: dir });
      await sql`
        INSERT INTO conditions.federation_tombstone
          (canonical_id, peer_instance_id, reason, tombstoned_at, expires_at)
        SELECT canonical_id, '', 'rights_revoked', '2026-09-07T09:00:00Z', '2026-10-07T09:00:00Z'
          FROM conditions.situation WHERE id = 'oc:situation:de-autobahn:erased'`;
      expect(await pruneErasedArchives(sql, dir, "2026-09-07T10:00:00Z")).toBe(1);
      const latest = path.join(dir, "archive-situation.parquet");
      const dated = path.join(dir, "archive-situation-2026-09-07.parquet");
      expect(await readIds(latest)).toEqual(["oc:situation:de-autobahn:kept"]);
      expect((await stat(latest)).ino).toBe((await stat(dated)).ino);
      expect(await pruneErasedArchives(sql, dir, "2026-09-07T10:00:00Z")).toBe(0);
    } finally {
      await sql`TRUNCATE conditions.federation_tombstone`;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("applies each erasure to the kept files once, not every night it stays in force", async () => {
    await writeSituations(sql, "de-autobahn", [
      situationDraft("kept"),
      situationDraft("erased"),
      situationDraft("later"),
    ]);
    const dir = await mkdtemp(path.join(tmpdir(), "oc-archive-"));
    const erase = (local: string, at: string) => sql`
      INSERT INTO conditions.federation_tombstone
        (canonical_id, peer_instance_id, reason, tombstoned_at, expires_at)
      SELECT canonical_id, '', 'rights_revoked', ${at}, '2026-10-07T09:00:00Z'
        FROM conditions.situation WHERE id = ${`oc:situation:de-autobahn:${local}`}`;
    try {
      await buildDailyArchive(sql, { now: () => new Date("2026-09-07T03:30:00Z"), outputDir: dir });
      const dated = path.join(dir, "archive-situation-2026-09-07.parquet");
      await erase("erased", "2026-09-07T09:00:00Z");
      expect(await pruneErasedArchives(sql, dir, "2026-09-07T10:00:00Z")).toBe(1);

      // A file the night's scan would choke on proves it is not read again.
      const good = await readFile(dated);
      await writeFile(dated, "not parquet");
      const failed = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await pruneErasedArchives(sql, dir, "2026-09-08T10:00:00Z")).toBe(0);
      expect(failed).not.toHaveBeenCalled();

      // A new erasure is scanned for, and stays pending while a file fails.
      await erase("later", "2026-09-08T11:00:00Z");
      expect(await pruneErasedArchives(sql, dir, "2026-09-08T12:00:00Z")).toBe(0);
      expect(failed).toHaveBeenCalled();
      failed.mockRestore();
      await writeFile(dated, good);
      expect(await pruneErasedArchives(sql, dir, "2026-09-09T10:00:00Z")).toBe(1);
      expect(await readIds(dated)).toEqual(["oc:situation:de-autobahn:kept"]);
    } finally {
      await sql`TRUNCATE conditions.federation_tombstone`;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps the newest nights only, and the latest names", async () => {
    await writeSituations(sql, "de-autobahn", [situationDraft("kept")]);
    const dir = await mkdtemp(path.join(tmpdir(), "oc-archive-"));
    try {
      for (const day of ["2026-09-06", "2026-09-07", "2026-09-08"]) {
        await buildDailyArchive(sql, {
          now: () => new Date(`${day}T03:30:00Z`),
          outputDir: dir,
          keepNights: 2,
        });
      }
      const names = (await readdir(dir)).sort();
      expect(names.filter((n) => n.startsWith("archive-situation"))).toEqual([
        "archive-situation-2026-09-07.parquet",
        "archive-situation-2026-09-08.parquet",
        "archive-situation.parquet",
      ]);
      expect(names.filter((n) => n.includes("2026-09-06"))).toEqual([]);

      await buildDailyArchive(sql, {
        now: () => new Date("2026-09-09T03:30:00Z"),
        outputDir: dir,
        keepNights: 0,
      });
      expect((await readdir(dir)).filter((n) => n.startsWith("archive-situation-"))).toHaveLength(
        3,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps 30 nights unless told otherwise", () => {
    expect(archiveKeepNights({})).toBe(30);
    expect(archiveKeepNights({ OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS: "7" })).toBe(7);
    expect(archiveKeepNights({ OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS: "0" })).toBe(0);
    expect(archiveKeepNights({ OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS: "soon" })).toBe(30);
  });

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
