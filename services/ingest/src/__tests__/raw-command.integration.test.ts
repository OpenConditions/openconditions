import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestPayload } from "@openconditions/ingest-framework";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimIngestWork } from "../claims.js";
import { runRawCommand } from "../ops/raw.js";
import { createRawArchive } from "../raw/archive.js";

const HOUR = 3_600_000;
const NOW = new Date("2026-10-20T12:00:00Z");

let db: TestDatabase;
let sql: postgres.Sql;
let dir: string;
let lines: string[];
const run = (...args: string[]) =>
  runRawCommand(sql, args, (l) => lines.push(l), { OPENCONDITIONS_RAW_DIR: dir }, NOW);

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "oc-raw-"));
  lines = [];
  await sql`TRUNCATE conditions.raw_payload`;
  return () => rmSync(dir, { recursive: true, force: true });
});

/** Archives `count` payloads of a hot-only source, one an hour back from NOW. */
async function archive(count: number): Promise<string[]> {
  const raw = createRawArchive(sql, { dir });
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = Buffer.from(`payload ${i}`);
    const digest = digestPayload("https://drivebc.example/events", body);
    await raw.capture(
      {
        sourceId: "ca-bc-drivebc-events",
        fetchId: i + 1,
        fetchedAt: new Date(NOW.getTime() - i * HOUR),
        tier: "hot",
        url: digest.url,
      },
      body,
      digest,
    );
    hashes.push(digest.sha256);
  }
  return hashes;
}

