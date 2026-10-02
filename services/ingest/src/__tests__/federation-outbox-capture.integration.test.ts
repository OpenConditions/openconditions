import { observationId } from "@openconditions/model";
import type { FeedSource } from "@openconditions/roads";
import {
  ensureObservationPartitions,
  retentionClasses,
  writeSnapshot,
} from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishSituations, writeModel } from "../pipeline/publish.js";
import { openPollAttempt } from "../pipeline/source-status.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { registry, situationDraft } from "./helpers/situations.js";

type Rec = Record<string, unknown>;

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

const SOURCE = "de-autobahn";
const FLOW_SOURCE = "nl-ndw-flow";
const INSTANCE = "test.local";
const src = { id: SOURCE, freshnessWindowSec: 900 } as unknown as FeedSource;
const closureId = `oc:situation:${SOURCE}:A46`;

interface JournalRow {
  record_class: string;
  record_id: string;
  operation: string;
  kind: string;
  property: string | null;
  priority: boolean;
  revision: number | null;
  tombstone_reason: string | null;
}

async function journal(recordClass = "situation"): Promise<JournalRow[]> {
  return sql<JournalRow[]>`
    SELECT record_class, record_id, operation, kind, property, priority,
           (snapshot ->> 'revision')::int AS revision, tombstone_reason
    FROM conditions.federation_outbox
    WHERE record_class = ${recordClass}
    ORDER BY seq ASC`;
}

/** One complete poll of the Autobahn feed, published as the ingest run does. */
async function poll(situations: Rec[], now: string): Promise<void> {
  const id = await openPollAttempt(sql, SOURCE, now);
  const summary = await publishSituations(sql, src, {
    situations,
    rejected: 0,
    poll: { at: now, id },
    durationMs: 1,
    now,
    model: writeModel({ registry, instanceId: INSTANCE }),
  });
  expect(summary.rejected).toEqual([]);
}

/** One flow reading of an NDW measurement site, as a flow poll writes it. */
async function flowReading(speed: number, at: string): Promise<void> {
  const draft: Rec = {
    class: "observation",
    kind: "observation",
    property: "traffic.speed",
    subject: { kind: "feature", featureId: `oc:feature:${FLOW_SOURCE}:s1` },
    result: { type: "quantity", value: speed, unit: "km/h" },
    phenomenonTime: { instant: at },
    aggregation: "mean",
    temporality: "live",
    location: {
      geometry: { type: "Point", coordinates: [4.9, 52.4] },
      extent: "point",
      geometryOrigin: "site_table",
      fuzziness: "exact",
    },
    provenance: {
      origin: "feed",
      sourceId: FLOW_SOURCE,
      sourceFormat: "datex2",
      accessMode: "bulk",
      recordId: "s1",
      attribution: { provider: "NDW", license: "CC0-1.0" },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: at },
  };
  draft["id"] = observationId(FLOW_SOURCE, draft as Parameters<typeof observationId>[1]);
  const summary = await writeSnapshot(
    sql,
    FLOW_SOURCE,
    { observations: [draft] },
    { registry, instanceId: INSTANCE, now: at, complete: true },
  );
  expect(summary.rejected).toEqual([]);
  expect(summary.observations.latest).toBe(1);
}

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date("2026-09-06T10:00:00Z"),
  });
  // The capture journals only for a subscriber: an instance without peers
  // must not journal its feed churn. This one wants every class, and names
  // no observation property.
  await sql`
    INSERT INTO conditions.federation_subscription
      (id, peer_id, delivery_mode, created_at, updated_at)
    VALUES ('sub-capture', 'peer-capture', 'pull', now(), now())`;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("federation outbox capture through the ingest situation path", () => {
  it("journals a create for a new situation, flagged priority for a closure", async () => {
    await poll([situationDraft("A46")], "2026-09-06T10:00:00.000Z");
    expect(await journal()).toEqual([
      {
        record_class: "situation",
        record_id: closureId,
        operation: "create",
        kind: "closure",
        property: null,
        priority: true,
        revision: 1,
        tombstone_reason: null,
      },
    ]);
  }, 30_000);

  it("journals nothing for a poll that leaves the situation unchanged", async () => {
    await poll([situationDraft("A46")], "2026-09-06T10:05:00.000Z");
    expect(await journal()).toHaveLength(1);
  }, 30_000);

  it("journals an update at the new revision when the situation changes", async () => {
    const changed = situationDraft("A46", {
      headline: [{ lang: "de", text: "A 46 zwischen Kreuz Hilden und Haan-Ost gesperrt" }],
    });
    await poll([changed], "2026-09-06T10:10:00.000Z");
    const entries = await journal();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      record_id: closureId,
      operation: "update",
      revision: 2,
      tombstone_reason: null,
    });
  }, 30_000);

  it("journals a delete with reason withdrawn when the feed drops the situation", async () => {
    await poll([], "2026-09-06T10:15:00.000Z");
    const entries = await journal();
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({
      record_id: closureId,
      operation: "delete",
      kind: "closure",
      revision: null,
      tombstone_reason: "withdrawn",
    });
  }, 30_000);

  it("journals no flow measurement for subscribers that do not name its property", async () => {
    await flowReading(81, "2026-09-06T10:00:00.000Z");
    await flowReading(64, "2026-09-06T10:01:00.000Z");
    expect(await journal("observation")).toEqual([]);
  }, 30_000);

  it("journals a flow measurement once a subscription names its property", async () => {
    await sql`
      INSERT INTO conditions.federation_subscription
        (id, peer_id, delivery_mode, filter, created_at, updated_at)
      VALUES ('sub-speed', 'peer-speed', 'pull',
        ${sql.json({ classes: ["observation"], properties: ["traffic.speed"] })}, now(), now())`;
    await flowReading(52, "2026-09-06T10:02:00.000Z");
    expect(await journal("observation")).toEqual([
      expect.objectContaining({
        record_class: "observation",
        operation: "update",
        kind: "observation",
        property: "traffic.speed",
      }),
    ]);
  }, 30_000);
});
