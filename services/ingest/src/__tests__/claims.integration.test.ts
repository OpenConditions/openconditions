import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimIngestWork } from "../claims.js";

let db: TestDatabase;
const open: postgres.Sql[] = [];

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 1 } });
});

afterAll(async () => {
  for (const sql of open) await sql.end();
  await db?.close();
}, 30_000);

/** One ingest process's claims connection. */
function ingestProcess(): postgres.Sql {
  const sql = postgres(db.url, { max: 1, idle_timeout: 0, max_lifetime: null });
  open.push(sql);
  return sql;
}

const feeds = (...ids: string[]) => ids.map((id) => ({ id }) as never);

describe("claimIngestWork", () => {
  it("lets processes that poll different feeds run side by side", async () => {
    const primary = ingestProcess();
    const heavy = ingestProcess();
    await claimIngestWork(primary, { role: "primary", feeds: feeds("a-events", "b-events") });
    await claimIngestWork(heavy, { role: "feeds", feeds: feeds("nl-ndw-flow") });
    await primary.end();
    await heavy.end();
  });

  it("fails a process that would poll a feed another process polls, naming it", async () => {
    const primary = ingestProcess();
    await claimIngestWork(primary, { role: "primary", feeds: feeds("a-events", "nl-ndw-flow") });
    await expect(
      claimIngestWork(ingestProcess(), {
        role: "feeds",
        feeds: feeds("nl-ndw-charging", "nl-ndw-flow"),
      }),
    ).rejects.toThrow(/another ingest process polls nl-ndw-flow:/);
    await primary.end();
  });

  it("fails a second primary", async () => {
    const first = ingestProcess();
    await claimIngestWork(first, { role: "primary", feeds: [] });
    await expect(claimIngestWork(ingestProcess(), { role: "primary", feeds: [] })).rejects.toThrow(
      /another primary ingest process/,
    );
    await first.end();
  });

  it("releases the claims when the process's connection ends", async () => {
    const first = ingestProcess();
    await claimIngestWork(first, { role: "primary", feeds: feeds("nl-ndw-flow") });
    await first.end();
    await claimIngestWork(ingestProcess(), { role: "primary", feeds: feeds("nl-ndw-flow") });
  });
});