describe("raw command", () => {
  it("pins a payload as a fixture so eviction keeps it, and unpins it", async () => {
    const hashes = await archive(60);
    const oldest = hashes.at(-1)!;
    expect(await run("pin", oldest, "--fixture", "drivebc-closure")).toBe(0);
    expect(lines).toEqual([`pinned ${oldest} of ca-bc-drivebc-events`]);
    expect(await run("gc", "--dry-run")).toBe(0);
    expect(lines).toContain("would evict 10 payload(s); cap rung 0");
    const [row] =
      await sql`SELECT pinned_reason FROM conditions.raw_payload WHERE hash = ${oldest}`;
    expect(row).toEqual({ pinned_reason: "fixture:drivebc-closure" });
    expect(await run("unpin", oldest)).toBe(0);
    lines = [];
    await run("gc", "--dry-run");
    expect(lines[0]).toBe("would evict 11 payload(s); cap rung 0");
  });

  it("evicts on gc and says what it did", async () => {
    await archive(60);
    expect(await run("gc")).toBe(0);
    expect(lines).toEqual([
      "evicted 11 payload(s); cap rung 0",
      expect.stringMatching(/^ {2}ca-bc-drivebc-events: 11 payload\(s\), \d+ bytes$/),
      "purged 0 index row(s) of long-evicted payloads",
    ]);
  });

  it("on gc, evicts only what lies in its own archive directory", async () => {
    await archive(60);
    const elsewhere = { OPENCONDITIONS_RAW_DIR: path.join(dir, "elsewhere") };
    expect(await runRawCommand(sql, ["gc"], (l) => lines.push(l), elsewhere, NOW)).toBe(0);
    expect(lines[0]).toBe("evicted 0 payload(s); cap rung 0");
  });

  describe("forget-missing, once a feeds process and its volume are gone", () => {
    let gone: string;
    const claims: postgres.Sql[] = [];
    beforeEach(() => {
      gone = mkdtempSync(path.join(tmpdir(), "oc-raw-gone-"));
      return async () => {
        rmSync(gone, { recursive: true, force: true });
        for (const c of claims.splice(0)) await c.end();
      };
    });

    /** Archives `count` payloads of `sourceId` into `into`, one an hour back from `hoursAgo`. */
    async function archiveInto(into: string, sourceId: string, count: number, hoursAgo = 0) {
      const raw = createRawArchive(sql, { dir: into });
      for (let i = 0; i < count; i++) {
        const body = Buffer.from(`${sourceId} ${into} ${i}`);
        const digest = digestPayload(`https://${sourceId}.example/feed`, body);
        await raw.capture(
          {
            sourceId,
            fetchId: i + 1,
            fetchedAt: new Date(NOW.getTime() - (hoursAgo + i) * HOUR),
            tier: "observation",
            url: digest.url,
          },
          body,
          digest,
        );
      }
    }

    /** nl-ndw-flow archived by a feeds process, now retired with its volume, then by the primary. */
    async function retired() {
      await archiveInto(gone, "nl-ndw-flow", 4, 10);
      rmSync(gone, { recursive: true, force: true });
      await archiveInto(dir, "nl-ndw-flow", 5);
      await archiveInto(dir, "nl-ndw-events", 2);
    }

    async function evicted() {
      return sql<{ source_id: string; n: number }[]>`
        SELECT source_id, count(*)::int AS n FROM conditions.raw_payload
         WHERE evicted_at IS NOT NULL GROUP BY source_id ORDER BY source_id`;
    }

    /** Another ingest process's claims session. */
    async function claimed(role: "primary" | "feeds", feed: string) {
      const c = postgres(db.url, { max: 1 });
      claims.push(c);
      await claimIngestWork(c, { role, feeds: [{ id: feed }] as never });
    }

    it("counts, on a dry run, the payloads whose blob no directory here holds", async () => {
      await retired();
      expect(await run("forget-missing")).toBe(0);
      expect(lines).toEqual([
        "would forget 4 payload(s) whose blob is not in this archive",
        "  nl-ndw-flow: 4",
        "run with --apply to mark them evicted",
      ]);
      expect(await evicted()).toEqual([]);
    });

    it("marks them evicted with --apply, leaving every payload it holds", async () => {
      await retired();
      expect(await run("forget-missing", "--apply")).toBe(0);
      expect(lines[0]).toBe("forgot 4 payload(s) whose blob is not in this archive");
      expect(await evicted()).toEqual([{ source_id: "nl-ndw-flow", n: 4 }]);
      lines = [];
      await run("forget-missing");
      expect(lines[0]).toBe("would forget 0 payload(s) whose blob is not in this archive");
    });

    it("forgets only the feeds it is given", async () => {
      await retired();
      await archiveInto(gone, "nl-ndw-charging", 2);
      rmSync(gone, { recursive: true, force: true });
      expect(await run("forget-missing", "nl-ndw-charging", "--apply")).toBe(0);
      expect(await evicted()).toEqual([{ source_id: "nl-ndw-charging", n: 2 }]);
    });

    it("leaves a feed another live ingest process polls", async () => {
      await retired();
      await claimed("feeds", "nl-ndw-flow");
      expect(await run("forget-missing", "--apply")).toBe(0);
      expect(lines).toContain(
        "  nl-ndw-flow: left, another ingest process polls it (its blobs lie in that one's archive)",
      );
      expect(await evicted()).toEqual([]);
    });

    it("forgets for a feed the primary polls", async () => {
      await retired();
      await claimed("primary", "nl-ndw-flow");
      expect(await run("forget-missing", "--apply")).toBe(0);
      expect(await evicted()).toEqual([{ source_id: "nl-ndw-flow", n: 4 }]);
    });

    it("refuses to run in a feeds process, whose archive is not the primary's", async () => {
      await retired();
      const feeds = { OPENCONDITIONS_RAW_DIR: dir, OPENCONDITIONS_INGEST_ROLE: "feeds" };
      expect(
        await runRawCommand(sql, ["forget-missing", "--apply"], (l) => lines.push(l), feeds, NOW),
      ).toBe(2);
      expect(lines[0]).toMatch(/run forget-missing in the primary/);
      expect(await evicted()).toEqual([]);
    });
  });

  it("refuses an unknown hash or command", async () => {
    expect(await run("pin", "f".repeat(64))).toBe(1);
    expect(await run("pin", "not-a-hash")).toBe(2);
    expect(await run("replay")).toBe(2);
    expect(lines.at(-1)).toMatch(/^usage: raw pin/);
  });
});
