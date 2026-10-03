import type { FeedSource } from "@openconditions/roads";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { publishSituations, UnlocatableRetainedError, writeModel } from "../pipeline/publish.js";
import { openPollAttempt } from "../pipeline/source-status.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { registry, situationDraft, writeSituations } from "./helpers/situations.js";

type Rec = Record<string, unknown>;

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

const src = { id: "nl-ndw", freshnessWindowSec: 900 } as unknown as FeedSource;
const NOW = "2026-09-06T10:05:00.000Z";

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.binding_queue, conditions.source_status,
    conditions.source_poll_attempt CASCADE`;
});

const effect = (id: string, kind: string, fields: Rec = {}): Rec => ({
  id,
  kind,
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  ...fields,
});

/** An accident split from DATEX situation G1, with the closure record CLO1 folded into it. */
const accident = (effects: Rec[]) =>
  situationDraft(
    "ACC1",
    {
      kind: "incident",
      type: "accident",
      subtype: undefined,
      groupId: "G1",
      effects,
      details: { kind: "incident", v: 1 },
    },
    "nl-ndw",
  );

async function publish(situations: Rec[], unlocatable: string[], unlocatableRecords: string[]) {
  const id = await openPollAttempt(sql, src.id, NOW);
  return publishSituations(sql, src, {
    situations,
    unlocatable,
    unlocatableRecords,
    rejected: 0,
    poll: { at: NOW, id },
    durationMs: 1,
    now: NOW,
    // The instance the seeded rows were written as: another's would be taken over.
    model: writeModel({ registry, instanceId: "test.local" }),
  });
}

describe("publishSituations unlocatable guard", () => {
  it("refuses to strip a split situation of the effects of a record it could not place", async () => {
    await writeSituations(sql, "nl-ndw", [
      accident([effect("CLO1/closure", "closure", { scope: "road" })]),
    ]);
    // CLO1 lost its location: it names its own id and its group's, neither of
    // which is the stored situation that carries its closure.
    await expect(
      publish([accident([])], ["oc:situation:nl-ndw:CLO1", "oc:situation:nl-ndw:G1"], ["CLO1"]),
    ).rejects.toBeInstanceOf(UnlocatableRetainedError);
    const [row] = await sql<{ record: Rec }[]>`
      SELECT record FROM conditions.situation WHERE id = 'oc:situation:nl-ndw:ACC1'`;
    expect((row!.record["effects"] as Rec[]).map((e) => e["id"])).toEqual(["CLO1/closure"]);
  });

  it("publishes when the record it could not place carried nothing stored", async () => {
    await writeSituations(sql, "nl-ndw", [accident([])]);
    const summary = await publish([accident([])], ["oc:situation:nl-ndw:NEW1"], ["NEW1"]);
    expect(summary.counts.situation.unchanged).toBe(1);
  });
});
