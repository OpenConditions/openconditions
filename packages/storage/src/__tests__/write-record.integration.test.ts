import { sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { writeRecord } from "../write-record.js";
import { writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { FETCHED_AT, observationDraft, situationDraft } from "./drafts.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const T1 = "2026-10-01T10:00:05.000Z";
const T2 = "2026-10-01T10:05:05.000Z";
const ctx = (now: string) => ({ registry, instanceId: "test.local", now });

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
  await sql`TRUNCATE conditions.situation, conditions.observation_latest CASCADE`;
});

/** A crowd report of an accident, as landing a claim drafts it. */
function crowdDraft(over: Record<string, unknown> = {}) {
  const base = situationDraft("r1");
  return {
    ...base,
    id: "oc:situation:test.local:r1",
    certainty: "unknown",
    severity: { label: "unknown" },
    provenance: {
      origin: "crowd",
      sourceId: "crowd",
      sourceFormat: "crowd",
      accessMode: "bulk",
      recordId: "r1",
      attribution: { provider: "OpenConditions contributors", license: "CC0-1.0" },
      privacy: { class: "crowd_pseudonym" },
    },
    freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:30:00.000Z" },
    ...over,
  };
}

async function revisions(id: string) {
  return sql`SELECT revision, change_kinds FROM conditions.situation_revision
    WHERE situation_id = ${id} ORDER BY revision`;
}

