import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { type SweepOptions, sweepRecords } from "../sweep.js";
import { writeRecord } from "../write-record.js";
import { writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { FETCHED_AT, observationDraft, situationDraft } from "./drafts.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const T0 = "2026-10-01T10:00:05.000Z";
const LATER = "2026-10-01T12:00:00.000Z";
const write = { registry, instanceId: "test.local", now: T0 };
const sweep = (now: string, over: Partial<SweepOptions> = {}) =>
  sweepRecords(sql, { ...write, now, maxAgeSec: 3600, historyDays: 90, ...over });

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(T0),
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.observation_latest,
    conditions.source_status CASCADE`;
});

/** The source polled successfully at `at`. */
async function polled(source: string, at: string) {
  await sql`INSERT INTO conditions.source_status (source, last_success_at, freshness_window_sec)
    VALUES (${source}, ${at}, 900)`;
}

async function state(id: string) {
  const [row] = await sql`SELECT tombstone_reason, revision FROM conditions.situation
    WHERE id = ${id}`;
  return row;
}

describe("sweepRecords", () => {
  it("tombstones a record once its own expiry passes, and leaves an ended one its source still publishes", async () => {
    await polled("nl-ndw", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw",
      {
        situations: [
          situationDraft("exp", {
            freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T11:00:00Z" },
          }),
          situationDraft("ended", {
            validity: {
              status: "ended",
              start: "2026-10-01T08:00:00Z",
              end: "2026-10-01T09:00:00Z",
            },
          }),
        ],
      },
      { ...write, complete: true },
    );
    expect(await sweep(LATER)).toMatchObject({ expired: 1, orphaned: 0 });
    expect(await state("oc:situation:nl-ndw:exp")).toEqual({
      tombstone_reason: "expired",
      revision: 2,
    });
    expect(await state("oc:situation:nl-ndw:ended")).toEqual({
      tombstone_reason: null,
      revision: 1,
    });
    const [revision] = await sql`SELECT change_kinds FROM conditions.situation_revision
      WHERE situation_id = 'oc:situation:nl-ndw:exp' AND revision = 2`;
    expect(revision).toEqual({ change_kinds: ["tombstoned"] });
  });

  it("tombstones the feed records of a source that stopped polling, not crowd or peer records", async () => {
    await polled("nl-ndw", "2026-10-01T09:00:00Z");
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("old")] },
      { ...write, complete: true },
    );
    const crowd = situationDraft("c1", {
      id: "oc:situation:test.local:c1",
      provenance: {
        origin: "crowd",
        sourceId: "crowd",
        sourceFormat: "crowd",
        accessMode: "bulk",
        recordId: "c1",
        attribution: { provider: "OpenConditions contributors", license: "CC0-1.0" },
        privacy: { class: "crowd_pseudonym" },
      },
    });
    await writeRecord(sql, { draft: crowd }, write);
    expect(await sweep(LATER)).toMatchObject({ orphaned: 1 });
    expect(await state("oc:situation:nl-ndw:old")).toMatchObject({ tombstone_reason: "expired" });
    expect(await state("oc:situation:test.local:c1")).toMatchObject({ tombstone_reason: null });
  });

  it("keeps the records of a source that is still polling", async () => {
    await polled("nl-ndw", "2026-10-01T11:30:00Z");
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("live")] },
      { ...write, complete: true },
    );
    expect(await sweep(LATER)).toEqual({ expired: 0, orphaned: 0, purged: 0, dropped: 0 });
  });

  it("deletes on-demand rows at expiry, records and series alike", async () => {
    const onDemand = (draft: Record<string, unknown>) => ({
      ...draft,
      provenance: { ...(draft["provenance"] as object), accessMode: "on_demand" },
      freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" },
    });
    await polled("nl-ndw", LATER);
    await polled("nl-ndw-flow", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [onDemand(situationDraft("od"))] },
      { ...write, complete: true },
    );
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [
          onDemand(
            observationDraft(
              "traffic.speed",
              { type: "quantity", value: 50, unit: "km/h" },
              { at: "2026-10-01T10:00:00Z" },
            ),
          ),
        ],
      },
      { ...write, complete: true },
    );
    expect(await sweep(LATER)).toMatchObject({ dropped: 2, expired: 0 });
  });

  it("purges a record tombstoned longer ago than the history window, with its revisions", async () => {
    await polled("nl-ndw", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("gone")] },
      { ...write, complete: true },
    );
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [] },
      { ...write, now: LATER, complete: true },
    );
    expect(await sweep("2026-11-01T00:00:00Z", { maxAgeSec: 1e9 })).toMatchObject({ purged: 0 });
    expect(await sweep("2027-01-05T00:00:00Z", { maxAgeSec: 1e9 })).toMatchObject({ purged: 1 });
    const [{ revisions }] =
      await sql`SELECT count(*)::int AS revisions FROM conditions.situation_revision`;
    expect(revisions).toBe(0);
  });
});
