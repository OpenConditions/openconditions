import { contentHash, sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rowOf } from "../record-rows.js";
import { type WriteContext, writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { featureDraft, offerDraft, roadworksDraft, situationDraft } from "./drafts.js";

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

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.feature, conditions.offer,
    conditions.record_relation CASCADE`;
});

const ctx = (now: string, complete = true): WriteContext => ({
  registry,
  instanceId: "test.local",
  now,
  complete,
});

const T1 = "2026-10-01T10:00:05.000Z";
const T2 = "2026-10-01T10:01:05.000Z";
const T3 = "2026-10-01T10:02:05.000Z";
const T4 = "2026-10-01T10:03:05.000Z";

async function revisions(table: "situation" | "feature", id: string) {
  return sql.unsafe<{ revision: number; change_kinds: string[] }[]>(
    `SELECT revision, change_kinds FROM conditions.${table}_revision
      WHERE ${table}_id = $1 ORDER BY revision`,
    [id],
  );
}

describe("writeSnapshot", () => {
  it("moves the expiry of unchanged content without a revision, and drops it when the source does", async () => {
    const until = (expiresAt?: string) =>
      situationDraft("a", {
        freshness: { fetchedAt: "2026-10-01T10:00:00.000Z", ...(expiresAt ? { expiresAt } : {}) },
      });
    await writeSnapshot(sql, "nl-ndw", { situations: [until("2026-10-01T10:15:00Z")] }, ctx(T1));
    const again = await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [until("2026-10-01T10:30:00Z")] },
      ctx(T2),
    );
    expect(again.counts.situation).toMatchObject({ unchanged: 1, updated: 0 });
    const expiry = async () => {
      const [row] = await sql`
        SELECT expires_at, record #>> '{freshness,expiresAt}' AS stated, revision
          FROM conditions.situation WHERE id = 'oc:situation:nl-ndw:a'`;
      return row;
    };
    expect(await expiry()).toEqual({
      expires_at: new Date("2026-10-01T10:30:00Z"),
      stated: "2026-10-01T10:30:00Z",
      revision: 1,
    });
    await writeSnapshot(sql, "nl-ndw", { situations: [until()] }, ctx(T3));
    expect(await expiry()).toEqual({ expires_at: null, stated: null, revision: 1 });
    expect(await revisions("situation", "oc:situation:nl-ndw:a")).toHaveLength(1);
  });

  it("stores new records with their first revision, effects, components and relations", async () => {
    const summary = await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("a"), roadworksDraft("w")] },
      ctx(T1),
    );
    expect(summary.counts.situation).toMatchObject({ created: 2, unchanged: 0 });
    expect(summary.rejected).toEqual([]);

    const [row] = await sql`
      SELECT revision, recorded_at, kind, type, severity, certainty, planned, source_id,
        instance_id, ST_AsText(geom) AS geom, country
      FROM conditions.situation WHERE id = 'oc:situation:nl-ndw:a'`;
    expect(row).toMatchObject({
      revision: 1,
      kind: "incident",
      type: "accident",
      severity: "major",
      certainty: "observed",
      planned: false,
      source_id: "nl-ndw",
      instance_id: "test.local",
      geom: "POINT(4.9 52.37)",
      country: "NL",
    });
    expect(await revisions("situation", "oc:situation:nl-ndw:a")).toEqual([
      { revision: 1, change_kinds: ["created"] },
    ]);

    const effects = await sql`
      SELECT situation_id, effect_id, phase_id, kind, valid_from, valid_to
      FROM conditions.situation_effect ORDER BY situation_id`;
    expect(effects).toEqual([
      {
        situation_id: "oc:situation:nl-ndw:a",
        effect_id: "a/closure",
        phase_id: "",
        kind: "closure",
        valid_from: new Date("2026-10-01T09:00:00Z"),
        valid_to: null,
      },
      {
        situation_id: "oc:situation:nl-ndw:w",
        effect_id: "w/lane_restriction",
        phase_id: "p1",
        kind: "lane_restriction",
        valid_from: new Date("2026-10-05T20:00:00Z"),
        valid_to: new Date("2026-10-06T05:00:00Z"),
      },
    ]);
  });

  it("stores a feature's components and its relations", async () => {
    await writeSnapshot(sql, "nl-ndw-flow", { features: [featureDraft("s1", 3)] }, ctx(T1));
    const components = await sql`
      SELECT key, kind, ST_AsText(position) AS position
      FROM conditions.feature_component ORDER BY key`;
    expect(components.map((c) => c["key"])).toEqual(["lane1", "lane2", "lane3"]);
    expect(components[0]).toMatchObject({
      kind: "sensor_channel",
      position: "POINT(4.536 52.0235)",
    });
    const relations = await sql`SELECT from_class, relation, to_class, to_id, component_key
      FROM conditions.record_relation`;
    expect(relations).toEqual([
      {
        from_class: "feature",
        relation: "related",
        to_class: "situation",
        to_id: "oc:situation:nl-ndw:works",
        component_key: "",
      },
    ]);
  });

  it("writes nothing for unchanged content and keeps the first fetch time", async () => {
    await writeSnapshot(sql, "nl-ndw", { situations: [situationDraft("a")] }, ctx(T1));
    const again = situationDraft("a", { freshness: { fetchedAt: "2026-10-01T10:01:00.000Z" } });
    const summary = await writeSnapshot(sql, "nl-ndw", { situations: [again] }, ctx(T2));
    expect(summary.counts.situation).toMatchObject({ unchanged: 1, updated: 0 });
    expect(summary.changed).toEqual([]);
    const [row] = await sql`SELECT revision, record->'freshness'->>'fetchedAt' AS fetched
      FROM conditions.situation`;
    expect(row).toEqual({ revision: 1, fetched: "2026-10-01T10:00:00.000Z" });
  });

  it("revises changed content, naming what changed", async () => {
    await writeSnapshot(sql, "nl-ndw", { situations: [situationDraft("a")] }, ctx(T1));
    const worse = situationDraft("a", {
      severity: { label: "critical", source: "declared", declaredRaw: "highest" },
    });
    const summary = await writeSnapshot(sql, "nl-ndw", { situations: [worse] }, ctx(T2));
    expect(summary.counts.situation).toMatchObject({ updated: 1 });
    expect(await revisions("situation", "oc:situation:nl-ndw:a")).toEqual([
      { revision: 1, change_kinds: ["created"] },
      { revision: 2, change_kinds: ["severity_change"] },
    ]);
    const [row] = await sql`SELECT severity, revision, recorded_at FROM conditions.situation`;
    expect(row).toEqual({ severity: "critical", revision: 2, recorded_at: new Date(T2) });
  });

  it("tombstones what a complete snapshot no longer holds, and restores it when it returns", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("a"), situationDraft("b")] },
      ctx(T1),
    );
    const gone = await writeSnapshot(sql, "nl-ndw", { situations: [situationDraft("a")] }, ctx(T2));
    expect(gone.counts.situation).toMatchObject({ unchanged: 1, withdrawn: 1 });
    const [b] = await sql`
      SELECT tombstone_reason, tombstoned_at, revision, record->'tombstone' AS tombstone
      FROM conditions.situation WHERE id = 'oc:situation:nl-ndw:b'`;
    expect(b).toEqual({
      tombstone_reason: "withdrawn",
      tombstoned_at: new Date(T2),
      revision: 2,
      tombstone: { reason: "withdrawn", at: T2 },
    });
    const [{ effects }] = await sql`SELECT count(*)::int AS effects FROM conditions.situation_effect
      WHERE situation_id = 'oc:situation:nl-ndw:b'`;
    expect(effects).toBe(0);

    const back = await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("a"), situationDraft("b")] },
      ctx(T3),
    );
    expect(back.counts.situation).toMatchObject({ restored: 1, unchanged: 1 });
    expect(await revisions("situation", "oc:situation:nl-ndw:b")).toEqual([
      { revision: 1, change_kinds: ["created"] },
      { revision: 2, change_kinds: ["tombstoned"] },
      { revision: 3, change_kinds: ["created"] },
    ]);
    const [restored] = await sql`SELECT tombstone_reason, record ? 'tombstone' AS has_tombstone
      FROM conditions.situation WHERE id = 'oc:situation:nl-ndw:b'`;
    expect(restored).toEqual({ tombstone_reason: null, has_tombstone: false });
  });

  it("withdraws nothing from a partial snapshot", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("a"), situationDraft("b")] },
      ctx(T1),
    );
    const partial = await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("a")] },
      ctx(T2, false),
    );
    expect(partial.counts.situation.withdrawn).toBe(0);
    const [{ live }] = await sql`SELECT count(*)::int AS live FROM conditions.situation
      WHERE tombstoned_at IS NULL`;
    expect(live).toBe(2);
  });

  it("rejects an invalid draft without losing the rest of the poll or its stored version", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("a"), situationDraft("b")] },
      ctx(T1),
    );
    const broken = situationDraft("b", { kind: "volcano" });
    const summary = await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("a"), broken, situationDraft("c")] },
      ctx(T2),
    );
    expect(summary.counts.situation).toMatchObject({ created: 1, unchanged: 1, withdrawn: 0 });
    expect(summary.rejected.map((r) => r.id)).toEqual(["oc:situation:nl-ndw:b"]);
    const [b] = await sql`SELECT kind, tombstone_reason FROM conditions.situation
      WHERE id = 'oc:situation:nl-ndw:b'`;
    expect(b).toEqual({ kind: "incident", tombstone_reason: null });
  });

  it("stores a record a poll repeats once, as its last copy says", async () => {
    const first = situationDraft("dup", { certainty: "possible" });
    const last = situationDraft("dup", { certainty: "observed" });
    const summary = await writeSnapshot(sql, "nl-ndw", { situations: [first, last] }, ctx(T1));
    expect(summary.counts.situation).toMatchObject({ created: 1 });
    const rows = await sql`SELECT certainty FROM conditions.situation`;
    expect(rows).toEqual([{ certainty: "observed" }]);
  });

  it("rejects a draft of another source, or one with a field no schema has", async () => {
    const foreign = situationDraft("x", {
      provenance: { ...(situationDraft("x")["provenance"] as object), sourceId: "be-flanders" },
    });
    const stray = situationDraft("y", { colour: "red" });
    const summary = await writeSnapshot(sql, "nl-ndw", { situations: [foreign, stray] }, ctx(T1));
    expect(summary.rejected.map((r) => r.id)).toEqual([
      "oc:situation:nl-ndw:x",
      "oc:situation:nl-ndw:y",
    ]);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM conditions.situation`;
    expect(count).toBe(0);
  });

  it("stores offers with their promoted prices and subject", async () => {
    await writeSnapshot(sql, "de-parking", { offers: [offerDraft("day")] }, ctx(T4));
    const [row] =
      await sql`SELECT subject_class, subject_id, component_key, currency, min_price, max_price
      FROM conditions.offer`;
    expect(row).toEqual({
      subject_class: "feature",
      subject_id: "oc:feature:de-parking:p1",
      component_key: null,
      currency: "EUR",
      min_price: "2.5000",
      max_price: "20.0000",
    });
  });
});

