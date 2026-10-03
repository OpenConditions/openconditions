import { seriesKeyOf } from "@openconditions/core";
import {
  readLatestObservation,
  readObservationHistory,
  readRecord,
  readRevisions,
} from "@openconditions/core/server";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { observationDraft, situationDraft } from "./drafts.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const T1 = "2026-10-01T10:00:05.000Z";
const T2 = "2026-10-01T10:05:05.000Z";
const PAYLOAD = "d".repeat(64);

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

const ctx = (now: string) => ({ registry, instanceId: "test.local", now, complete: true });

describe("record readers", () => {
  it("read a stored record and its revisions, oldest first", async () => {
    await writeSnapshot(sql, "nl-ndw-events", { situations: [situationDraft("a")] }, ctx(T1));
    const worse = situationDraft("a", { certainty: "likely" });
    await writeSnapshot(sql, "nl-ndw-events", { situations: [worse] }, ctx(T2));
    const record = await readRecord(sql, "situation", "oc:situation:nl-ndw-events:a");
    expect(record).toMatchObject({ certainty: "likely", revision: 2, recordedAt: T2 });
    expect(record).not.toHaveProperty("evidence");
    const revisions = await readRevisions(sql, "situation", "oc:situation:nl-ndw-events:a");
    expect(revisions.map((r) => [r.revision, r.changeKinds, r.record["certainty"]])).toEqual([
      [1, ["created"], "observed"],
      [2, ["classification_change"], "likely"],
    ]);
    expect(await readRecord(sql, "situation", "oc:situation:nl-ndw-events:none")).toBeUndefined();
  });

  it("merge a situation's materialised evidence back into it", async () => {
    await sql`UPDATE conditions.situation
      SET evidence_state = 'corroborated', confidence_score = 0.8, routing_eligible = false,
          corroborations = 2
      WHERE id = 'oc:situation:nl-ndw-events:a'`;
    expect(
      (await readRecord(sql, "situation", "oc:situation:nl-ndw-events:a"))?.["evidence"],
    ).toEqual({
      state: "corroborated",
      confidenceScore: 0.8,
      routingEligible: false,
      corroborations: 2,
    });
  });

  it("read a series' latest reading and its history, with the payload each came from", async () => {
    const [{ id: fetchId }] = await sql`
      INSERT INTO conditions.source_poll_attempt (source, attempted_at, finished_at, outcome,
        network_validated, published, payload_hashes)
      VALUES ('nl-ndw-flow', ${T1}, ${T1}, 'changed', true, true, ARRAY[${PAYLOAD}]) RETURNING id`;
    const reading = (value: number, at: string) =>
      observationDraft(
        "traffic.speed",
        { type: "quantity", value, unit: "km/h" },
        {
          at,
          provenance: {
            ...(observationDraft("traffic.speed", {})["provenance"] as object),
            rawRef: { hash: PAYLOAD },
          },
        },
      );
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [
          reading(90, "2026-10-01T09:58:00.000Z"),
          reading(70, "2026-10-01T09:59:00.000Z"),
        ],
      },
      { ...ctx(T1), fetchId: Number(fetchId), payloadHashes: [PAYLOAD] },
    );
    const key = seriesKeyOf(reading(70, "2026-10-01T09:59:00.000Z"));
    expect((await readLatestObservation(sql, key))?.["result"]).toEqual({
      type: "quantity",
      value: 70,
      unit: "km/h",
    });
    const history = await readObservationHistory(sql, registry, key, {
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-02T00:00:00Z",
    });
    expect(history.map((o) => (o["result"] as { value: number }).value)).toEqual([90, 70]);
    expect(history[0]!["provenance"]).toMatchObject({ rawRef: { hash: PAYLOAD } });
  });
});
