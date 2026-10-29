import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneRevisions } from "../revision-retention.js";
import { writeSnapshot } from "../write-records.js";
import { situationDraft } from "./drafts.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

const write = (now: string, headline: string) =>
  writeSnapshot(
    sql,
    "nl-ndw-events",
    {
      situations: [
        situationDraft("a", {
          headline: [{ lang: "nl", text: headline }],
          freshness: { fetchedAt: now },
        }),
      ],
    },
    { registry, instanceId: "test.local", now, complete: true },
  );

const revisions = async () =>
  (
    await sql<{ revision: number }[]>`
      SELECT revision FROM conditions.situation_revision ORDER BY revision`
  ).map((r) => r.revision);

describe("pruneRevisions", () => {
  it("deletes the revisions past the history window and keeps each record's latest", async () => {
    await write("2026-10-01T10:00:00.000Z", "Ongeval");
    await write("2026-10-02T10:00:00.000Z", "Ongeval, rijstrook dicht");
    await write("2026-10-03T10:00:00.000Z", "Ongeval, weg dicht");
    expect(await revisions()).toEqual([1, 2, 3]);

    const at = (now: string) => pruneRevisions(sql, { now, historyDays: 7 });
    expect(await at("2026-10-08T09:00:00.000Z")).toBe(0);
    expect(await at("2026-10-08T12:00:00.000Z")).toBe(1);
    expect(await revisions()).toEqual([2, 3]);
    // Long after the last change, the revision the record stands at stays.
    expect(await at("2027-01-01T00:00:00.000Z")).toBe(1);
    expect(await revisions()).toEqual([3]);

    await write("2027-01-01T00:00:00.000Z", "Opgeheven");
    expect(await revisions()).toEqual([3, 4]);
  });
});
