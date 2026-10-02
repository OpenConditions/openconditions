import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LookupFn } from "@openconditions/ingest-framework";
import { FEED_SOURCES } from "@openconditions/roads";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runRawCommand } from "../ops/raw.js";
import { replayRaw } from "../ops/raw-replay.js";
import type { DomainFeedSource } from "../pipeline/run.js";
import { runSource } from "../pipeline/run.js";
import { createRawArchive } from "../raw/archive.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

const NDW = readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../../../packages/roads/src/__tests__/fixtures/ndw/actueel_beeld.xml",
  ),
);
const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const ndw: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "nl-ndw")!,
  domain: "roads",
};
const FROM = new Date("2000-01-01T00:00:00Z");

/** How many situations the poll left live. */
async function live(): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.situation WHERE tombstoned_at IS NULL`;
  return n;
}

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let dir: string;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "oc-replay-"));
  await sql`TRUNCATE conditions.raw_payload, conditions.source_poll_attempt,
    conditions.situation CASCADE`;
  const result = await runSource(ndw, {
    sql,
    fetch: (async () => new Response(new Uint8Array(NDW))) as unknown as typeof fetch,
    now: () => new Date().toISOString(),
    lookup: fakeLookup,
    raw: createRawArchive(sql, { dir }),
  });
  expect(result.error).toBeUndefined();
  return () => rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe("raw replay", () => {
  it("re-parses an archived poll into exactly the situations it stored", async () => {
    const [poll] = (await replayRaw(sql, { feed: ndw, from: FROM, dir })).polls;
    expect(poll).toMatchObject({ unavailable: [], changed: [], created: [], gone: [] });
    expect(poll!.same).toBe(await live());
    expect(poll!.same).toBeGreaterThan(100);
  });

  it("names a situation the current parser reads differently from what was stored", async () => {
    const [{ id }] = await sql<{ id: string }[]>`
      SELECT id FROM conditions.situation ORDER BY id LIMIT 1`;
    await sql`UPDATE conditions.situation_revision
                 SET snapshot = jsonb_set(snapshot, '{contentHash}', to_jsonb(repeat('0', 64)))
               WHERE situation_id = ${id}`;
    const [poll] = (await replayRaw(sql, { feed: ndw, from: FROM, dir })).polls;
    expect(poll).toMatchObject({ changed: [id], created: [], gone: [], same: (await live()) - 1 });
  });

  it("names a stored situation the replay no longer produces, and one it produces anew", async () => {
    const [{ id }] = await sql<{ id: string }[]>`
      SELECT id FROM conditions.situation ORDER BY id LIMIT 1`;
    await sql`UPDATE conditions.situation_revision
                 SET snapshot = jsonb_set(snapshot, '{id}', '"oc:situation:nl-ndw:renamed"')
               WHERE situation_id = ${id}`;
    const [poll] = (await replayRaw(sql, { feed: ndw, from: FROM, dir })).polls;
    expect(poll).toMatchObject({ created: [id], gone: ["oc:situation:nl-ndw:renamed"] });
  });

  it("reports a poll whose payload was evicted instead of diffing a part of it", async () => {
    await sql`UPDATE conditions.raw_payload SET evicted_at = now()`;
    const [poll] = (await replayRaw(sql, { feed: ndw, from: FROM, dir })).polls;
    expect(poll!.unavailable).toHaveLength(1);
    expect(poll).toMatchObject({ same: 0, changed: [], created: [], gone: [] });
  });

  it("runs from the raw command and says what it found", async () => {
    const lines: string[] = [];
    const code = await runRawCommand(
      sql,
      ["replay", "nl-ndw", "--from", FROM.toISOString()],
      (l) => lines.push(l),
      { OPENCONDITIONS_RAW_DIR: dir },
    );
    expect(code).toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(
        new RegExp(`^poll \\d+ at \\S+: ${await live()} same, 0 changed, 0 new, 0 gone$`),
      ),
    ]);
    expect(
      await runRawCommand(sql, ["replay", "nope", "--from", FROM.toISOString()], () => {}),
    ).toBe(1);
    expect(await runRawCommand(sql, ["replay", "nl-ndw"], () => {})).toBe(2);
  });
});
