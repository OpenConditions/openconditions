import {
  reconcileFederation,
  syncSources,
  tombstoneRecords,
  writeRecord,
  writeRecordIn,
  writeSnapshot,
} from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  decodeOutboxCursor,
  encodeOutboxCursor,
  type OutboxCursor,
  readOutbox,
} from "../outbox.js";
import type { RecordOutboxEntry } from "../record-filter.js";
import {
  crowdReportDraft,
  featureDraft,
  featureId,
  incidentDraft,
  laneRestriction,
  offerDraft,
  offerId,
  peerSituation,
  REPORTER_KEY,
  roadworksDraft,
  situationId,
  speedReading,
  startDatabase,
  subscribe,
  WRITTEN_AT,
  writeCtx,
  writeOwn,
} from "./record-fixtures.integration.js";

let db: Awaited<ReturnType<typeof startDatabase>>;
let sql: postgres.Sql;

const LATER = "2026-10-01T10:05:05.000Z";
const NOW = "2026-10-01T10:10:00.000Z";

interface JournalRow {
  seq: string;
  operation: string;
  record_class: string;
  record_id: string;
  canonical_id: string | null;
  kind: string;
  domain: string;
  property: string | null;
  priority: boolean;
  snapshot: Record<string, unknown> | null;
  tombstone_reason: string | null;
}

async function journalFor(recordId: string): Promise<JournalRow[]> {
  return sql<JournalRow[]>`
    SELECT seq::text AS seq, operation, record_class, record_id, canonical_id, kind, domain,
           property, priority, snapshot, tombstone_reason
    FROM conditions.federation_outbox o
    WHERE record_id = ${recordId}
    ORDER BY o.seq ASC`;
}

async function journalSize(): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM conditions.federation_outbox`;
  return count;
}

/** The current maximum committed composite `(txid, seq)` cursor: a baseline
 *  any later (higher-txid) entry sorts strictly after. */
async function frontier(): Promise<OutboxCursor> {
  const [row] = await sql<{ txid: string; seq: string }[]>`
    SELECT txid::text AS txid, seq::text AS seq
    FROM conditions.federation_outbox
    ORDER BY txid DESC, seq DESC
    LIMIT 1`;
  return row ? { txid: row.txid, seq: Number(row.seq) } : { txid: "0", seq: 0 };
}

const cursorOf = (entry: RecordOutboxEntry) =>
  encodeOutboxCursor({ txid: entry.txid, seq: entry.seq });

const ids = (entries: readonly RecordOutboxEntry[]) => entries.map((e) => e.recordId);

/** A tombstone of stored records, in its own transaction, as the sweep or an erasure writes it. */
async function tombstone(cls: "situation" | "feature" | "offer", id: string, reason: string) {
  await sql.begin((tx) => tombstoneRecords(tx, cls, [id], reason, writeCtx(LATER)));
}

/** Sets a crowd report's evidence columns, as the evidence recompute does. */
async function setEvidence(id: string, state: string, corroborations: number) {
  await sql`
    UPDATE conditions.situation
    SET evidence_state = ${state}, confidence_score = ${0.2 * (corroborations + 1)},
        routing_eligible = ${state !== "self_reported"}, corroborations = ${corroborations}
    WHERE id = ${id}`;
}

beforeAll(async () => {
  db = await startDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.feature, conditions.offer,
    conditions.observation_latest, conditions.federation_outbox CASCADE`;
  await sql`DELETE FROM conditions.federation_subscription`;
  await subscribe(sql, "all");
});

