import { contentHash, sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { rowOf } from "../record-rows.js";
import { type WriteContext, writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import {
  featureDraft,
  observationDraft,
  offerDraft,
  roadworksDraft,
  situationDraft,
} from "./drafts.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();

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
  await sql`TRUNCATE conditions.observation_latest CASCADE`;
  await sql`TRUNCATE conditions.observation`;
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

async function observeClassScans<T>(run: () => Promise<T>) {
  const scans: string[] = [];
  const debug = sql.options.debug;
  sql.options.debug = (_connection, query) => {
    const match = query.match(
      /^SELECT id, content_hash, revision,[\s\S]*FROM conditions\.(feature|situation|offer) WHERE source_id = \$1/,
    );
    if (match) scans.push(match[1]!);
  };
  try {
    return { result: await run(), scans };
  } finally {
    sql.options.debug = debug;
  }
}

async function seedMetadata() {
  const source = "nl-ndw-flow";
  const owned = (draft: Record<string, unknown>) => ({
    ...draft,
    id: String(draft["id"]).replace(/:(nl-ndw-events|de-parking):/, `:${source}:`),
    provenance: { ...(draft["provenance"] as object), sourceId: source },
  });
  await writeSnapshot(
    sql,
    source,
    {
      features: [featureDraft("s1")],
      situations: [owned(situationDraft("a"))],
      offers: [owned(offerDraft("day"))],
    },
    ctx(T1),
  );
}

async function metadataRows() {
  return sql`SELECT 'feature' AS class, record FROM conditions.feature
    UNION ALL SELECT 'situation', record FROM conditions.situation
    UNION ALL SELECT 'offer', record FROM conditions.offer ORDER BY class`;
}

async function metadataHistory() {
  return sql`SELECT 'feature' AS class, revision, change_kinds FROM conditions.feature_revision
    UNION ALL SELECT 'situation', revision, change_kinds FROM conditions.situation_revision
    UNION ALL SELECT 'offer', revision, change_kinds FROM conditions.offer_revision
    ORDER BY class, revision`;
}

const zeroCounts = { created: 0, updated: 0, restored: 0, unchanged: 0, withdrawn: 0 };

describe("writeSnapshot", () => {
  it("skips metadata scans for empty incomplete classes while keeping their records and history", async () => {
    await seedMetadata();
    const rows = await metadataRows();
    const history = await metadataHistory();
    const { result, scans } = await observeClassScans(() =>
      writeSnapshot(
        sql,
        "nl-ndw-flow",
        { features: [], situations: [], offers: [] },
        ctx(T2, false),
      ),
    );
    expect(await metadataRows()).toEqual(rows);
    expect(await metadataHistory()).toEqual(history);
    expect(result.counts).toEqual({
      feature: zeroCounts,
      situation: zeroCounts,
      offer: zeroCounts,
    });
    expect(result.changed).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(scans).toEqual([]);
  });

  it.each(["feature", "situation", "offer"] as const)(
    "scans and withdraws only the class-specific complete empty %s",
    async (cls) => {
      await seedMetadata();
      const before = await metadataRows();
      const { result, scans } = await observeClassScans(() =>
        writeSnapshot(sql, "nl-ndw-flow", {}, { ...ctx(T2), complete: { [cls]: true } }),
      );
      for (const row of await metadataRows()) {
        if (row["class"] === cls) {
          expect(row["record"]).toMatchObject({
            revision: 2,
            recordedAt: T2,
            tombstone: { reason: "withdrawn", at: T2 },
          });
        } else {
          expect(row).toEqual(before.find((r) => r["class"] === row["class"]));
        }
      }
      expect(result.counts).toEqual({
        feature: { ...zeroCounts, withdrawn: cls === "feature" ? 1 : 0 },
        situation: { ...zeroCounts, withdrawn: cls === "situation" ? 1 : 0 },
        offer: { ...zeroCounts, withdrawn: cls === "offer" ? 1 : 0 },
      });
      expect((await metadataHistory()).filter((r) => r["class"] === cls)).toEqual([
        { class: cls, revision: 1, change_kinds: ["created"] },
        { class: cls, revision: 2, change_kinds: ["tombstoned"] },
      ]);
      expect(result.changed).toHaveLength(1);
      expect(scans).toEqual([cls]);
    },
  );

  it("keeps complete-empty withdrawal and history for every metadata class", async () => {
    await seedMetadata();
    const { result, scans } = await observeClassScans(() =>
      writeSnapshot(sql, "nl-ndw-flow", {}, ctx(T2)),
    );
    expect(result.counts).toEqual({
      feature: { ...zeroCounts, withdrawn: 1 },
      situation: { ...zeroCounts, withdrawn: 1 },
      offer: { ...zeroCounts, withdrawn: 1 },
    });
    expect(result.changed).toHaveLength(3);
    expect((await metadataRows()).map((r) => r["record"])).toEqual([
      expect.objectContaining({ revision: 2, tombstone: { reason: "withdrawn", at: T2 } }),
      expect.objectContaining({ revision: 2, tombstone: { reason: "withdrawn", at: T2 } }),
      expect.objectContaining({ revision: 2, tombstone: { reason: "withdrawn", at: T2 } }),
    ]);
    expect(await metadataHistory()).toHaveLength(6);
    expect(scans).toEqual(["feature", "situation", "offer"]);
  });

  it("still scans and revises a nonempty incomplete class without withdrawing missing records", async () => {
    await seedMetadata();
    await writeSnapshot(sql, "nl-ndw-flow", { features: [featureDraft("s2")] }, ctx(T1, false));
    const { result, scans } = await observeClassScans(() =>
      writeSnapshot(
        sql,
        "nl-ndw-flow",
        {
          features: [featureDraft("s1", 3)],
        },
        ctx(T2, false),
      ),
    );
    expect(result.counts.feature).toEqual({ ...zeroCounts, updated: 1 });
    expect(result.counts.situation).toEqual(zeroCounts);
    expect(result.counts.offer).toEqual(zeroCounts);
    expect(await revisions("feature", "oc:feature:nl-ndw-flow:s1")).toHaveLength(2);
    expect(
      await sql`SELECT id, revision FROM conditions.feature WHERE tombstoned_at IS NULL ORDER BY id`,
    ).toEqual([
      { id: "oc:feature:nl-ndw-flow:s1", revision: 2 },
      { id: "oc:feature:nl-ndw-flow:s2", revision: 1 },
    ]);
    expect(scans).toEqual(["feature"]);
  });

  it("still ends unstated observation states and writes reading history with incomplete metadata", async () => {
    await seedMetadata();
    const state = (site: string, value: string, at: string) =>
      observationDraft(
        "traffic.los",
        {
          type: "category",
          value,
          vocabulary: "los",
        },
        { at, subject: { kind: "feature", featureId: `oc:feature:nl-ndw-flow:${site}` } },
      );
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [state("s1", "queuing", T1), state("s2", "free_flow", T1)],
      },
      { ...ctx(T1, false), statesComplete: true },
    );
    const metadata = await metadataRows();
    const { result, scans } = await observeClassScans(() =>
      writeSnapshot(
        sql,
        "nl-ndw-flow",
        {
          observations: [state("s1", "free_flow", T2)],
        },
        { ...ctx(T2, false), statesComplete: true },
      ),
    );
    expect(result.observations).toMatchObject({ latest: 1, history: 1, ended: 1 });
    expect(await metadataRows()).toEqual(metadata);
    expect(
      await sql`SELECT feature_id, value_text,
        conditions.observation_record(template, reading) ->> 'validUntil' AS valid_until
        FROM conditions.observation_latest ORDER BY feature_id`,
    ).toEqual([
      { feature_id: "oc:feature:nl-ndw-flow:s1", value_text: "free_flow", valid_until: null },
      {
        feature_id: "oc:feature:nl-ndw-flow:s2",
        value_text: "free_flow",
        valid_until: T2,
      },
    ]);
    expect(
      await sql`SELECT value_text FROM conditions.observation ORDER BY phenomenon_start, value_text`,
    ).toEqual([
      { value_text: "free_flow" },
      { value_text: "queuing" },
      { value_text: "free_flow" },
    ]);
    expect(scans).toEqual([]);
  });

  it("moves the expiry of unchanged content without a revision, and drops it when the source does", async () => {
    const until = (expiresAt?: string) =>
      situationDraft("a", {
        freshness: { fetchedAt: "2026-10-01T10:00:00.000Z", ...(expiresAt ? { expiresAt } : {}) },
      });
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [until("2026-10-01T10:15:00Z")] },
      ctx(T1),
    );
    const again = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [until("2026-10-01T10:30:00Z")] },
      ctx(T2),
    );
    expect(again.counts.situation).toMatchObject({ unchanged: 1, updated: 0 });
    const expiry = async () => {
      const [row] = await sql`
        SELECT expires_at, record #>> '{freshness,expiresAt}' AS stated, revision
          FROM conditions.situation WHERE id = 'oc:situation:nl-ndw-events:a'`;
      return row;
    };
    expect(await expiry()).toEqual({
      expires_at: new Date("2026-10-01T10:30:00Z"),
      stated: "2026-10-01T10:30:00Z",
      revision: 1,
    });
    await writeSnapshot(sql, "nl-ndw-events", { situations: [until()] }, ctx(T3));
    expect(await expiry()).toEqual({ expires_at: null, stated: null, revision: 1 });
    expect(await revisions("situation", "oc:situation:nl-ndw-events:a")).toHaveLength(1);
  });

  it("stores new records with their first revision, effects, components and relations", async () => {
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a"), roadworksDraft("w")] },
      ctx(T1),
    );
    expect(summary.counts.situation).toMatchObject({ created: 2, unchanged: 0 });
    expect(summary.rejected).toEqual([]);

    const [row] = await sql`
      SELECT revision, recorded_at, kind, type, severity, certainty, planned, source_id,
        instance_id, ST_AsText(geom) AS geom, country
      FROM conditions.situation WHERE id = 'oc:situation:nl-ndw-events:a'`;
    expect(row).toMatchObject({
      revision: 1,
      kind: "incident",
      type: "accident",
      severity: "major",
      certainty: "observed",
      planned: false,
      source_id: "nl-ndw-events",
      instance_id: "test.local",
      geom: "POINT(4.9 52.37)",
      country: "NL",
    });
    expect(await revisions("situation", "oc:situation:nl-ndw-events:a")).toEqual([
      { revision: 1, change_kinds: ["created"] },
    ]);

    const effects = await sql`
      SELECT situation_id, effect_id, phase_id, kind, valid_from, valid_to
      FROM conditions.situation_effect ORDER BY situation_id`;
    expect(effects).toEqual([
      {
        situation_id: "oc:situation:nl-ndw-events:a",
        effect_id: "a/closure",
        phase_id: "",
        kind: "closure",
        valid_from: new Date("2026-10-01T09:00:00Z"),
        valid_to: null,
      },
      {
        situation_id: "oc:situation:nl-ndw-events:w",
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
        to_id: "oc:situation:nl-ndw-events:works",
        component_key: "",
      },
    ]);
  });

  it("writes nothing for unchanged content and keeps the first fetch time", async () => {
    await writeSnapshot(sql, "nl-ndw-events", { situations: [situationDraft("a")] }, ctx(T1));
    const again = situationDraft("a", { freshness: { fetchedAt: "2026-10-01T10:01:00.000Z" } });
    const summary = await writeSnapshot(sql, "nl-ndw-events", { situations: [again] }, ctx(T2));
    expect(summary.counts.situation).toMatchObject({ unchanged: 1, updated: 0 });
    expect(summary.changed).toEqual([]);
    const [row] = await sql`SELECT revision, record->'freshness'->>'fetchedAt' AS fetched
      FROM conditions.situation`;
    expect(row).toEqual({ revision: 1, fetched: "2026-10-01T10:00:00.000Z" });
  });

  it("revises changed content, naming what changed", async () => {
    await writeSnapshot(sql, "nl-ndw-events", { situations: [situationDraft("a")] }, ctx(T1));
    const worse = situationDraft("a", {
      severity: { label: "critical", source: "declared", declaredRaw: "highest" },
    });
    const summary = await writeSnapshot(sql, "nl-ndw-events", { situations: [worse] }, ctx(T2));
    expect(summary.counts.situation).toMatchObject({ updated: 1 });
    expect(await revisions("situation", "oc:situation:nl-ndw-events:a")).toEqual([
      { revision: 1, change_kinds: ["created"] },
      { revision: 2, change_kinds: ["severity_change"] },
    ]);
    const [row] = await sql`SELECT severity, revision, recorded_at FROM conditions.situation`;
    expect(row).toEqual({ severity: "critical", revision: 2, recorded_at: new Date(T2) });
  });

  it("tombstones what a complete snapshot no longer holds, and restores it when it returns", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a"), situationDraft("b")] },
      ctx(T1),
    );
    const gone = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a")] },
      ctx(T2),
    );
    expect(gone.counts.situation).toMatchObject({ unchanged: 1, withdrawn: 1 });
    const [b] = await sql`
      SELECT tombstone_reason, tombstoned_at, revision, record->'tombstone' AS tombstone
      FROM conditions.situation WHERE id = 'oc:situation:nl-ndw-events:b'`;
    expect(b).toEqual({
      tombstone_reason: "withdrawn",
      tombstoned_at: new Date(T2),
      revision: 2,
      tombstone: { reason: "withdrawn", at: T2 },
    });
    const [{ effects }] = await sql`SELECT count(*)::int AS effects FROM conditions.situation_effect
      WHERE situation_id = 'oc:situation:nl-ndw-events:b'`;
    expect(effects).toBe(0);

    const back = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a"), situationDraft("b")] },
      ctx(T3),
    );
    expect(back.counts.situation).toMatchObject({ restored: 1, unchanged: 1 });
    expect(await revisions("situation", "oc:situation:nl-ndw-events:b")).toEqual([
      { revision: 1, change_kinds: ["created"] },
      { revision: 2, change_kinds: ["tombstoned"] },
      { revision: 3, change_kinds: ["created"] },
    ]);
    const [restored] = await sql`SELECT tombstone_reason, record ? 'tombstone' AS has_tombstone
      FROM conditions.situation WHERE id = 'oc:situation:nl-ndw-events:b'`;
    expect(restored).toEqual({ tombstone_reason: null, has_tombstone: false });
  });

  it("leaves a peer's copy for the peer to withdraw", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a"), situationDraft("b")] },
      { ...ctx(T1), instanceId: "peer.example" },
    );
    const own = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a")] },
      ctx(T2),
    );
    expect(own.counts.situation.withdrawn).toBe(0);
    const [b] = await sql`SELECT tombstoned_at, instance_id FROM conditions.situation
      WHERE id = 'oc:situation:nl-ndw-events:b'`;
    expect(b).toEqual({ tombstoned_at: null, instance_id: "peer.example" });
  });

  it("withdraws nothing from a partial snapshot", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a"), situationDraft("b")] },
      ctx(T1),
    );
    const partial = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a")] },
      ctx(T2, false),
    );
    expect(partial.counts.situation.withdrawn).toBe(0);
    const [{ live }] = await sql`SELECT count(*)::int AS live FROM conditions.situation
      WHERE tombstoned_at IS NULL`;
    expect(live).toBe(2);
  });

  it("withdraws only the classes a snapshot holds in full", async () => {
    const flowSituation = (local: string) => {
      const draft = situationDraft(local);
      return {
        ...draft,
        id: `oc:situation:nl-ndw-flow:${local}`,
        provenance: { ...(draft["provenance"] as object), sourceId: "nl-ndw-flow" },
      };
    };
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        features: [featureDraft("s1"), featureDraft("s2")],
        situations: [flowSituation("a")],
      },
      ctx(T1),
    );
    const next = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { features: [featureDraft("s1")], situations: [] },
      { ...ctx(T2), complete: { situation: true } },
    );
    expect(next.counts.feature).toMatchObject({ unchanged: 1, withdrawn: 0 });
    expect(next.counts.situation).toMatchObject({ withdrawn: 1 });
    const live =
      await sql`SELECT id FROM conditions.feature WHERE tombstoned_at IS NULL ORDER BY id`;
    expect(live.map((r) => r["id"])).toEqual([
      "oc:feature:nl-ndw-flow:s1",
      "oc:feature:nl-ndw-flow:s2",
    ]);
  });

  it("refuses a poll holding more records of a class than a source may publish", async () => {
    await expect(
      writeSnapshot(
        sql,
        "nl-ndw-flow",
        { features: [featureDraft("s1"), featureDraft("s2"), featureDraft("s3")] },
        { ...ctx(T1), maxRowsPerClass: 2 },
      ),
    ).rejects.toThrow(/3 feature rows, exceeding publication limit 2/);
    await expect(
      writeSnapshot(
        sql,
        "nl-ndw-events",
        { situations: [situationDraft("a"), situationDraft("b"), situationDraft("c")] },
        { ...ctx(T1), maxRowsPerClass: 2 },
      ),
    ).rejects.toThrow(/3 situation rows, exceeding publication limit 2/);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM conditions.feature`;
    expect(n).toBe(0);
  });

  it("publishes a first poll of more sites than the lock table holds", async () => {
    // A transaction's advisory locks share max_locks_per_transaction × max_connections
    // slots (6400 by default, with some slack); NDW's first poll writes ~30k sites.
    const sites = Array.from({ length: 30_000 }, (_, i) => featureDraft(`s${i}`, 1));
    const summary = await writeSnapshot(sql, "nl-ndw-flow", { features: sites }, ctx(T1, false));
    expect(summary.counts.feature.created).toBe(30_000);
  }, 240_000);

  it("rejects an invalid draft without losing the rest of the poll or its stored version", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a"), situationDraft("b")] },
      ctx(T1),
    );
    const broken = situationDraft("b", { kind: "volcano" });
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("a"), broken, situationDraft("c")] },
      ctx(T2),
    );
    expect(summary.counts.situation).toMatchObject({ created: 1, unchanged: 1, withdrawn: 0 });
    expect(summary.rejected.map((r) => r.id)).toEqual(["oc:situation:nl-ndw-events:b"]);
    const [b] = await sql`SELECT kind, tombstone_reason FROM conditions.situation
      WHERE id = 'oc:situation:nl-ndw-events:b'`;
    expect(b).toEqual({ kind: "incident", tombstone_reason: null });
  });

  it("stores a record a poll repeats once, as its last copy says", async () => {
    const first = situationDraft("dup", { certainty: "possible" });
    const last = situationDraft("dup", { certainty: "observed" });
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [first, last] },
      ctx(T1),
    );
    expect(summary.counts.situation).toMatchObject({ created: 1 });
    const rows = await sql`SELECT certainty FROM conditions.situation`;
    expect(rows).toEqual([{ certainty: "observed" }]);
    expect(await revisions("situation", "oc:situation:nl-ndw-events:dup")).toEqual([
      { revision: 1, change_kinds: ["created"] },
    ]);
  });

  it("rejects a draft of another source, or one with a field no schema has", async () => {
    const foreign = situationDraft("x", {
      provenance: {
        ...(situationDraft("x")["provenance"] as object),
        sourceId: "be-flanders-events",
      },
    });
    const stray = situationDraft("y", { colour: "red" });
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [foreign, stray] },
      ctx(T1),
    );
    expect(summary.rejected.map((r) => r.id)).toEqual([
      "oc:situation:nl-ndw-events:x",
      "oc:situation:nl-ndw-events:y",
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
      "nl-ndw-events",
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
