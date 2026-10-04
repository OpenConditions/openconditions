import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type FederationReconcileOptions, reconcileFederation } from "../federation-reconcile.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { type SourceEntry, syncSources } from "../sources.js";
import { writeRecord } from "../write-record.js";
import { tombstoneRecords } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { featureDraft, observationDraft, offerDraft, situationDraft } from "./drafts.js";

type Rec = Record<string, unknown>;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const T1 = "2026-10-01T10:00:05.000Z";
const T2 = "2026-10-01T10:05:05.000Z";
const ctx = (now = T1) => ({ registry, instanceId: "test.local", now });

const EVENTS = "nl-ndw-events";
const FLOW = "nl-ndw-flow";
const PARKING = "de-parking";
const situationId = (local: string) => `oc:situation:${EVENTS}:${local}`;
const offerId = (local: string) => `oc:offer:${PARKING}:${local}`;

const source = (id: string, restricted: boolean): SourceEntry => ({
  id,
  domain: id === PARKING ? "parking" : "roads",
  format: "datex2",
  product: id === FLOW ? "flow" : "events",
  tier: "authoritative",
  country: id === PARKING ? "DE" : "NL",
  operator: id,
  license: "CC0-1.0",
  attribution: id,
  restricted,
  cadenceSec: 60,
  freshnessWindowSec: 600,
});

/** Syncs the catalogue with the given sources restricted, as a boot does. */
async function syncRestricted(...restricted: string[]) {
  await syncSources(
    sql,
    [EVENTS, FLOW, PARKING].map((id) => source(id, restricted.includes(id))),
  );
}

async function basisOf(id: string): Promise<boolean | null> {
  const [row] = await sql<{ federation_restricted: boolean | null }[]>`
    SELECT federation_restricted FROM conditions.source WHERE id = ${id}`;
  return row!.federation_restricted;
}

async function pendingOf(id: string): Promise<boolean> {
  const [row] = await sql<{ federation_pending: boolean }[]>`
    SELECT federation_pending FROM conditions.source WHERE id = ${id}`;
  return row!.federation_pending;
}

/** A reconcile stopped once a page of `source` has journalled more than `after` entries. */
async function interrupted(source: string, after: number) {
  const stop = new AbortController();
  return reconcile({
    batchSize: 2,
    signal: stop.signal,
    onBatch: (p) => {
      if (p.source === source && p.journalled > after) stop.abort();
    },
  });
}

async function write(draft: Rec, now = T1) {
  const result = await writeRecord(sql, { draft }, ctx(now));
  if (result.status === "rejected") throw new Error(JSON.stringify(result.issues));
}

async function tombstone(cls: "situation" | "feature" | "offer", id: string, reason: string) {
  await sql.begin((tx) => tombstoneRecords(tx, cls, [id], reason, ctx(T2)));
}

interface Entry {
  operation: string;
  record_class: string;
  record_id: string;
  canonical_id: string | null;
  kind: string;
  domain: string;
  property: string | null;
  priority: boolean;
  snapshot: Rec | null;
  tombstone_reason: string | null;
}

/** The journal as a subscriber reads it, without the cursor columns. */
async function journal(recordId?: string): Promise<Entry[]> {
  return sql<Entry[]>`
    SELECT operation, record_class, record_id, canonical_id, kind, domain, property, priority,
           snapshot, tombstone_reason
      FROM conditions.federation_outbox
     WHERE ${recordId === undefined ? sql`true` : sql`record_id = ${recordId}`}
     ORDER BY seq`;
}

const operations = async (recordId: string) =>
  (await journal(recordId)).map((e) => [e.operation, e.tombstone_reason]);

const reconcile = (opts: FederationReconcileOptions = {}) => reconcileFederation(sql, opts);

const speedReading = (value: number, at: string) =>
  observationDraft("traffic.speed", { type: "quantity", value, unit: "km/h" }, { at });