describe("capture is gated on a subscription that wants the record", () => {
  // Regression: an ungated capture journalled the whole feed churn of an
  // instance with no peers, which nothing read and nothing pruned.
  it("journals nothing while no peer subscribes", async () => {
    await sql`DELETE FROM conditions.federation_subscription`;
    await writeOwn(sql, incidentDraft("nosub"));
    await writeOwn(sql, featureDraft("nosub"));
    await writeOwn(sql, offerDraft("nosub"));
    await tombstone("situation", situationId("nosub"), "withdrawn");
    expect(await journalSize()).toBe(0);
  });

  it("journals nothing of a class no subscription names", async () => {
    await sql`DELETE FROM conditions.federation_subscription`;
    await subscribe(sql, "features", { classes: ["feature"] });
    await writeOwn(sql, incidentDraft("other-class"));
    await writeOwn(sql, offerDraft("other-class"));
    expect(await journalSize()).toBe(0);
    await writeOwn(sql, featureDraft("named-class"));
    expect((await journalFor(featureId("named-class"))).map((e) => e.operation)).toEqual([
      "create",
    ]);
  });

  it("starts journalling once a peer subscribes, without replaying what came before", async () => {
    await sql`DELETE FROM conditions.federation_subscription`;
    await writeOwn(sql, incidentDraft("latesub"));
    await subscribe(sql, "late");
    await writeOwn(
      sql,
      incidentDraft("latesub", { severity: { label: "minor", source: "declared" } }),
      LATER,
    );
    expect((await journalFor(situationId("latesub"))).map((e) => e.operation)).toEqual(["update"]);
  });

  it("journals observations only for a subscription naming their property", async () => {
    await writeOwn(sql, speedReading(80, "2026-10-01T10:00:00Z"));
    await subscribe(sql, "situations-and-speed", {
      classes: ["situation"],
      properties: ["traffic.speed"],
    });
    await writeOwn(sql, speedReading(81, "2026-10-01T10:01:00Z"));
    await subscribe(sql, "flow", { classes: ["observation"], properties: ["traffic.flow"] });
    await writeOwn(sql, speedReading(82, "2026-10-01T10:02:00Z"));
    expect(await journalSize()).toBe(0);

    await subscribe(sql, "speed", { classes: ["observation"], properties: ["traffic.speed"] });
    const reading = speedReading(83, "2026-10-01T10:03:00Z");
    await writeOwn(sql, reading);
    const [entry] = await journalFor(reading["id"] as string);
    expect(entry).toMatchObject({
      operation: "update",
      record_class: "observation",
      kind: "observation",
      property: "traffic.speed",
      priority: false,
    });
    expect(entry!.snapshot).toMatchObject({ id: reading["id"], result: { value: 83 } });
    expect(entry!.domain).toBe(entry!.snapshot!["domain"]);
  });
});

