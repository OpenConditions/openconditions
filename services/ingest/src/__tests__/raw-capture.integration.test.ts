import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import type { LookupFn } from "@openconditions/ingest-framework";
import { FEED_SOURCES } from "@openconditions/roads";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainFeedSource } from "../pipeline/run.js";
import { runSource } from "../pipeline/run.js";
import { clearSiteTableCache } from "../pipeline/site-table.js";
import { createRawArchive, type RawArchive } from "../raw/archive.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures",
);
const NDW = readFileSync(path.join(FIXTURES, "ndw/actueel_beeld.xml"));
const DRIVEBC = readFileSync(path.join(FIXTURES, "drivebc/events.json"));
const FLOW = readFileSync(path.join(FIXTURES, "ndw-flow/trafficspeed.xml"));
const SITES = readFileSync(path.join(FIXTURES, "ndw-flow/measurement_site_table.xml"));
const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

const feed = (id: string, over: Partial<DomainFeedSource> = {}): DomainFeedSource => ({
  ...FEED_SOURCES.find((f) => f.id === id)!,
  domain: "roads",
  ...over,
});
const affirmed = {
  sourceRedistribution: true,
  derivedRedistribution: true,
  commercialUse: true,
  attributionRequired: false,
  retention: true,
};

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let dir: string;
let raw: RawArchive;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "oc-raw-"));
  raw = createRawArchive(sql, { dir });
  clearSiteTableCache();
  await sql`TRUNCATE conditions.raw_payload, conditions.source_poll_attempt`;
  return () => rmSync(dir, { recursive: true, force: true });
});

const poll = (src: DomainFeedSource, serve: (url: string) => Buffer, archive = raw) =>
  runSource(src, {
    sql,
    fetch: (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      return new Response(new Uint8Array(serve(href)));
    }) as typeof fetch,
    now: () => new Date().toISOString(),
    lookup: fakeLookup,
    raw: archive,
  });

async function payloads() {
  return sql<
    { tier: string; seen_count: number; fetch_id: string; storage_key: string; bytes_raw: string }[]
  >`
    SELECT tier, seen_count, fetch_id, storage_key, bytes_raw FROM conditions.raw_payload
    ORDER BY tier`;
}

describe("raw payload capture", () => {
  it("archives each distinct response once, under the poll that first fetched it", async () => {
    const ndw = feed("nl-ndw");
    expect((await poll(ndw, () => NDW)).error).toBeUndefined();
    expect((await poll(ndw, () => NDW)).error).toBeUndefined();
    const attempts = await sql<{ id: string; finished_at: Date | null; outcome: string }[]>`
      SELECT id, finished_at, outcome FROM conditions.source_poll_attempt ORDER BY id`;
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.finished_at !== null && a.outcome !== "running")).toBe(true);
    const [row] = await payloads();
    expect(row).toMatchObject({
      tier: "situation",
      seen_count: 2,
      fetch_id: attempts[0]!.id,
      bytes_raw: String(NDW.length),
    });
    expect(zstdDecompressSync(readFileSync(path.join(dir, row!.storage_key)))).toEqual(NDW);
  }, 60_000);

  it("keeps only the hot window of a source whose terms do not affirm retention", async () => {
    await poll(feed("ca-bc-drivebc"), () => DRIVEBC);
    expect((await payloads()).map((p) => p.tier)).toEqual(["hot"]);
  });

  it("keeps nothing of a source whose terms forbid retention", async () => {
    const forbidden = feed("nl-ndw", { rights: { ...affirmed, retention: false } });
    expect((await poll(forbidden, () => NDW)).error).toBeUndefined();
    expect(await payloads()).toEqual([]);
  });

  it("archives a streamed flow document and its site table as a reference payload", async () => {
    const flow = feed("nl-ndw-flow", { rights: affirmed });
    // Both are published gzipped; the archive holds the decoded document.
    const result = await poll(flow, (url) => gzipSync(url.includes("measurement") ? SITES : FLOW));
    expect(result.error).toBeUndefined();
    const rows = await payloads();
    expect(rows.map((p) => [p.tier, p.bytes_raw])).toEqual([
      ["observation", String(FLOW.length)],
      ["reference", String(SITES.length)],
    ]);
  });

  it("keeps nothing of a stream that breaks off mid-download", async () => {
    const flow = feed("nl-ndw-flow", { rights: affirmed });
    const half = gzipSync(FLOW).subarray(0, 200);
    const result = await runSource(flow, {
      sql,
      fetch: (async (url: string | URL | Request) => {
        const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (href.includes("measurement")) return new Response(new Uint8Array(gzipSync(SITES)));
        // Not a socket error, so the stream is not retried: one broken download.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(half));
            controller.error(new Error("upstream reset the stream"));
          },
        });
        return new Response(body);
      }) as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
      raw,
    });
    expect(result.error).toBeDefined();
    expect((await payloads()).map((p) => p.tier)).toEqual(["reference"]);
    const leftovers = readdirSync(path.join(dir, "nl-ndw-flow")).filter((f) =>
      f.startsWith(".tmp-"),
    );
    expect(leftovers).toEqual([]);
    const attempts = await sql<{ outcome: string; finished_at: Date | null }[]>`
      SELECT outcome, finished_at FROM conditions.source_poll_attempt`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("failed");
    expect(attempts[0]!.finished_at).not.toBeNull();
  });

  it("closes the attempt as failed when a poll throws", async () => {
    // The database drops the poll's read of its previous row count, which nothing in the poll catches.
    const failing = new Proxy(sql, {
      apply(target, self, args) {
        const strings = args[0] as readonly string[] | undefined;
        if (Array.isArray(strings) && strings.join("").includes("last_row_count FROM")) {
          return Promise.reject(new Error("connection terminated"));
        }
        return Reflect.apply(target, self, args);
      },
    });
    await expect(
      runSource(feed("ca-bc-drivebc"), {
        sql: failing,
        fetch: (async () => new Response(new Uint8Array(DRIVEBC))) as typeof fetch,
        now: () => new Date().toISOString(),
        lookup: fakeLookup,
        raw,
      }),
    ).rejects.toThrow("connection terminated");
    const attempts = await sql<{ outcome: string; finished_at: Date | null; error: string }[]>`
      SELECT outcome, finished_at, error FROM conditions.source_poll_attempt`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "failed", error: "connection terminated" });
    expect(attempts[0]!.finished_at).not.toBeNull();
  });

  it("never fails a poll when archiving fails", async () => {
    const broken = createRawArchive(sql, {
      dir,
      sink: {
        begin: async () => {
          throw new Error("disk full");
        },
      },
    });
    expect((await poll(feed("nl-ndw"), () => NDW, broken)).error).toBeUndefined();
    expect(await payloads()).toEqual([]);
  });
});
