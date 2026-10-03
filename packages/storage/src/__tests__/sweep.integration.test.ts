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
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
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
    expect(await state("oc:situation:nl-ndw-events:exp")).toEqual({
      tombstone_reason: "expired",
      revision: 2,
    });
    expect(await state("oc:situation:nl-ndw-events:ended")).toEqual({
      tombstone_reason: null,
      revision: 1,
    });
    const [revision] = await sql`SELECT change_kinds FROM conditions.situation_revision
      WHERE situation_id = 'oc:situation:nl-ndw-events:exp' AND revision = 2`;
    expect(revision).toEqual({ change_kinds: ["tombstoned"] });
  });

  it("tombstones the feed records of a source that stopped polling, not crowd or peer records", async () => {
    await polled("nl-ndw-events", "2026-10-01T09:00:00Z");
    await writeSnapshot(
      sql,
      "nl-ndw-events",
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
    expect(await state("oc:situation:nl-ndw-events:old")).toMatchObject({
      tombstone_reason: "expired",
    });
    expect(await state("oc:situation:test.local:c1")).toMatchObject({ tombstone_reason: null });
  });

  it("keeps the records of a source that is still polling", async () => {
    await polled("nl-ndw-events", "2026-10-01T11:30:00Z");
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("live")] },
      { ...write, complete: true },
    );
    expect(await sweep(LATER)).toEqual({
      expired: 0,
      orphaned: 0,
      purged: 0,
      dropped: 0,
      crowdExpired: 0,
    });
  });

  it("deletes on-demand rows at expiry, records and series alike", async () => {
    const onDemand = (draft: Record<string, unknown>) => ({
      ...draft,
      provenance: { ...(draft["provenance"] as object), accessMode: "on_demand" },
      freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" },
    });
    await polled("nl-ndw-events", LATER);
    await polled("nl-ndw-flow", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
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
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("gone")] },
      { ...write, complete: true },
    );
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [] },
      { ...write, now: LATER, complete: true },
    );
    expect(await sweep("2026-11-01T00:00:00Z", { maxAgeSec: 1e9 })).toMatchObject({ purged: 0 });
    expect(await sweep("2027-01-05T00:00:00Z", { maxAgeSec: 1e9 })).toMatchObject({ purged: 1 });
    const [{ revisions }] =
      await sql`SELECT count(*)::int AS revisions FROM conditions.situation_revision`;
    expect(revisions).toBe(0);
  });

  it("purges a record's graph bindings with it", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("gone")] },
      { ...write, complete: true },
    );
    await sql`INSERT INTO conditions.record_binding (record_class, record_id, effect_id, status,
        direction_mode, resolver_version, geom_hash, record_revision, bound_at)
      VALUES ('situation', 'oc:situation:nl-ndw-events:gone', '', 'exact', 'single', 'v', 'h', 1, now())`;
    await sql`INSERT INTO conditions.record_segment (record_class, record_id, effect_id, seq,
        segment_id, way_id, dir, start_fraction, end_fraction)
      VALUES ('situation', 'oc:situation:nl-ndw-events:gone', '', 0, '1:f', 1, 'f', 0, 1)`;
    await sql`UPDATE conditions.situation SET tombstoned_at = '2026-06-01T00:00:00Z',
      tombstone_reason = 'withdrawn'`;
    expect(await sweep(LATER)).toMatchObject({ purged: 1 });
    expect(await sql`SELECT 1 FROM conditions.record_binding`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM conditions.record_segment`).toHaveLength(0);
  });

  it("purges a record's crowd evidence and votes with it", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("voted")] },
      { ...write, complete: true },
    );
    const id = "oc:situation:nl-ndw-events:voted";
    await sql`INSERT INTO conditions.report_evidence
        (record_class, record_id, evidence_kind, actor_key_id, occurred_at)
      VALUES ('situation', ${id}, 'confirm', 'k', now())`;
    await sql`INSERT INTO conditions.sub_claim
        (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
      VALUES ('s1', 'situation', ${id}, 'confirm', 'k', 'sig', now())`;
    await sql`UPDATE conditions.situation SET tombstoned_at = '2026-06-01T00:00:00Z',
      tombstone_reason = 'withdrawn'`;
    expect(await sweep(LATER)).toMatchObject({ purged: 1 });
    expect(await sql`SELECT 1 FROM conditions.report_evidence`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM conditions.sub_claim`).toHaveLength(0);
  });

  it("waits for a poll of the source before purging or dropping its rows", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      {
        situations: [
          situationDraft("gone"),
          {
            ...situationDraft("od"),
            provenance: {
              ...(situationDraft("od")["provenance"] as object),
              accessMode: "on_demand",
            },
            freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" },
          },
        ],
      },
      { ...write, complete: true },
    );
    await sql`UPDATE conditions.situation SET tombstoned_at = '2026-06-01T00:00:00Z',
      tombstone_reason = 'withdrawn' WHERE id = 'oc:situation:nl-ndw-events:gone'`;
    const poll = await sql.reserve();
    await poll`SELECT pg_advisory_lock(hashtext('nl-ndw-events'))`;
    const swept = sweep(LATER);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [{ held }] = await sql`SELECT count(*)::int AS held FROM conditions.situation`;
    expect(held).toBe(2);
    await poll`SELECT pg_advisory_unlock(hashtext('nl-ndw-events'))`;
    poll.release();
    expect(await swept).toMatchObject({ purged: 1, dropped: 1 });
  });
});