const onDemand = (draft: Rec): Rec => ({
  ...draft,
  provenance: { ...(draft["provenance"] as Rec), accessMode: "on_demand" },
  freshness: { fetchedAt: T1, expiresAt: "2026-10-01T10:15:00.000Z" },
});

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(T1),
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.feature, conditions.offer,
    conditions.observation_latest, conditions.federation_outbox, conditions.source CASCADE`;
  await sql`DELETE FROM conditions.federation_subscription`;
  // A peer wanting every class, and the speed readings by name.
  await sql`
    INSERT INTO conditions.federation_subscription
      (id, peer_id, filter, delivery_mode, created_at, updated_at)
    VALUES ('all', 'peer-all', ${sql.json({ properties: ["traffic.speed"] })}, 'pull', now(), now())`;
  await syncRestricted();
  // Every source starts settled under its flag.
  await sql`UPDATE conditions.source SET federation_restricted = restricted`;
});

describe("reconcileFederation", () => {
  test("a source turning restricted journals a delete for each live record it had journalled", async () => {
    await write(situationDraft("a"));
    await write(situationDraft("b"));
    await write(situationDraft("c"));
    await write(speedReading(80, "2026-10-01T10:00:00Z"));
    await write(offerDraft("p1"));
    await tombstone("situation", situationId("b"), "cancelled");

    await syncRestricted(EVENTS, FLOW);
    // Ended while the source is restricted: the capture journalled nothing.
    await tombstone("situation", situationId("c"), "expired");
    // A new revision while restricted is not journalled either.
    await write(situationDraft("a", { headline: [{ lang: "nl", text: "Ongeval A2" }] }), T2);

    const result = await reconcile();
    expect(result).toEqual({
      sources: [EVENTS, FLOW],
      journalled: 2,
      settled: [EVENTS, FLOW],
    });
    expect(await operations(situationId("a"))).toEqual([
      ["create", null],
      ["delete", "withdrawn"],
    ]);
    // Already retracted by its own tombstone: not again.
    expect(await operations(situationId("b"))).toEqual([
      ["create", null],
      ["delete", "cancelled"],
    ]);
    // Ended unjournalled: the delete carries its own reason.
    expect(await operations(situationId("c"))).toEqual([
      ["create", null],
      ["delete", "expired"],
    ]);
    const [deleted] = (await journal(situationId("a"))).slice(-1);
    expect(deleted).toMatchObject({
      record_class: "situation",
      kind: "incident",
      domain: "roads",
      snapshot: null,
      property: null,
    });
    const [stored] = await sql<{ canonical_id: string }[]>`
      SELECT canonical_id FROM conditions.situation WHERE id = ${situationId("a")}`;
    expect(deleted!.canonical_id).toBe(stored!.canonical_id);
    // A reading has no retraction: a subscriber keeps no tombstone of it, and
    // the outbox withholds the source's readings once it is restricted.
    expect((await journal()).filter((e) => e.record_class === "observation")).toHaveLength(1);
    // The unchanged source is left alone.
    expect(await operations(offerId("p1"))).toEqual([["create", null]]);
    expect(await basisOf(EVENTS)).toBe(true);
    expect(await basisOf(FLOW)).toBe(true);
    expect(await basisOf(PARKING)).toBe(false);

    expect(await reconcile()).toEqual({ sources: [], journalled: 0, settled: [] });
  });

  test("a source turning restricted journals no delete of a record no peer can hold", async () => {
    await sql`DELETE FROM conditions.federation_subscription`;
    await write(situationDraft("unseen"));
    await syncRestricted(EVENTS);
    expect(await reconcile()).toMatchObject({ journalled: 0, settled: [EVENTS] });
    expect(await journal()).toEqual([]);
  });

  test("a source turning unrestricted journals a create snapshot for each live record", async () => {
    // What the capture journals of each class while the sources are public.
    await write(situationDraft("a"));
    await write(featureDraft("s1"));
    await write(offerDraft("p1"));
    await write(speedReading(80, "2026-10-01T10:00:00Z"));
    const captured = await journal();
    expect(captured.map((e) => e.record_class).sort()).toEqual([
      "feature",
      "observation",
      "offer",
      "situation",
    ]);

    // The same records under restricted sources, settled so: nothing journalled.
    await syncRestricted(EVENTS, FLOW, PARKING);
    await sql`UPDATE conditions.source SET federation_restricted = restricted`;
    await sql`TRUNCATE conditions.federation_outbox`;
    await write(situationDraft("ended"));
    await tombstone("situation", situationId("ended"), "withdrawn");

    await syncRestricted();
    // Written after the flip: the capture journals it, the reconcile does not repeat it.
    await write(situationDraft("late"));

    const result = await reconcile();
    expect(result).toEqual({
      sources: [PARKING, EVENTS, FLOW],
      journalled: 4,
      settled: [PARKING, EVENTS, FLOW],
    });
    const reconciled = await journal();
    const late = reconciled.filter((e) => e.record_id === situationId("late"));
    expect(late.map((e) => e.operation)).toEqual(["create"]);
    expect(reconciled.filter((e) => e.record_id === situationId("ended"))).toEqual([]);
    // Each create is the entry the capture writes of the record.
    const byId = (entries: Entry[]) =>
      entries
        .filter((e) => e.record_id !== situationId("late"))
        .sort((x, y) => x.record_id.localeCompare(y.record_id));
    expect(byId(reconciled)).toEqual(byId(captured).map((e) => ({ ...e, operation: "create" })));
    expect(reconciled.find((e) => e.record_id === situationId("a"))!.priority).toBe(true);
    expect(reconciled.find((e) => e.record_class === "observation")!.property).toBe(
      "traffic.speed",
    );
    expect(await basisOf(EVENTS)).toBe(false);

    expect(await reconcile()).toEqual({ sources: [], journalled: 0, settled: [] });
  });

  test("a source turning unrestricted journals nothing while no peer subscribes", async () => {
    await syncRestricted(EVENTS);
    await sql`UPDATE conditions.source SET federation_restricted = restricted`;
    await write(situationDraft("a"));
    await sql`DELETE FROM conditions.federation_subscription`;
    await syncRestricted();
    expect(await reconcile()).toMatchObject({ journalled: 0, settled: [EVENTS] });
    expect(await journal()).toEqual([]);
  });

  test("an interrupted reconcile resumes on the next run and does not repeat settled sources", async () => {
    await write(offerDraft("p1"));
    for (const local of ["a", "b", "c", "d", "e"]) await write(situationDraft(local));
    await syncRestricted(EVENTS, PARKING);

    const first = await interrupted(EVENTS, 1);
    expect(first.sources).toEqual([PARKING, EVENTS]);
    expect(first.settled).toEqual([PARKING]);
    expect(first.journalled).toBe(3);
    expect(await basisOf(PARKING)).toBe(true);
    expect(await pendingOf(PARKING)).toBe(false);
    expect(await basisOf(EVENTS)).toBe(false);
    expect(await pendingOf(EVENTS)).toBe(true);

    // Still restricted: the deletes resume where the first run stopped.
    const second = await reconcile({ batchSize: 2 });
    expect(second).toEqual({ sources: [EVENTS], journalled: 3, settled: [EVENTS] });
    expect(await pendingOf(EVENTS)).toBe(false);
    for (const local of ["a", "b", "c", "d", "e"]) {
      expect(await operations(situationId(local))).toEqual([
        ["create", null],
        ["delete", "withdrawn"],
      ]);
    }
    expect(await operations(offerId("p1"))).toEqual([
      ["create", null],
      ["delete", "withdrawn"],
    ]);
    expect(await reconcile()).toEqual({ sources: [], journalled: 0, settled: [] });
  });

  test("a reconcile interrupted mid-retraction and flipped back re-journals the retracted records", async () => {
    for (const local of ["a", "b", "c", "d", "e"]) await write(situationDraft(local));
    await syncRestricted(EVENTS);
    const first = await interrupted(EVENTS, 1);
    expect(first).toMatchObject({ journalled: 2, settled: [] });
    expect(await pendingOf(EVENTS)).toBe(true);

    // The catalogue turns the source public again: its basis matches the flag.
    await syncRestricted();
    expect(await basisOf(EVENTS)).toBe(false);

    expect(await reconcile()).toEqual({ sources: [EVENTS], journalled: 2, settled: [EVENTS] });
    for (const local of ["a", "b"]) {
      expect(await operations(situationId(local))).toEqual([
        ["create", null],
        ["delete", "withdrawn"],
        ["create", null],
      ]);
    }
    for (const local of ["c", "d", "e"]) {
      expect(await operations(situationId(local))).toEqual([["create", null]]);
    }
    expect(await pendingOf(EVENTS)).toBe(false);
    expect(await basisOf(EVENTS)).toBe(false);
    expect(await reconcile()).toEqual({ sources: [], journalled: 0, settled: [] });
  });

  test("an unchanged source journals nothing", async () => {
    await write(situationDraft("a"));
    await write(featureDraft("s1"));
    const before = await journal();
    expect(await reconcile()).toEqual({ sources: [], journalled: 0, settled: [] });
    expect(await journal()).toEqual(before);
  });

  test("a source with no basis yet is taken as in sync with its flag", async () => {
    await write(situationDraft("a"));
    await write(offerDraft("p1"));
    await syncRestricted(EVENTS, PARKING);
    await sql`UPDATE conditions.source SET federation_restricted = NULL WHERE id <> ${EVENTS}`;
    const before = await journal();

    // Settled in listing order, the flipped source between the unjournalled ones.
    expect(await reconcile()).toEqual({
      sources: [PARKING, EVENTS, FLOW],
      journalled: 1,
      settled: [PARKING, EVENTS, FLOW],
    });
    const after = await journal();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((e) => [e.operation, e.record_id])).toEqual([
      ["delete", situationId("a")],
    ]);
    expect(await basisOf(PARKING)).toBe(true);
    expect(await basisOf(EVENTS)).toBe(true);
    expect(await basisOf(FLOW)).toBe(false);
  });

  test("a record the source gained after turning restricted is never journalled, before or while the reconcile runs", async () => {
    for (const local of ["a", "b", "c"]) await write(situationDraft(local));
    await syncRestricted(EVENTS);
    await write(situationDraft("d-before"));

    expect(await interrupted(EVENTS, 1)).toMatchObject({ journalled: 2, settled: [] });
    await write(situationDraft("e-while"));
    expect(await reconcile({ batchSize: 2 })).toEqual({
      sources: [EVENTS],
      journalled: 1,
      settled: [EVENTS],
    });

    for (const local of ["a", "b", "c"]) {
      expect(await operations(situationId(local))).toEqual([
        ["create", null],
        ["delete", "withdrawn"],
      ]);
    }
    // Erased while restricted: still nothing a peer could have held.
    await tombstone("situation", situationId("e-while"), "rights_revoked");
    expect(await operations(situationId("d-before"))).toEqual([]);
    expect(await operations(situationId("e-while"))).toEqual([]);
  });

  test("a long-lived record whose entries were pruned is still retracted", async () => {
    await write(situationDraft("kept"));
    await write(situationDraft("erased"));
    // Past the outbox retention floor, while a peer still holds both.
    await sql`TRUNCATE conditions.federation_outbox`;
    await syncRestricted(EVENTS);

    await tombstone("situation", situationId("erased"), "rights_revoked");
    expect(await operations(situationId("erased"))).toEqual([["delete", "rights_revoked"]]);
    expect(await reconcile()).toMatchObject({ journalled: 1, settled: [EVENTS] });
    expect(await operations(situationId("kept"))).toEqual([["delete", "withdrawn"]]);
    expect(await operations(situationId("erased"))).toEqual([["delete", "rights_revoked"]]);
  });

  test("on-demand records are never journalled either way", async () => {
    await write(onDemand(situationDraft("answer")));
    await write(onDemand(offerDraft("answer")));
    expect(await journal()).toEqual([]);

    await syncRestricted(EVENTS, PARKING);
    expect(await reconcile()).toMatchObject({ journalled: 0, settled: [PARKING, EVENTS] });
    expect(await journal()).toEqual([]);

    await syncRestricted();
    expect(await reconcile()).toMatchObject({ journalled: 0, settled: [PARKING, EVENTS] });
    expect(await journal()).toEqual([]);
  });
});

describe("the federation basis", () => {
  test("a catalogue sync leaves it alone", async () => {
    await syncRestricted(EVENTS);
    expect(await basisOf(EVENTS)).toBe(false);
  });
});

describe("a source restricted since it was added", () => {
  beforeEach(async () => {
    await sql`DELETE FROM conditions.source WHERE id = ${EVENTS}`;
    await syncRestricted(EVENTS);
    await sql`UPDATE conditions.source SET federation_restricted = restricted`;
  });

  test("an erasure of its record journals nothing", async () => {
    await write(situationDraft("a"));
    await tombstone("situation", situationId("a"), "rights_revoked");
    expect(await journal()).toEqual([]);
  });

  test("turned public and back, it retracts what it shared and nothing it gained since", async () => {
    await write(situationDraft("restricted-1"));
    await syncRestricted();
    await reconcile();
    await write(situationDraft("public-1"));
    await syncRestricted(EVENTS);
    await write(situationDraft("restricted-2"));
    expect(await reconcile()).toMatchObject({ journalled: 2, settled: [EVENTS] });
    for (const local of ["restricted-1", "public-1"]) {
      expect(await operations(situationId(local))).toEqual([
        ["create", null],
        ["delete", "withdrawn"],
      ]);
    }
    expect(await operations(situationId("restricted-2"))).toEqual([]);
  });
});

describe("restricted_since", () => {
  async function since(id: string): Promise<Date | null> {
    const [row] = await sql<{ restricted_since: Date | null }[]>`
      SELECT restricted_since FROM conditions.source WHERE id = ${id}`;
    return row!.restricted_since;
  }

  test("is when a source turned restricted, kept while it stays so, and cleared when public", async () => {
    expect(await since(EVENTS)).toBeNull();
    await syncRestricted(EVENTS);
    const turned = await since(EVENTS);
    expect(turned).toBeInstanceOf(Date);
    await syncRestricted(EVENTS);
    expect(await since(EVENTS)).toEqual(turned);
    await syncRestricted();
    expect(await since(EVENTS)).toBeNull();
  });

  test("is a source's creation when it is added restricted", async () => {
    await sql`DELETE FROM conditions.source WHERE id = ${EVENTS}`;
    const [row] = await sql<{ before: Date }[]>`SELECT clock_timestamp() AS before`;
    await syncRestricted(EVENTS);
    expect((await since(EVENTS))!.getTime()).toBeGreaterThanOrEqual(row!.before.getTime());
  });
});