describe("writeRecord with a draft", () => {
  it("seals and stores a crowd report, then revises it only when its content changes", async () => {
    expect(await writeRecord(sql, { draft: crowdDraft() }, ctx(T1))).toEqual({
      status: "created",
      class: "situation",
      id: "oc:situation:test.local:r1",
      revision: 1,
    });
    expect(await writeRecord(sql, { draft: crowdDraft() }, ctx(T2))).toMatchObject({
      status: "unchanged",
      revision: 1,
    });
    const worse = crowdDraft({ severity: { label: "major", level: 4, source: "declared" } });
    expect(await writeRecord(sql, { draft: worse }, ctx(T2))).toMatchObject({
      status: "updated",
      revision: 2,
    });
    expect(await revisions("oc:situation:test.local:r1")).toEqual([
      { revision: 1, change_kinds: ["created"] },
      { revision: 2, change_kinds: ["severity_change"] },
    ]);
    const [row] = await sql`SELECT source_id, origin, privacy_class, instance_id, expires_at
      FROM conditions.situation`;
    expect(row).toEqual({
      source_id: "crowd",
      origin: "crowd",
      privacy_class: "crowd_pseudonym",
      instance_id: "test.local",
      expires_at: new Date("2026-10-01T10:30:00.000Z"),
    });
  });

  it("rejects a draft that fails validation", async () => {
    const result = await writeRecord(sql, { draft: crowdDraft({ kind: "volcano" }) }, ctx(T1));
    expect(result.status).toBe("rejected");
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM conditions.situation`;
    expect(count).toBe(0);
  });
});

describe("writeRecord with a stored record", () => {
  /** A peer's record, sealed by that peer at the given revision. */
  function peerRecord(revision: number, over: Record<string, unknown> = {}) {
    const draft = situationDraft("p1", {
      id: "oc:situation:be-flanders-events:p1",
      provenance: {
        ...(situationDraft("p1")["provenance"] as object),
        sourceId: "be-flanders-events",
        recordId: "p1",
      },
    });
    const sealed = sealRecord(registry, draft, {
      instanceId: "peer.example",
      revision,
      recordedAt: T1,
    });
    if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
    return { ...sealed.value, ...over };
  }

  it("keeps the peer's revision and ignores a delivery that is not newer", async () => {
    expect(await writeRecord(sql, { stored: peerRecord(3) }, ctx(T1))).toMatchObject({
      status: "created",
      revision: 3,
    });
    expect(await writeRecord(sql, { stored: peerRecord(3) }, ctx(T2))).toMatchObject({
      status: "stale",
      revision: 3,
    });
    expect(await writeRecord(sql, { stored: peerRecord(2) }, ctx(T2))).toMatchObject({
      status: "stale",
    });
    const [row] = await sql`SELECT instance_id, revision FROM conditions.situation`;
    expect(row).toEqual({ instance_id: "peer.example", revision: 3 });
  });

  it("takes the expiry of a delivery at the kept revision", async () => {
    await writeRecord(sql, { stored: peerRecord(1) }, ctx(T1));
    const base = peerRecord(1);
    const later = "2030-01-01T00:00:00.000Z";
    const extended = { ...base, freshness: { ...(base["freshness"] as object), expiresAt: later } };
    expect(await writeRecord(sql, { stored: extended }, ctx(T2))).toMatchObject({
      status: "refreshed",
      revision: 1,
    });
    const [row] = await sql`
      SELECT revision, expires_at, record #>> '{freshness,expiresAt}' AS stated
      FROM conditions.situation`;
    expect(row).toEqual({ revision: 1, expires_at: new Date(later), stated: later });
    expect(await writeRecord(sql, { stored: extended }, ctx(T2))).toMatchObject({
      status: "stale",
    });
  });

  it("applies the peer's tombstone and drops the record's effects", async () => {
    await writeRecord(sql, { stored: peerRecord(1) }, ctx(T1));
    const tombstoned = peerRecord(2, { tombstone: { reason: "cancelled", at: T2 } });
    expect(await writeRecord(sql, { stored: tombstoned }, ctx(T2))).toMatchObject({
      status: "updated",
      revision: 2,
    });
    const [row] = await sql`SELECT tombstone_reason FROM conditions.situation`;
    expect(row).toEqual({ tombstone_reason: "cancelled" });
    const [{ effects }] =
      await sql`SELECT count(*)::int AS effects FROM conditions.situation_effect`;
    expect(effects).toBe(0);
  });

  it("refuses a stored record that is not one", async () => {
    const result = await writeRecord(sql, { stored: situationDraft("x") }, ctx(T1));
    expect(result.status).toBe("rejected");
  });

  it("never lets a peer's record replace one another instance wrote under the same id", async () => {
    const own = situationDraft("p1", {
      id: "oc:situation:be-flanders-events:p1",
      provenance: {
        ...(situationDraft("p1")["provenance"] as object),
        sourceId: "be-flanders-events",
        recordId: "p1",
      },
    });
    await writeRecord(sql, { draft: own }, ctx(T1));
    expect(await writeRecord(sql, { stored: peerRecord(5) }, ctx(T2))).toEqual({
      status: "foreign",
      class: "situation",
      id: "oc:situation:be-flanders-events:p1",
      revision: 1,
    });
    const [row] = await sql`SELECT instance_id, revision FROM conditions.situation`;
    expect(row).toEqual({ instance_id: "test.local", revision: 1 });
  });

  it("lets this instance's own poll take over a peer's copy of the same content", async () => {
    const own = situationDraft("p1", {
      id: "oc:situation:be-flanders-events:p1",
      provenance: {
        ...(situationDraft("p1")["provenance"] as object),
        sourceId: "be-flanders-events",
        recordId: "p1",
      },
    });
    await writeRecord(sql, { stored: peerRecord(3) }, ctx(T1));
    const summary = await writeSnapshot(
      sql,
      "be-flanders-events",
      { situations: [own] },
      { ...ctx(T2), complete: true },
    );
    expect(summary.counts.situation).toMatchObject({ updated: 1, unchanged: 0 });
    expect(summary.changed).toEqual([
      { class: "situation", id: "oc:situation:be-flanders-events:p1", revision: 4 },
    ]);
    const [row] = await sql`
      SELECT instance_id, revision, record #>> '{provenance,instanceId}' AS sealed_by,
             recorded_at
        FROM conditions.situation`;
    expect(row).toEqual({
      instance_id: "test.local",
      revision: 4,
      sealed_by: "test.local",
      recorded_at: new Date(T2),
    });
    expect(await writeRecord(sql, { stored: peerRecord(5) }, ctx(T2))).toMatchObject({
      status: "foreign",
    });
  });

  it("lets a draft written here take over a peer's copy of the same content", async () => {
    const own = situationDraft("p1", {
      id: "oc:situation:be-flanders-events:p1",
      provenance: {
        ...(situationDraft("p1")["provenance"] as object),
        sourceId: "be-flanders-events",
        recordId: "p1",
      },
    });
    await writeRecord(sql, { stored: peerRecord(3) }, ctx(T1));
    expect(await writeRecord(sql, { draft: own }, ctx(T2))).toMatchObject({
      status: "updated",
      revision: 4,
    });
    const [row] = await sql`SELECT instance_id FROM conditions.situation`;
    expect(row).toEqual({ instance_id: "test.local" });
  });
});

describe("on-demand records", () => {
  it("are stored with their expiry and keep no revisions", async () => {
    const draft = situationDraft("od", {
      provenance: { ...(situationDraft("od")["provenance"] as object), accessMode: "on_demand" },
      freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00.000Z" },
    });
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [draft] },
      { ...ctx(T1), complete: true },
    );
    expect(summary.counts.situation.created).toBe(1);
    const [row] = await sql`SELECT access_mode, expires_at FROM conditions.situation`;
    expect(row).toEqual({
      access_mode: "on_demand",
      expires_at: new Date("2026-10-01T10:15:00.000Z"),
    });
    expect(await revisions("oc:situation:nl-ndw-events:od")).toEqual([]);
  });

  it("live until the expiry the latest answer states, when its content is the same", async () => {
    const answer = (expiresAt: string) =>
      situationDraft("od", {
        provenance: { ...(situationDraft("od")["provenance"] as object), accessMode: "on_demand" },
        freshness: { fetchedAt: FETCHED_AT, expiresAt },
      });
    await writeRecord(sql, { draft: answer("2026-10-01T10:15:00.000Z") }, ctx(T1));
    expect(
      await writeRecord(sql, { draft: answer("2026-10-01T10:20:00.000Z") }, ctx(T2)),
    ).toMatchObject({ status: "unchanged" });
    const [row] = await sql`SELECT expires_at FROM conditions.situation`;
    expect(row).toEqual({ expires_at: new Date("2026-10-01T10:20:00.000Z") });
  });
});

describe("writeRecord with an observation", () => {
  it("adds the reading to its series and recognises a repeat", async () => {
    const reading = observationDraft(
      "traffic.speed",
      { type: "quantity", value: 42, unit: "km/h" },
      { at: "2026-10-01T10:00:00Z" },
    );
    expect(await writeRecord(sql, { draft: reading }, ctx(T1))).toMatchObject({
      status: "updated",
      class: "observation",
    });
    expect(await writeRecord(sql, { draft: reading }, ctx(T2))).toMatchObject({
      status: "unchanged",
    });
  });
});
