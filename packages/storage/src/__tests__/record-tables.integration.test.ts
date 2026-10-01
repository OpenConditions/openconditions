import {
  ACCESS_MODES,
  LIFECYCLES,
  ORIGINS,
  PRIVACY_CLASSES,
  TEMPORALITIES,
  TOMBSTONE_REASONS,
} from "@openconditions/model";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "./database.integration.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

interface Overrides {
  temporality?: string;
  origin?: string;
  access_mode?: string;
  privacy_class?: string;
  tombstone_reason?: string | null;
  tombstoned_at?: string | null;
  lifecycle?: string;
}

/** A feature row with only its required columns; the record body is irrelevant here. */
async function insertFeature(id: string, o: Overrides = {}) {
  await sql`
    INSERT INTO conditions.feature (id, record, canonical_id, kind, domain, temporality,
      source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
      recorded_at, content_hash, fetched_at, lifecycle, tombstone_reason, tombstoned_at)
    VALUES (${id}, '{}'::jsonb, 'c', 'measurement_site', 'roads', ${o.temporality ?? "static"},
      'nl-ndw-flow', ${id}, ${o.origin ?? "feed"}, ${o.access_mode ?? "bulk"},
      ${o.privacy_class ?? "authoritative"}, 'local', 1, now(), 'h', now(),
      ${o.lifecycle ?? "operational"}, ${o.tombstone_reason ?? null}, ${o.tombstoned_at ?? null})`;
}

describe("class tables", () => {
  it("accept every value of the kernel's closed vocabularies", async () => {
    let n = 0;
    for (const temporality of TEMPORALITIES) await insertFeature(`t${n++}`, { temporality });
    for (const origin of ORIGINS) await insertFeature(`t${n++}`, { origin });
    for (const access_mode of ACCESS_MODES) await insertFeature(`t${n++}`, { access_mode });
    for (const privacy_class of PRIVACY_CLASSES) await insertFeature(`t${n++}`, { privacy_class });
    for (const lifecycle of LIFECYCLES) await insertFeature(`t${n++}`, { lifecycle });
    for (const tombstone_reason of TOMBSTONE_REASONS) {
      await insertFeature(`t${n++}`, { tombstone_reason, tombstoned_at: "2026-10-01T00:00:00Z" });
    }
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM conditions.feature`;
    expect(count).toBe(n);
    await sql`DELETE FROM conditions.feature`;
  });

  it("reject values the kernel does not define", async () => {
    await expect(insertFeature("bad1", { temporality: "historic" })).rejects.toThrow(
      /feature_temporality_enum/,
    );
    await expect(insertFeature("bad2", { privacy_class: "unknown" })).rejects.toThrow(
      /feature_privacy_class_enum/,
    );
    await expect(insertFeature("bad3", { lifecycle: "closed" })).rejects.toThrow(
      /feature_lifecycle_enum/,
    );
    await expect(
      insertFeature("bad4", {
        tombstone_reason: "deleted_by_source",
        tombstoned_at: "2026-10-01T00:00:00Z",
      }),
    ).rejects.toThrow(/feature_tombstone_reason_enum/);
  });

  it("require a tombstone to carry both its reason and its time", async () => {
    await expect(insertFeature("half", { tombstone_reason: "withdrawn" })).rejects.toThrow(
      /feature_tombstone_complete/,
    );
  });

  it("delete a record's components and revisions with it", async () => {
    await insertFeature("f1");
    await sql`
      INSERT INTO conditions.feature_component (feature_id, key, kind, details, content_hash)
      VALUES ('f1', 'lane1', 'sensor_channel', '{}'::jsonb, 'h')`;
    await sql`
      INSERT INTO conditions.feature_revision (feature_id, revision, recorded_at, change_kinds, snapshot)
      VALUES ('f1', 1, now(), ARRAY['created'], '{}'::jsonb)`;
    await sql`DELETE FROM conditions.feature WHERE id = 'f1'`;
    const [{ components }] =
      await sql`SELECT count(*)::int AS components FROM conditions.feature_component`;
    const [{ revisions }] =
      await sql`SELECT count(*)::int AS revisions FROM conditions.feature_revision`;
    expect([components, revisions]).toEqual([0, 0]);
  });

  it("store each feature link once, its ids in order", async () => {
    await expect(
      sql`INSERT INTO conditions.feature_link (a_id, b_id, method, confidence, status, decided_at)
          VALUES ('b', 'a', 'manual', 1, 'accepted', now())`,
    ).rejects.toThrow(/feature_link_ordered/);
  });
});
