import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestPayload } from "@openconditions/ingest-framework";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runRawCommand } from "../ops/raw.js";
import { createRawArchive } from "../raw/archive.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

const HOUR = 3_600_000;
const NOW = new Date("2026-10-20T12:00:00Z");

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let dir: string;
let lines: string[];
const run = (...args: string[]) =>
  runRawCommand(sql, args, (l) => lines.push(l), { OPENCONDITIONS_RAW_DIR: dir }, NOW);

beforeAll(async () => {
  db = await createRestrictionDatabase();
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

  it("refuses an unknown hash or command", async () => {
    expect(await run("pin", "f".repeat(64))).toBe(1);
    expect(await run("pin", "not-a-hash")).toBe(2);
    expect(await run("replay")).toBe(2);
    expect(lines.at(-1)).toMatch(/^usage: raw pin/);
  });
});