describe("capture in the writing transaction", () => {
  it("a rolled-back write appends nothing", async () => {
    await expect(
      sql.begin(async (tx) => {
        await writeRecordIn(tx, { draft: incidentDraft("rollback") }, writeCtx());
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await journalFor(situationId("rollback"))).toEqual([]);
    expect(await sql`SELECT id FROM conditions.situation`).toHaveLength(0);
  });

  it("journals a situation's create, update and tombstone with its class, id, kind and domain", async () => {
    const id = situationId("lifecycle");
    await writeOwn(sql, incidentDraft("lifecycle"));
    await writeOwn(
      sql,
      incidentDraft("lifecycle", { severity: { label: "minor", source: "declared" } }),
      LATER,
    );
    await tombstone("situation", id, "withdrawn");

    const entries = await journalFor(id);
    expect(entries.map((e) => e.operation)).toEqual(["create", "update", "delete"]);
    const [stored] = await sql<{ canonical_id: string; domain: string }[]>`
      SELECT canonical_id, domain FROM conditions.situation WHERE id = ${id}`;
    for (const entry of entries) {
      expect(entry).toMatchObject({
        record_class: "situation",
        record_id: id,
        canonical_id: stored!.canonical_id,
        kind: "incident",
        domain: stored!.domain,
        property: null,
      });
    }
    expect(entries.map((e) => e.snapshot?.["revision"])).toEqual([1, 2, undefined]);
    expect(entries[1]!.snapshot!["severity"]).toMatchObject({ label: "minor" });
    expect(entries[2]).toMatchObject({ snapshot: null, tombstone_reason: "withdrawn" });
    const seqs = entries.map((e) => Number(e.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("journals a feature's and an offer's changes the same way", async () => {
    await writeOwn(sql, featureDraft("f1", 2));
    await writeOwn(sql, featureDraft("f1", 3), LATER);
    await tombstone("feature", featureId("f1"), "withdrawn");
    await writeOwn(sql, offerDraft("o1"));
    await writeOwn(sql, offerDraft("o1", "25.00"), LATER);
    await tombstone("offer", offerId("o1"), "superseded");

    const features = await journalFor(featureId("f1"));
    expect(features.map((e) => [e.operation, e.record_class, e.kind])).toEqual([
      ["create", "feature", "measurement_site"],
      ["update", "feature", "measurement_site"],
      ["delete", "feature", "measurement_site"],
    ]);
    expect(features[2]).toMatchObject({ snapshot: null, tombstone_reason: "withdrawn" });
    const offers = await journalFor(offerId("o1"));
    expect(offers.map((e) => [e.operation, e.record_class, e.kind])).toEqual([
      ["create", "offer", "parking_rate"],
      ["update", "offer", "parking_rate"],
      ["delete", "offer", "parking_rate"],
    ]);
    expect(offers[1]!.snapshot!["maxPrice"]).toMatchObject({ amount: "25.00" });
    expect(offers[2]).toMatchObject({ snapshot: null, tombstone_reason: "superseded" });
    expect([...features, ...offers].every((e) => !e.priority)).toBe(true);
  });

  it("journals a restored record as a create", async () => {
    await writeOwn(sql, incidentDraft("restored"));
    await tombstone("situation", situationId("restored"), "withdrawn");
    await writeOwn(sql, incidentDraft("restored"), NOW);
    expect((await journalFor(situationId("restored"))).map((e) => e.operation)).toEqual([
      "create",
      "delete",
      "create",
    ]);
  });

  it("journals nothing for an unchanged write, nor for a feed poll that only slides an expiry", async () => {
    const id = situationId("steady");
    const poll = (expiresAt: string) =>
      writeSnapshot(
        sql,
        "nl-ndw-events",
        {
          situations: [
            incidentDraft("steady", {
              freshness: { fetchedAt: WRITTEN_AT, expiresAt },
            }),
          ],
        },
        { ...writeCtx(), complete: false },
      );
    await poll("2026-10-01T11:00:00.000Z");
    await writeOwn(
      sql,
      incidentDraft("steady", {
        freshness: { fetchedAt: WRITTEN_AT, expiresAt: "2026-10-01T11:00:00.000Z" },
      }),
      LATER,
    );
    await poll("2026-10-01T12:00:00.000Z");

    const [row] = await sql<{ revision: number; expires_at: Date }[]>`
      SELECT revision, expires_at FROM conditions.situation WHERE id = ${id}`;
    expect(row).toEqual({ revision: 1, expires_at: new Date("2026-10-01T12:00:00.000Z") });
    expect((await journalFor(id)).map((e) => e.operation)).toEqual(["create"]);
  });

  it("journals a crowd report's evidence and lifetime, but never a moderation flag", async () => {
    const draft = crowdReportDraft("evidence");
    const { id } = await writeOwn(sql, draft);
    await setEvidence(id, "self_reported", 0);
    await setEvidence(id, "corroborated", 1);
    await sql`UPDATE conditions.situation SET flagged_at = ${NOW} WHERE id = ${id}`;
    await sql`UPDATE conditions.situation SET expires_at = expires_at + interval '10 minutes'
      WHERE id = ${id}`;

    const entries = await journalFor(id);
    expect(entries.map((e) => e.operation)).toEqual(["create", "update", "update", "update"]);
    expect(entries.map((e) => e.snapshot!["revision"])).toEqual([1, 1, 1, 1]);
    expect(entries[0]!.snapshot).not.toHaveProperty("evidence");
    expect(entries[1]!.snapshot!["evidence"]).toEqual({
      state: "self_reported",
      confidenceScore: 0.2,
      routingEligible: false,
      corroborations: 0,
    });
    expect(entries[2]!.snapshot!["evidence"]).toEqual({
      state: "corroborated",
      confidenceScore: 0.4,
      routingEligible: true,
      corroborations: 1,
    });
    expect(entries[3]!.snapshot!["evidence"]).toEqual(entries[2]!.snapshot!["evidence"]);
    expect(JSON.stringify(entries)).not.toContain("flagged");
  });

  it("never journals a peer's record, its update or its tombstone", async () => {
    const ctx = writeCtx();
    expect((await writeRecord(sql, { stored: peerSituation("p1", 1) }, ctx)).status).toBe(
      "created",
    );
    expect((await writeRecord(sql, { stored: peerSituation("p1", 2) }, ctx)).status).toBe(
      "updated",
    );
    const tombstoned = { ...peerSituation("p1", 3), tombstone: { reason: "cancelled", at: LATER } };
    expect((await writeRecord(sql, { stored: tombstoned }, ctx)).status).toBe("updated");
    const [row] = await sql`SELECT instance_id, tombstone_reason FROM conditions.situation`;
    expect(row).toEqual({ instance_id: "peer.example.net", tombstone_reason: "cancelled" });
    expect(await journalSize()).toBe(0);
  });

  it("never journals an on-demand answer", async () => {
    const draft = incidentDraft("on-demand");
    await writeOwn(sql, {
      ...draft,
      provenance: { ...(draft["provenance"] as object), accessMode: "on_demand" },
      freshness: { fetchedAt: WRITTEN_AT, expiresAt: "2026-10-01T10:15:00.000Z" },
    });
    expect(await journalSize()).toBe(0);
  });

  it("an erasure removes the record's earlier entries and keeps the deletes", async () => {
    const id = situationId("erased");
    await writeOwn(sql, incidentDraft("erased"));
    await writeOwn(sql, incidentDraft("bystander"));
    await writeOwn(
      sql,
      incidentDraft("erased", { headline: [{ lang: "nl", text: "Ongeval, Jan de Vries" }] }),
      LATER,
    );
    await tombstone("situation", id, "withdrawn");
    await tombstone("situation", id, "rights_revoked");

    const entries = await journalFor(id);
    expect(entries.map((e) => [e.operation, e.tombstone_reason, e.snapshot])).toEqual([
      ["delete", "withdrawn", null],
      ["delete", "rights_revoked", null],
    ]);
    expect(JSON.stringify(entries)).not.toContain("Jan de Vries");
    expect((await journalFor(situationId("bystander"))).map((e) => e.operation)).toEqual([
      "create",
    ]);
  });

  it("marks priority for a closure, all lanes closed, or an incident", async () => {
    await writeOwn(sql, incidentDraft("incident-no-effects", { effects: [] }));
    await writeOwn(
      sql,
      roadworksDraft("works-closure", {
        effects: [(incidentDraft("works-closure")["effects"] as unknown[])[0]],
      }),
    );
    await writeOwn(
      sql,
      roadworksDraft("works-all-lanes", {
        effects: [laneRestriction("works-all-lanes/now", "all_lanes_closed")],
      }),
    );
    await writeOwn(
      sql,
      roadworksDraft("works-some-lanes", {
        effects: [laneRestriction("works-some-lanes/now", "some_lanes_closed")],
      }),
    );
    await writeOwn(sql, roadworksDraft("works-phased"));

    const priority = async (local: string) => (await journalFor(situationId(local)))[0]!.priority;
    expect(await priority("incident-no-effects")).toBe(true);
    expect(await priority("works-closure")).toBe(true);
    expect(await priority("works-all-lanes")).toBe(true);
    expect(await priority("works-some-lanes")).toBe(false);
    expect(await priority("works-phased")).toBe(false);
  });
});

describe("readOutbox maps journal rows to record entries", () => {
  it("serves a change with its record and a delete with its reason and no record", async () => {
    const base = await frontier();
    const id = situationId("wire");
    await writeOwn(sql, incidentDraft("wire", { lon: 5.3 }));
    await tombstone("situation", id, "withdrawn");

    const page = await readOutbox(sql, { after: base, now: NOW });
    const [change, del] = page.orderedItems;
    const [stored] = await sql<{ canonical_id: string; domain: string }[]>`
      SELECT canonical_id, domain FROM conditions.situation WHERE id = ${id}`;
    expect(change).toMatchObject({
      operation: "create",
      recordClass: "situation",
      recordId: id,
      canonicalId: stored!.canonical_id,
      kind: "incident",
      domain: stored!.domain,
    });
    expect(change).not.toHaveProperty("property");
    expect(change!.record).toMatchObject({
      id,
      class: "situation",
      revision: 1,
      location: { geometry: { type: "Point", coordinates: [5.3, 52.37] } },
      provenance: { instanceId: "test.local", sourceId: "nl-ndw-events" },
    });
    expect(Date.parse(change!.createdAt)).not.toBeNaN();
    expect(del).toMatchObject({
      operation: "delete",
      recordId: id,
      tombstone: true,
      reason: "withdrawn",
    });
    expect(del).not.toHaveProperty("record");
  });

  it("serves an observation with its property", async () => {
    await subscribe(sql, "speed", { classes: ["observation"], properties: ["traffic.speed"] });
    const base = await frontier();
    const reading = speedReading(64, "2026-10-01T10:04:00Z");
    await writeOwn(sql, reading);
    const page = await readOutbox(sql, { after: base, now: NOW });
    expect(page.orderedItems).toHaveLength(1);
    expect(page.orderedItems[0]).toMatchObject({
      recordClass: "observation",
      recordId: reading["id"],
      kind: "observation",
      property: "traffic.speed",
      record: { result: { value: 64 } },
    });
  });

  it("strips the reporter and passes crowd reports only once corroborated, unless asked", async () => {
    const base = await frontier();
    const { id } = await writeOwn(sql, crowdReportDraft("read"));
    const [stored] = await sql<{ record: { provenance: Record<string, unknown> } }[]>`
      SELECT record FROM conditions.situation WHERE id = ${id}`;
    expect(JSON.stringify(stored!.record)).toContain(REPORTER_KEY);
    await setEvidence(id, "self_reported", 0);
    await setEvidence(id, "corroborated", 1);

    const byDefault = await readOutbox(sql, { after: base, now: NOW });
    expect(byDefault.orderedItems.map((e) => e.record?.evidence?.state)).toEqual(["corroborated"]);
    const asked = await readOutbox(sql, {
      after: base,
      now: NOW,
      filter: { minEvidenceTier: "self_reported" },
    });
    expect(asked.orderedItems.map((e) => e.record?.evidence?.state)).toEqual([
      "self_reported",
      "corroborated",
    ]);
    expect(JSON.stringify([byDefault, asked])).not.toContain(REPORTER_KEY);
    for (const entry of asked.orderedItems) {
      expect(entry.record!.provenance).not.toHaveProperty("reporter");
    }
    expect(byDefault.highWaterMark).toBe(asked.highWaterMark);
  });

  it("carries a record's extras only from a source that federates them", async () => {
    const source = (id: string, extrasFederate: boolean) => ({
      id,
      domain: "roads",
      format: "datex2",
      product: "events",
      tier: "authoritative",
      country: "NL",
      operator: "Test",
      license: "CC0-1.0",
      attribution: "Test",
      restricted: false,
      cadenceSec: 60,
      freshnessWindowSec: 600,
      extrasAllow: ["situationRecordExtension"],
      extrasFederate,
    });
    await syncSources(sql, [source("nl-ndw-events", false), source("nl-rws", true)]);
    const base = await frontier();
    const extras = { extras: { situationRecordExtension: "x" } };
    await writeOwn(sql, incidentDraft("kept-home", extras));
    await writeOwn(sql, incidentDraft("shared", { ...extras, sourceId: "nl-rws" }));

    const page = await readOutbox(sql, { after: base, now: NOW });
    const byId = new Map(page.orderedItems.map((e) => [e.recordId, e.record]));
    expect(byId.get(situationId("kept-home"))).not.toHaveProperty("extras");
    expect(byId.get(situationId("shared", "nl-rws"))!.extras).toEqual({
      situationRecordExtension: "x",
    });
  });

  it("withholds a restricted source's changes journalled before it turned restricted, but not their deletes", async () => {
    const source = (id: string, restricted: boolean) => ({
      id,
      domain: "roads",
      format: "datex2",
      product: id === "nl-ndw-flow" ? "flow" : "events",
      tier: "authoritative",
      country: "NL",
      operator: "Test",
      license: "CC0-1.0",
      attribution: "Test",
      restricted,
      cadenceSec: 60,
      freshnessWindowSec: 600,
    });
    const sync = (restricted: boolean) =>
      syncSources(sql, [
        source("nl-ndw-events", restricted),
        source("nl-ndw-flow", restricted),
        source("nl-rws", false),
      ]);
    await sync(false);
    const base = await frontier();
    await writeOwn(sql, incidentDraft("turned-restricted"));
    await writeOwn(sql, incidentDraft("ended-before"));
    await subscribe(sql, "speed", { classes: ["observation"], properties: ["traffic.speed"] });
    await writeOwn(sql, speedReading(80, "2026-10-01T10:00:00Z"));
    await writeOwn(sql, incidentDraft("public", { sourceId: "nl-rws" }));
    await tombstone("situation", situationId("ended-before"), "cancelled");
    try {
      await sync(true);
      const page = await readOutbox(sql, { after: base, now: NOW });
      expect(page.orderedItems.map((e) => [e.operation, e.recordId])).toEqual([
        ["create", situationId("public", "nl-rws")],
        ["delete", situationId("ended-before")],
      ]);
      // The cursor still passes every withheld entry. It may run past the
      // newest entry, as other transactions in the container move the fence.
      const entries = await sql<{ txid: string; seq: string }[]>`
        SELECT txid::text AS txid, seq::text AS seq FROM conditions.federation_outbox`;
      const mark = decodeOutboxCursor(page.highWaterMark)!;
      const passed = (e: { txid: string; seq: string }) =>
        BigInt(e.txid) < BigInt(mark.txid) ||
        (BigInt(e.txid) === BigInt(mark.txid) && Number(e.seq) <= mark.seq);
      expect(entries.length).toBeGreaterThan(page.orderedItems.length);
      expect(entries.filter((e) => !passed(e))).toEqual([]);
    } finally {
      await sync(false);
    }
  });

  it("serves nothing of a record erased while its source was restricted, once the source turns public", async () => {
    const source = (restricted: boolean) => ({
      id: "nl-ndw-events",
      domain: "roads",
      format: "datex2",
      product: "events",
      tier: "authoritative",
      country: "NL",
      operator: "Test",
      license: "CC0-1.0",
      attribution: "Test",
      restricted,
      cadenceSec: 60,
      freshnessWindowSec: 600,
    });
    await syncSources(sql, [source(false)]);
    await sql`UPDATE conditions.source SET federation_restricted = restricted`;
    const id = situationId("erased-restricted");
    await writeOwn(
      sql,
      incidentDraft("erased-restricted", {
        headline: [{ lang: "nl", text: "Ongeval, Jan de Vries" }],
      }),
    );
    try {
      await syncSources(sql, [source(true)]);
      await reconcileFederation(sql);
      await tombstone("situation", id, "rights_revoked");
      await syncSources(sql, [source(false)]);
      await reconcileFederation(sql);

      const page = await readOutbox(sql, { now: NOW });
      const served = page.orderedItems.filter((e) => e.recordId === id);
      expect(served.map((e) => [e.operation, e.reason])).toEqual([
        ["delete", "withdrawn"],
        ["delete", "rights_revoked"],
      ]);
      expect(JSON.stringify(page)).not.toContain("Jan de Vries");
      expect(JSON.stringify(await journalFor(id))).not.toContain("Jan de Vries");
    } finally {
      await syncSources(sql, [source(false)]);
    }
  });

  it("applies the subscriber's filter on class, kind and domain", async () => {
    const base = await frontier();
    await writeOwn(sql, incidentDraft("filter-incident"));
    await writeOwn(sql, roadworksDraft("filter-works"));
    await writeOwn(sql, featureDraft("filter-site"));

    const kinds = await readOutbox(sql, {
      after: base,
      now: NOW,
      filter: { kinds: ["roadworks"] },
    });
    expect(ids(kinds.orderedItems)).toEqual([situationId("filter-works")]);
    const classes = await readOutbox(sql, {
      after: base,
      now: NOW,
      filter: { classes: ["feature"] },
    });
    expect(ids(classes.orderedItems)).toEqual([featureId("filter-site")]);
    const domains = await readOutbox(sql, {
      after: base,
      now: NOW,
      filter: { domains: ["not-a-domain"] },
    });
    expect(domains.orderedItems).toEqual([]);
    expect(domains.highWaterMark).toBe(kinds.highWaterMark);
  });
});

describe("readOutbox: the composite (txid, seq) cursor page", () => {
  it("returns entries after the cursor in order, respecting the limit", async () => {
    const base = await frontier();
    await writeOwn(sql, incidentDraft("page-a"));
    await writeOwn(sql, incidentDraft("page-b"));
    await writeOwn(sql, incidentDraft("page-c"));

    const page = await readOutbox(sql, { after: base, limit: 2, now: NOW });
    expect(page.type).toBe("OrderedCollectionPage");
    expect(ids(page.orderedItems)).toEqual([situationId("page-a"), situationId("page-b")]);
    expect(page.highWaterMark).toBe(cursorOf(page.orderedItems[1]!));
    expect(page.next).toBe(`/peer/outbox?after=${page.highWaterMark}`);

    const rest = await readOutbox(sql, { after: page.highWaterMark, limit: 100, now: NOW });
    expect(ids(rest.orderedItems)).toEqual([situationId("page-c")]);
    expect(rest.next).toBeUndefined();
  });

  it("accepts the wire-encoded highWaterMark string as the next `after`", async () => {
    const base = await frontier();
    await writeOwn(sql, incidentDraft("chain-a"));
    await writeOwn(sql, incidentDraft("chain-b"));

    const first = await readOutbox(sql, { after: base, limit: 1, now: NOW });
    expect(ids(first.orderedItems)).toEqual([situationId("chain-a")]);
    const second = await readOutbox(sql, { after: first.highWaterMark, limit: 1, now: NOW });
    expect(ids(second.orderedItems)).toEqual([situationId("chain-b")]);
  });

  it("is idempotent on retry: re-fetching the same cursor returns the same entries", async () => {
    const base = await frontier();
    await writeOwn(sql, incidentDraft("retry-a"));
    await writeOwn(sql, incidentDraft("retry-b"));

    const first = await readOutbox(sql, { after: base, now: NOW });
    const second = await readOutbox(sql, { after: base, now: NOW });
    expect(second.orderedItems).toEqual(first.orderedItems);
    expect(second.highWaterMark).toBe(first.highWaterMark);
  });

  it("advances the highWaterMark even when the filter drops every scanned entry", async () => {
    const base = await frontier();
    await writeOwn(sql, incidentDraft("filtered-a", { lon: 5.1 }));
    await writeOwn(sql, incidentDraft("filtered-b", { lon: 5.2 }));

    const page = await readOutbox(sql, {
      after: base,
      now: NOW,
      filter: { bbox: [100, 0, 101, 1] },
    });
    expect(page.orderedItems).toEqual([]);
    expect(page.highWaterMark).not.toBe(encodeOutboxCursor(base));
    expect(page.highWaterMark).toBe(encodeOutboxCursor(await frontier()));
  });

  it("filters at source: an out-of-bbox entry leaves a seq gap", async () => {
    const base = await frontier();
    await writeOwn(sql, incidentDraft("bbox-in", { lon: 5.1 }));
    await writeOwn(sql, incidentDraft("bbox-out", { lon: 100.5 }));
    await writeOwn(sql, incidentDraft("bbox-in-2", { lon: 5.2 }));

    const page = await readOutbox(sql, {
      after: base,
      now: NOW,
      filter: { bbox: [5.0, 52.0, 5.5, 52.5] },
    });
    expect(ids(page.orderedItems)).toEqual([situationId("bbox-in"), situationId("bbox-in-2")]);
    const seqs = page.orderedItems.map((e) => e.seq);
    expect(seqs[1]! - seqs[0]!).toBe(2);
    expect(page.highWaterMark).toBe(cursorOf(page.orderedItems[1]!));
  });

  it("leaves an untouched cursor when there is nothing new", async () => {
    const base = await frontier();
    const page = await readOutbox(sql, { after: base, now: NOW });
    expect(page.orderedItems).toEqual([]);
    expect(page.highWaterMark).toBe(encodeOutboxCursor(base));
    expect(page.next).toBeUndefined();
  });

  it("restricts the scan to priority entries and deletes under priorityOnly", async () => {
    const base = await frontier();
    await writeOwn(sql, roadworksDraft("pri-works"));
    await writeOwn(sql, incidentDraft("pri-incident"));
    await tombstone("situation", situationId("pri-works"), "withdrawn");

    const page = await readOutbox(sql, { after: base, now: NOW, priorityOnly: true });
    expect(page.orderedItems.map((e) => [e.recordId, e.operation])).toEqual([
      [situationId("pri-incident"), "create"],
      [situationId("pri-works"), "delete"],
    ]);
    expect(page.priorityRestricted).toBe(true);
  });
});

/** Writes an own incident inside an open transaction, on a reserved connection. */
async function writeIn(conn: postgres.ReservedSql, local: string): Promise<void> {
  await writeRecordIn(conn, { draft: incidentDraft(local) }, writeCtx());
}

async function entryCursor(
  conn: postgres.Sql,
  local: string,
): Promise<{ txid: string; seq: number }> {
  const [row] = await conn<{ txid: string; seq: string }[]>`
    SELECT txid::text AS txid, seq::text AS seq
    FROM conditions.federation_outbox WHERE record_id = ${situationId(local)}`;
  return { txid: row!.txid, seq: Number(row!.seq) };
}

describe("readOutbox: the xmin fence (no permanent skip)", () => {
  it("holds the frontier below an in-flight transaction, then delivers with no skip", async () => {
    const base = await frontier();

    // A slow transaction takes the LOWER seq (bigserial is assigned at INSERT,
    // not COMMIT) and stays open while a fast one commits a HIGHER seq.
    const slow = await sql.reserve();
    let slowSeq: number;
    try {
      await slow`BEGIN`;
      await writeIn(slow, "fence-slow");
      slowSeq = (await entryCursor(slow, "fence-slow")).seq;

      await writeOwn(sql, incidentDraft("fence-fast"));
      const fastSeq = (await entryCursor(sql, "fence-fast")).seq;
      expect(slowSeq).toBeLessThan(fastSeq);

      // While the slow transaction runs, the fence withholds both: neither txid
      // is below xmin, so the cursor cannot pass the uncommitted slow write.
      const fenced = await readOutbox(sql, { after: base, now: NOW });
      expect(ids(fenced.orderedItems)).not.toContain(situationId("fence-fast"));
      expect(ids(fenced.orderedItems)).not.toContain(situationId("fence-slow"));
      expect(fenced.highWaterMark).toBe(encodeOutboxCursor(base));

      await slow`COMMIT`;
    } finally {
      slow.release();
    }

    const after = await readOutbox(sql, { after: base, limit: 500, now: NOW });
    expect(ids(after.orderedItems)).toContain(situationId("fence-slow"));
    expect(ids(after.orderedItems)).toContain(situationId("fence-fast"));
    const slowEntry = after.orderedItems.find((e) => e.recordId === situationId("fence-slow"))!;
    expect(slowEntry.seq).toBe(slowSeq);
  });
});

describe("readOutbox: the composite cursor closes the interleaving skip", () => {
  // R1 (earlier BEGIN, lower txid) holds seqs that interleave ABOVE R2 (later
  // BEGIN, higher txid). A bare seq cursor fenced only by xmin would serve R1's
  // higher seqs, advance past them, and skip R2's lower seq once R2 commits.
  // The (txid, seq) cursor advances in transaction order, so R2 always sorts
  // after it and is delivered on the next poll.
  it("delivers a later-txid, lower-seq transaction after the reader passed the earlier-txid rows", async () => {
    const base = await frontier();
    const r1 = await sql.reserve();
    const r2 = await sql.reserve();
    try {
      await r1`BEGIN`;
      await writeIn(r1, "r1-first");
      await r2`BEGIN`;
      await writeIn(r2, "r2-only");
      await writeIn(r1, "r1-second");

      const r1First = await entryCursor(r1, "r1-first");
      const r1Second = await entryCursor(r1, "r1-second");
      const r2Only = await entryCursor(r2, "r2-only");
      expect(r1First.seq).toBeLessThan(r2Only.seq);
      expect(r2Only.seq).toBeLessThan(r1Second.seq);
      expect(BigInt(r1First.txid)).toBeLessThan(BigInt(r2Only.txid));

      await r1`COMMIT`;
      const afterR1 = await readOutbox(sql, { after: base, limit: 500, now: NOW });
      expect(ids(afterR1.orderedItems)).not.toContain(situationId("r2-only"));

      await r2`COMMIT`;
    } finally {
      r1.release();
      r2.release();
    }

    const drained = ids(
      (await readOutbox(sql, { after: base, limit: 500, now: NOW })).orderedItems,
    );
    expect(drained).toContain(situationId("r1-first"));
    expect(drained).toContain(situationId("r1-second"));
    expect(drained).toContain(situationId("r2-only"));
    expect(drained.indexOf(situationId("r1-first"))).toBeLessThan(
      drained.indexOf(situationId("r2-only")),
    );
    expect(drained.indexOf(situationId("r1-second"))).toBeLessThan(
      drained.indexOf(situationId("r2-only")),
    );
  });

  it("does not skip R2 when a reader drains R1 before R2 commits", async () => {
    const base = await frontier();
    const r1 = await sql.reserve();
    const r2 = await sql.reserve();
    try {
      await r1`BEGIN`;
      await writeIn(r1, "skip-r1a");
      await r2`BEGIN`;
      await writeIn(r2, "skip-r2");
      await writeIn(r1, "skip-r1b");

      // The reader advances over R1's rows while R2 is still open: under a bare
      // seq cursor this is where R2's lower seq would be lost.
      await r1`COMMIT`;
      const firstPoll = await readOutbox(sql, { after: base, limit: 500, now: NOW });

      await r2`COMMIT`;
      const secondPoll = await readOutbox(sql, {
        after: firstPoll.highWaterMark,
        limit: 500,
        now: NOW,
      });
      expect(ids(secondPoll.orderedItems)).toContain(situationId("skip-r2"));
    } finally {
      r1.release();
      r2.release();
    }
  });
});

describe("the outbox schema", () => {
  it("refuses a delete with a snapshot or without a reason", async () => {
    const insert = (operation: string, snapshot: object | null, reason: string | null) => sql`
      INSERT INTO conditions.federation_outbox
        (operation, record_class, record_id, kind, domain, snapshot, tombstone_reason)
      VALUES (${operation}, 'situation', 'x', 'incident', 'road',
              ${snapshot === null ? null : sql.json(snapshot as never)}, ${reason})`;
    await expect(insert("delete", { id: "x" }, "withdrawn")).rejects.toThrow(/delete_shape/);
    await expect(insert("delete", null, null)).rejects.toThrow(/delete_shape/);
    await expect(insert("create", { id: "x" }, null)).resolves.toBeDefined();
  });
});
