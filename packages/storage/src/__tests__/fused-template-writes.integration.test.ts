import { observationId } from "@openconditions/model";
import { createTestDatabase } from "@openconditions/test-database";
import { expect, it } from "vitest";
import { refreshFused } from "../fused-rows.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { syncSources } from "../sources.js";
import { writeObservationsIn } from "../write-observations.js";
import { type Rejection, writeSnapshot } from "../write-records.js";
import { goldenFacilities, polled, registry } from "./facility-fixtures.js";
import { lookupDrafts } from "./latest-lookup-fixture.js";

type Rec = Record<string, unknown>;

it("refreshes fused points without rewriting unchanged static credit", async () => {
  const db = await createTestDatabase({ pool: { max: 1 } });
  const sql = db.sql;
  const source = "es-minetur-fuel",
    now = "2026-11-04T00:00:00.000Z";
  const ctx = { registry, instanceId: "fusion.local", complete: false, now };
  try {
    await ensureObservationPartitions(sql, {
      classes: retentionClasses(registry),
      now: new Date(now),
    });
    await syncSources(sql, [
      {
        id: source,
        domain: "facilities",
        format: "minetur",
        product: "facilities",
        tier: "authoritative",
        country: "ES",
        operator: "Publisher",
        license: "CC0-1.0",
        attribution: "Publisher",
        restricted: false,
        cadenceSec: 300,
        freshnessWindowSec: 900,
      },
    ]);
    await polled(sql, source, now);
    // Keep the regression causal even when PostgreSQL can compress a small fixture inline.
    await sql`ALTER TABLE conditions.observation_latest ALTER COLUMN template SET STORAGE EXTERNAL`;
    const fixture = goldenFacilities().get(source)!;
    const station = fixture.features.find((f) => f["id"] === `oc:feature:${source}:3119`)!;
    const original = fixture.observations.find(
      (o) => (o["subject"] as Rec)["featureId"] === station["id"] && o["property"] === "fuel.price",
    )!;
    const credit = lookupDrafts(1, 0)[0]!["provenance"] as Rec;
    const draft = (cycle: number, provider?: string, timeCycle = cycle) => {
      const at = new Date(Date.parse(now) + timeCycle * 300_000).toISOString();
      const value: Rec = {
        ...original,
        result: {
          type: "money",
          amount: (1.649 + cycle * 0.01).toFixed(3),
          currency: "EUR",
          per: "L",
        },
        phenomenonTime: { instant: at },
        freshness: { fetchedAt: at },
        provenance: {
          ...(original["provenance"] as Rec),
          attribution: { ...(credit["attribution"] as Rec), ...(provider ? { provider } : {}) },
          upstream: credit["upstream"],
        },
      };
      value["id"] = observationId(source, value as Parameters<typeof observationId>[1]);
      return value;
    };
    const seed = await writeSnapshot(
      sql,
      source,
      { features: [station], observations: [draft(0)] },
      ctx,
    );
    expect(seed.rejected).toEqual([]);
    const [canonical] =
      await sql`SELECT canonical_feature_id FROM conditions.feature_canonical WHERE ${station["id"] as string}=ANY(member_ids)`;
    const fused = async () =>
      (
        await sql`SELECT template_hash, pg_column_size(template)::int AS bytes,
      conditions.observation_record(template,reading) AS record FROM conditions.observation_latest
      WHERE source_id='@fused' AND feature_id=${canonical!["canonical_feature_id"]}`
      )[0]!;
    const before = await fused();
    expect(before["bytes"]).toBeGreaterThan(1200);
    const toastInserts = async () => {
      await sql`SELECT pg_stat_force_next_flush()`;
      await sql`SELECT pg_stat_clear_snapshot()`;
      const [r] =
        await sql`SELECT n_tup_ins FROM pg_stat_all_tables WHERE relid=(SELECT reltoastrelid FROM pg_class WHERE oid='conditions.observation_latest'::regclass)`;
      return Number(r!["n_tup_ins"]);
    };
    const [toastRelation] =
      await sql`SELECT reltoastrelid::regclass::text AS name FROM pg_class WHERE oid='conditions.observation_latest'::regclass`;
    const toastName = toastRelation!["name"] as string;
    if (!/^pg_toast\.pg_toast_[0-9]+$/.test(toastName))
      throw new Error("Unexpected owned TOAST relation");
    const toastValues = () =>
      sql.unsafe<{ id: string; bytes: number; chunks: number }[]>(
        `SELECT chunk_id::text AS id, sum(octet_length(chunk_data))::int AS bytes, count(*)::int AS chunks FROM ${toastName} GROUP BY chunk_id ORDER BY chunk_id`,
      );
    const move = async (cycle: number, provider?: string, timeCycle = cycle) => {
      const value = draft(cycle, provider, timeCycle),
        at = new Date(Date.parse(now) + timeCycle * 300_000).toISOString();
      const rejected: Rejection[] = [];
      await sql.begin((tx) =>
        writeObservationsIn(tx, source, [value], { ...ctx, now: at }, rejected),
      );
      expect(rejected).toEqual([]);
      const n = await toastInserts();
      const beforeValues = await toastValues();
      const counts = await sql.begin((tx) =>
        refreshFused(tx, registry, [{ featureId: canonical!["canonical_feature_id"] }], {
          instanceId: ctx.instanceId,
          now: at,
          freshSources: [source],
        }),
      );
      expect(counts).toMatchObject({ written: 1, deleted: 0 });
      return {
        row: await fused(),
        chunks: (await toastInserts()) - n,
        input: value,
        at,
        beforeValues,
        afterValues: await toastValues(),
      };
    };
    const stable = await move(1);
    expect(stable.row["template_hash"]).toBe(before["template_hash"]);
    const large = (rows: typeof stable.beforeValues) => rows.filter((row) => row.bytes > 1200);
    expect(large(stable.afterValues)).toEqual(large(stable.beforeValues));
    // A changing lineage array can itself be toasted. Every inserted chunk
    // must belong to a new live value, not to a needless template rewrite.
    const oldIds = new Set(stable.beforeValues.map((row) => row.id));
    const newChunks = stable.afterValues
      .filter((row) => !oldIds.has(row.id))
      .reduce((n, row) => n + row.chunks, 0);
    expect(stable.chunks).toBe(newChunks);
    expect(stable.row["record"]).toMatchObject({
      result: { amount: "1.659" },
      phenomenonTime: { instant: stable.at },
      provenance: { derivedFrom: { records: [{ class: "observation", id: stable.input["id"] }] } },
    });
    const corrected = await move(2, undefined, 1);
    expect(corrected.row["template_hash"]).toBe(stable.row["template_hash"]);
    expect(corrected.row["record"]).toMatchObject({
      id: (stable.row["record"] as Rec)["id"],
      result: { amount: "1.669" },
      phenomenonTime: { instant: stable.at },
      sinceAt: stable.at,
      provenance: { derivedFrom: { records: [{ class: "observation", id: stable.input["id"] }] } },
    });
    const changed = await move(3, "New publisher");
    expect(changed.chunks).toBeGreaterThan(0);
    expect(changed.row["template_hash"]).not.toBe(stable.row["template_hash"]);
    expect(changed.row["record"]).toMatchObject({
      provenance: { attribution: { provider: "New publisher" } },
    });
  } finally {
    await db.close();
  }
}, 120_000);