describe("promoted columns", () => {
  it("hold exactly what each stored record says", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw",
      { situations: [situationDraft("a"), roadworksDraft("w")] },
      ctx(T1),
    );
    await writeSnapshot(sql, "nl-ndw-flow", { features: [featureDraft("s1")] }, ctx(T1));
    await writeSnapshot(sql, "de-parking", { offers: [offerDraft("day")] }, ctx(T1));
    for (const cls of ["situation", "feature", "offer"] as const) {
      const rows = await sql.unsafe(
        `SELECT *, ST_AsGeoJSON(geom)::jsonb AS geom FROM conditions.${cls}`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const expected = rowOf(cls, row["record"] as Record<string, unknown>);
        for (const [column, value] of Object.entries(expected)) {
          const stored = row[column];
          const actual =
            stored instanceof Date
              ? stored.toISOString()
              : column.endsWith("_price") && stored !== null
                ? String(Number(stored))
                : stored;
          const want =
            typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)
              ? new Date(value).toISOString()
              : column.endsWith("_price") && value !== null
                ? String(Number(value))
                : value;
          expect(actual, `${cls}.${column}`).toEqual(want);
        }
      }
    }
  });
});

describe("the write seam", () => {
  it("seals a draft to a record whose content hash is the draft's own", () => {
    for (const draft of [
      situationDraft("a"),
      roadworksDraft("w"),
      featureDraft("f"),
      offerDraft("o"),
    ]) {
      const sealed = sealRecord(registry, draft, { instanceId: "x", revision: 7, recordedAt: T1 });
      expect(sealed.ok && sealed.value["contentHash"]).toBe(contentHash(draft));
    }
  });
});
