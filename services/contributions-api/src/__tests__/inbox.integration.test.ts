import { generateReporterKey, type ReporterKey } from "@openconditions/contrib-core";
import { observationId, schemaVersions } from "@openconditions/model";
import {
  ensureObservationPartitions,
  retentionClasses,
  tombstoneRecords,
} from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FederatedPageError, type InboxContext, ingestFederatedPage } from "../federation/inbox.js";
import { eraseRecord } from "../federation/tombstone.js";
import {
  createTestDatabase,
  enrollDirect,
  evidenceOf,
  feedSituationDraft,
  INSTANCE,
  PEER,
  peerCrowdReport,
  peerRecord,
  registry,
  seedFeedSituation,
} from "./crowd-fixtures.integration.js";

type Rec = Record<string, unknown>;

const NOW = "2026-07-12T08:00:00.000Z";
const LATER = "2026-07-12T08:05:00.000Z";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let alice: ReporterKey;

const ctx = (now = NOW): InboxContext => ({
  registry,
  localInstanceId: INSTANCE,
  peerInstanceId: PEER,
  peerVersions: schemaVersions(registry),
  now,
});

/** A peer's own record as its outbox serves it: no hop of its own in the origin chain. */
function sent(record: Rec): Rec {
  const { originChain: _chain, ...provenance } = record["provenance"] as Rec;
  return { ...record, provenance };
}

/** A peer feed situation, sealed at a revision, as its outbox serves it. */
function peerSituation(local: string, revision = 1, over: Rec = {}): Rec {
  return sent(peerRecord(feedSituationDraft(local, over), revision));
}

function change(record: Rec, seq: number, txid = "10"): Rec {
  return {
    seq,
    txid,
    operation: "update",
    recordClass: record["class"],
    recordId: record["id"],
    canonicalId: record["canonicalId"],
    kind: record["kind"],
    domain: record["domain"],
    createdAt: NOW,
    record,
  };
}

function retraction(record: Rec, reason: string, seq: number, txid = "20"): Rec {
  return {
    seq,
    txid,
    operation: "delete",
    recordClass: record["class"],
    recordId: record["id"],
    canonicalId: record["canonicalId"],
    kind: record["kind"],
    domain: record["domain"],
    createdAt: NOW,
    tombstone: true,
    reason,
  };
}

const page = (...orderedItems: unknown[]) => ({ type: "OrderedCollectionPage", orderedItems });

async function rowOf(id: string) {
  const [row] = await sql<
    {
      instance_id: string;
      revision: number;
      tombstone_reason: string | null;
      record: Rec;
    }[]
  >`SELECT instance_id, revision, tombstone_reason, record FROM conditions.situation WHERE id = ${id}`;
  return row;
}

async function evidenceRows(id: string) {
  return sql<
    { evidence_kind: string; actor_key_id: string | null; source_id: string | null; details: Rec }[]
  >`SELECT evidence_kind, actor_key_id, source_id, details FROM conditions.report_evidence
    WHERE record_class = 'situation' AND record_id = ${id} ORDER BY id`;
}

async function erasureFacts(canonicalId: string) {
  return sql<{ reason: string }[]>`
    SELECT reason FROM conditions.federation_tombstone WHERE canonical_id = ${canonicalId}`;
}

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  alice = await generateReporterKey();
}, 180_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.situation_revision,
    conditions.report_evidence, conditions.sub_claim, conditions.federation_tombstone,
    conditions.reporter, conditions.federation_source_receipt CASCADE`;
});

describe("landing a peer's records", () => {
  it("keeps the peer's revision and adds the receipt to the origin chain", async () => {
    const record = peerSituation("p-1", 3);
    const result = await ingestFederatedPage(sql, page(change(record, 1)), ctx());
    expect(result).toEqual({
      accepted: 1,
      stale: 0,
      tombstoned: 0,
      skipped: [],
      maxCursor: "10.1",
    });
    const row = await rowOf(record["id"] as string);
    expect(row).toMatchObject({ instance_id: PEER, revision: 3, tombstone_reason: null });
    expect(row!.record["revision"]).toBe(3);
    expect((row!.record["provenance"] as Rec)["originChain"]).toEqual([
      { instanceId: PEER, viaPeer: PEER, receivedAt: NOW },
    ]);
    expect((row!.record["provenance"] as Rec)["reporter"]).toBeUndefined();
  });

  it("records when this instance last received each of the peer's sources, a stale delivery too", async () => {
    const record = peerSituation("p-receipt");
    const source = (record["provenance"] as Rec)["sourceId"] as string;
    await ingestFederatedPage(sql, page(change(record, 1)), ctx());
    const receipt = async () =>
      sql`SELECT peer_instance_id, source_id, last_received_at
            FROM conditions.federation_source_receipt WHERE source_id = ${source}`;
    expect(await receipt()).toEqual([
      { peer_instance_id: PEER, source_id: source, last_received_at: new Date(NOW) },
    ]);
    const again = await ingestFederatedPage(sql, page(change(record, 2)), ctx(LATER));
    expect(again.stale).toBe(1);
    expect(await receipt()).toEqual([
      { peer_instance_id: PEER, source_id: source, last_received_at: new Date(LATER) },
    ]);
  });

  it("lands a peer's ended reading with the validity it states", async () => {
    const draft = {
      class: "observation",
      kind: "observation",
      property: "charging.evse_status",
      temporality: "live",
      location: {
        geometry: { type: "Point", coordinates: [8.4, 49] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      provenance: {
        origin: "feed",
        sourceId: "de-bw-mobidata-charging",
        sourceFormat: "ocpi",
        accessMode: "bulk",
        recordId: "309444",
        attribution: { provider: "MobiData BW", license: "CC-BY-4.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: "2026-07-12T07:00:00Z" },
      subject: {
        kind: "feature",
        featureId: "oc:feature:de-bw-mobidata-charging:309444",
        componentKey: "1",
      },
      result: { type: "category", value: "available", vocabulary: "evse_status" },
      phenomenonTime: { instant: "2026-07-12T06:00:00Z" },
      aggregation: "instantaneous",
    };
    const id = observationId("de-bw-mobidata-charging", draft as never);
    const reading = sent(peerRecord({ id, ...draft }));
    await ensureObservationPartitions(sql, {
      classes: retentionClasses(registry),
      now: new Date(NOW),
    });
    expect(await ingestFederatedPage(sql, page(change(reading, 1)), ctx())).toMatchObject({
      accepted: 1,
    });
    // The peer's full parse no longer states the charge point: its reading ends.
    const ended = sent(
      peerRecord(
        { id, ...draft, validUntil: "2026-07-12T07:30:00.000Z" },
        1,
        "2026-07-12T07:30:00Z",
      ),
    );
    expect(await ingestFederatedPage(sql, page(change(ended, 2)), ctx(LATER))).toMatchObject({
      accepted: 1,
      stale: 0,
    });
    const [row] = await sql`
      SELECT conditions.observation_record(template, reading) ->> 'validUntil' AS valid_until
        FROM conditions.observation_latest WHERE source_id = 'de-bw-mobidata-charging'`;
    expect(row).toEqual({ valid_until: "2026-07-12T07:30:00.000Z" });
  });

  it("counts a delivery no newer than the stored copy as stale and changes nothing", async () => {
    const id = peerSituation("p-2")["id"] as string;
    await ingestFederatedPage(sql, page(change(peerSituation("p-2", 2), 1)), ctx());
    const again = await ingestFederatedPage(
      sql,
      page(change(peerSituation("p-2", 2), 2), change(peerSituation("p-2", 1), 3)),
      ctx(LATER),
    );
    expect(again).toMatchObject({ accepted: 0, stale: 2, skipped: [] });
    expect((await rowOf(id))!.revision).toBe(2);
    const newer = await ingestFederatedPage(
      sql,
      page(change(peerSituation("p-2", 3, { severity: { label: "major", source: "derived" } }), 4)),
      ctx(LATER),
    );
    expect(newer).toMatchObject({ accepted: 1, stale: 0 });
    const row = await rowOf(id);
    expect(row!.revision).toBe(3);
    expect(row!.record["severity"]).toMatchObject({ label: "major" });
  });

  it("skips and reports what it may not keep while the rest of the page lands", async () => {
    const valid = peerSituation("p-3");
    const relayed = peerSituation("p-4");
    (relayed["provenance"] as Rec)["instanceId"] = "third.example.org";
    const onDemand = peerSituation("p-5");
    (onDemand["provenance"] as Rec)["accessMode"] = "on_demand";
    const unregistered: Rec = { ...peerSituation("p-6"), kind: "volcanic-eruption" };
    const deleteWithRecord: Rec = {
      ...retraction(peerSituation("p-7"), "withdrawn", 5),
      record: valid,
    };
    const result = await ingestFederatedPage(
      sql,
      page(
        change(relayed, 1),
        change(onDemand, 2),
        change(valid, 3),
        change(unregistered, 4),
        deleteWithRecord,
        { seq: 9, txid: "30", operation: "update" },
      ),
      ctx(),
    );
    expect(result.accepted).toBe(1);
    expect(result.maxCursor).toBe("30.9");
    expect(result.skipped).toEqual([
      { recordId: relayed["id"], reason: expect.stringMatching(/third\.example\.org's/) },
      { recordId: onDemand["id"], reason: expect.stringMatching(/never leave their instance/) },
      {
        recordId: unregistered["id"],
        reason: "situation/volcanic-eruption is not registered here",
      },
      { recordId: deleteWithRecord["recordId"], reason: "a delete carries no record" },
      { reason: "malformed entry" },
    ]);
    expect(await rowOf(valid["id"] as string)).toBeDefined();
    for (const skipped of [relayed, onDemand, unregistered]) {
      expect(await rowOf(skipped["id"] as string)).toBeUndefined();
    }
  });

  it("never replaces a record another instance holds under the same id", async () => {
    const id = await seedFeedSituation(sql, "shared-1");
    const result = await ingestFederatedPage(
      sql,
      page(
        change(
          peerSituation("shared-1", 7, { severity: { label: "critical", source: "derived" } }),
          1,
        ),
      ),
      ctx(),
    );
    expect(result).toMatchObject({
      accepted: 0,
      skipped: [{ recordId: id, reason: "another instance's record holds this id here" }],
    });
    const row = await rowOf(id);
    expect(row).toMatchObject({ instance_id: INSTANCE, revision: 1 });
    expect(row!.record["severity"]).toMatchObject({ label: "moderate" });
  });

  it("rejects a page without orderedItems", async () => {
    await expect(ingestFederatedPage(sql, { foo: 1 }, ctx())).rejects.toThrow(FederatedPageError);
    await expect(ingestFederatedPage(sql, [], ctx())).rejects.toThrow(FederatedPageError);
  });
});

describe("a peer's crowd report", () => {
  it("gets one federation report row and recomputed evidence", async () => {
    const report = peerCrowdReport("c-1");
    const id = report["id"] as string;
    expect(await ingestFederatedPage(sql, page(change(report, 1)), ctx())).toMatchObject({
      accepted: 1,
    });
    expect(await evidenceRows(id)).toEqual([
      {
        evidence_kind: "report",
        actor_key_id: null,
        source_id: PEER,
        details: { via: "federation", peer: PEER, reportedAt: "2026-07-12T07:59:00.000Z" },
      },
    ]);
    const evidence = await evidenceOf(sql, id);
    expect(evidence.evidence_state).not.toBeNull();
    expect(evidence).toMatchObject({ routing_eligible: false });
    expect(evidence.expires_at).not.toBeNull();

    const redelivered = await ingestFederatedPage(sql, page(change(report, 2)), ctx(LATER));
    expect(redelivered).toMatchObject({ accepted: 0, stale: 1 });
    expect(await evidenceRows(id)).toHaveLength(1);
  });

  it("is routed by an agreeing local feed situation and trains nobody", async () => {
    await enrollDirect(sql, alice, NOW, { alpha: 3, beta: 2 });
    const feed = await seedFeedSituation(sql, "a5-1");
    const report = peerCrowdReport("c-2");
    const id = report["id"] as string;
    await ingestFederatedPage(sql, page(change(report, 1)), ctx());

    expect(await evidenceOf(sql, id)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
    const rows = await evidenceRows(id);
    expect(rows.map((r) => r.evidence_kind)).toEqual(["report", "official_match"]);
    expect(rows[1]).toMatchObject({
      source_id: "de-autobahn-events",
      details: { matchedRecord: { class: "situation", id: feed } },
    });
    expect(
      await sql`SELECT key_id, reputation_alpha, reputation_beta, corroborated_count
        FROM conditions.reporter`,
    ).toEqual([
      { key_id: alice.keyId, reputation_alpha: 3, reputation_beta: 2, corroborated_count: 0 },
    ]);
  });

  it("lives at least as long as the peer says", async () => {
    const report = peerCrowdReport("c-life");
    const id = report["id"] as string;
    await ingestFederatedPage(sql, page(change(report, 1)), ctx());
    expect((await evidenceOf(sql, id)).expires_at?.toISOString()).toBe("2026-07-12T12:00:00.000Z");
    expect(((await rowOf(id))!.record["freshness"] as Rec)["expiresAt"]).toBe(
      "2026-07-12T12:00:00.000Z",
    );
  });

  it("takes a lifetime the peer extended without a new revision", async () => {
    const report = peerCrowdReport("c-ext");
    const id = report["id"] as string;
    await ingestFederatedPage(sql, page(change(report, 1)), ctx());
    const extended = {
      ...report,
      freshness: { ...(report["freshness"] as Rec), expiresAt: "2026-07-12T14:00:00.000Z" },
    };
    expect(await ingestFederatedPage(sql, page(change(extended, 2)), ctx(LATER))).toMatchObject({
      accepted: 1,
      stale: 0,
    });
    expect((await evidenceOf(sql, id)).expires_at?.toISOString()).toBe("2026-07-12T14:00:00.000Z");
    expect(((await rowOf(id))!.record["freshness"] as Rec)["expiresAt"]).toBe(
      "2026-07-12T14:00:00.000Z",
    );
    expect(await evidenceRows(id)).toHaveLength(1);
  });

  it("lands its evidence with the record, so a failed page lands whole on retry", async () => {
    const report = peerCrowdReport("c-retry");
    const id = report["id"] as string;
    await sql.unsafe(`CREATE SEQUENCE conditions.inbox_test_fail_once`);
    await sql.unsafe(`CREATE FUNCTION conditions.inbox_test_fail_once() RETURNS trigger AS $$
      BEGIN
        IF nextval('conditions.inbox_test_fail_once') = 1 THEN
          RAISE EXCEPTION 'evidence write failed';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await sql`CREATE TRIGGER inbox_test_fail_once BEFORE INSERT ON conditions.report_evidence
      FOR EACH ROW EXECUTE FUNCTION conditions.inbox_test_fail_once()`;
    try {
      await expect(ingestFederatedPage(sql, page(change(report, 1)), ctx())).rejects.toThrow(
        "evidence write failed",
      );
      expect(await ingestFederatedPage(sql, page(change(report, 1)), ctx())).toMatchObject({
        accepted: 1,
      });
      expect(await evidenceRows(id)).toHaveLength(1);
      expect((await evidenceOf(sql, id)).evidence_state).not.toBeNull();
    } finally {
      await sql`DROP TRIGGER inbox_test_fail_once ON conditions.report_evidence`;
      await sql.unsafe(`DROP FUNCTION conditions.inbox_test_fail_once()`);
      await sql.unsafe(`DROP SEQUENCE conditions.inbox_test_fail_once`);
    }
  });

  it("is not routed by a feed situation another peer federated", async () => {
    await ingestFederatedPage(sql, page(change(peerSituation("a5-2"), 1)), ctx());
    const report = peerCrowdReport("c-3");
    await ingestFederatedPage(sql, page(change(report, 2)), ctx());
    expect(await evidenceOf(sql, report["id"] as string)).toMatchObject({
      routing_eligible: false,
    });
  });
});

describe("a peer's retractions", () => {
  it("tombstones the peer's copy with its reason and leaves another instance's copy alone", async () => {
    const own = peerSituation("r-1");
    await ingestFederatedPage(sql, page(change(own, 1)), ctx());
    const local = await seedFeedSituation(sql, "r-2");
    const localRecord = (await rowOf(local))!.record;

    const result = await ingestFederatedPage(
      sql,
      page(retraction(own, "cancelled", 1), retraction(localRecord, "withdrawn", 2)),
      ctx(LATER),
    );
    expect(result).toMatchObject({
      tombstoned: 1,
      skipped: [{ recordId: local, reason: "the record is not the peer's" }],
      maxCursor: "20.2",
    });
    expect(await rowOf(own["id"] as string)).toMatchObject({ tombstone_reason: "cancelled" });
    expect(await rowOf(local)).toMatchObject({ tombstone_reason: null, instance_id: INSTANCE });
    expect(await erasureFacts(own["canonicalId"] as string)).toEqual([]);
  });

  it("reads a reason outside the model's vocabulary as withdrawn", async () => {
    const own = peerSituation("r-3");
    await ingestFederatedPage(sql, page(change(own, 1)), ctx());
    await ingestFederatedPage(sql, page(retraction(own, "gdpr_erasure", 2)), ctx(LATER));
    expect(await rowOf(own["id"] as string)).toMatchObject({ tombstone_reason: "withdrawn" });
  });

  it("an erasure records its fact and no later delivery of the record lands", async () => {
    const own = peerSituation("e-1");
    const canonicalId = own["canonicalId"] as string;
    await ingestFederatedPage(sql, page(change(own, 1)), ctx());
    expect(
      await ingestFederatedPage(sql, page(retraction(own, "rights_revoked", 2)), ctx(LATER)),
    ).toMatchObject({ tombstoned: 1, skipped: [] });
    expect(await rowOf(own["id"] as string)).toMatchObject({ tombstone_reason: "rights_revoked" });
    expect(await erasureFacts(canonicalId)).toEqual([{ reason: "rights_revoked" }]);
    const [{ revisions }] = await sql<{ revisions: number }[]>`
      SELECT count(*)::int AS revisions FROM conditions.situation_revision
       WHERE situation_id = ${own["id"] as string}`;
    expect(revisions).toBe(0);

    const resurrected = await ingestFederatedPage(
      sql,
      page(change(peerSituation("e-1", 5), 3)),
      ctx(LATER),
    );
    expect(resurrected).toMatchObject({
      accepted: 0,
      skipped: [{ recordId: own["id"], reason: "the record was erased" }],
    });
    expect(await rowOf(own["id"] as string)).toMatchObject({ tombstone_reason: "rights_revoked" });
  });

  it("an erasure that arrives before the record still refuses it", async () => {
    const own = peerSituation("e-2");
    const early = await ingestFederatedPage(sql, page(retraction(own, "rights_revoked", 1)), ctx());
    expect(early.skipped).toEqual([
      { recordId: own["id"], reason: "no copy of the record is held here" },
    ]);
    expect(await erasureFacts(own["canonicalId"] as string)).toHaveLength(1);
    const late = await ingestFederatedPage(sql, page(change(own, 2)), ctx(LATER));
    expect(late.skipped).toEqual([{ recordId: own["id"], reason: "the record was erased" }]);
    expect(await rowOf(own["id"] as string)).toBeUndefined();
  });

  it("a peer's erasure never refuses another instance's record", async () => {
    const other = "other.example.com";
    const theirs = sent(peerRecord(feedSituationDraft("e-4"), 1, undefined, other));
    const forged = await ingestFederatedPage(
      sql,
      page(retraction(theirs, "rights_revoked", 1)),
      ctx(),
    );
    expect(forged.tombstoned).toBe(0);
    const delivered = await ingestFederatedPage(sql, page(change(theirs, 2)), {
      ...ctx(LATER),
      peerInstanceId: other,
    });
    expect(delivered).toMatchObject({ accepted: 1, skipped: [] });
  });

  it("an operator's erasure refuses the record from every peer", async () => {
    const own = peerSituation("e-5");
    await ingestFederatedPage(sql, page(change(own, 1)), ctx());
    expect(
      await eraseRecord(sql, registry, { class: "situation", id: own["id"] as string }, NOW),
    ).toBe("erased");
    const other = "other.example.com";
    const theirs = sent(peerRecord(feedSituationDraft("e-5"), 4, undefined, other));
    expect(theirs["canonicalId"]).toBe(own["canonicalId"]);
    const late = await ingestFederatedPage(sql, page(change(theirs, 2)), {
      ...ctx(LATER),
      peerInstanceId: other,
    });
    expect(late.skipped).toEqual([{ recordId: own["id"], reason: "the record was erased" }]);
  });

  it("an erasure racing a delivery of the same record never leaves it live", async () => {
    const own = peerSituation("e-3");
    const id = own["id"] as string;
    let releaseGate!: () => void;
    let signalLocked!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    await sql.unsafe(`CREATE FUNCTION conditions.pause_inbox_test_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${id}' THEN
          PERFORM pg_advisory_xact_lock(729001);
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await sql`CREATE TRIGGER pause_inbox_test_insert BEFORE INSERT ON conditions.situation
      FOR EACH ROW EXECUTE FUNCTION conditions.pause_inbox_test_insert()`;
    const blocker = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(729001)`;
      signalLocked();
      await gate;
    });
    let delivery: ReturnType<typeof ingestFederatedPage> | undefined;
    let erasure: ReturnType<typeof ingestFederatedPage> | undefined;
    try {
      await locked;
      delivery = ingestFederatedPage(sql, page(change(own, 1)), ctx());
      // The delivery has passed its erasure check and waits inside its insert.
      await expect
        .poll(async () => {
          const rows = await sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
            AND objid = 729001 AND NOT granted`;
          return rows.length;
        })
        .toBe(1);
      erasure = ingestFederatedPage(sql, page(retraction(own, "rights_revoked", 2)), ctx(LATER));
      await Promise.race([erasure, new Promise((resolve) => setTimeout(resolve, 500))]);
      releaseGate();
      await blocker;
      await Promise.all([delivery, erasure]);
      expect(await erasureFacts(own["canonicalId"] as string)).toHaveLength(1);
      const row = await rowOf(id);
      expect(row === undefined ? "absent" : row.tombstone_reason).toBeOneOf([
        "absent",
        "rights_revoked",
      ]);
    } finally {
      releaseGate();
      await Promise.allSettled([blocker, delivery, erasure]);
      await sql`DROP TRIGGER pause_inbox_test_insert ON conditions.situation`;
      await sql`DROP FUNCTION conditions.pause_inbox_test_insert()`;
    }
  }, 30_000);
});

describe("a peer's copy this instance ended", () => {
  const majorSeverity = { severity: { label: "major", source: "derived" } };
  const minorSeverity = { severity: { label: "minor", source: "derived" } };

  async function endHere(id: string, reason: string) {
    await sql.begin((tx) =>
      tombstoneRecords(tx, "situation", [id], reason, { registry, now: NOW }),
    );
  }

  it("keeps the peer's revision, so an expired copy comes back at the peer's next change", async () => {
    const id = peerSituation("t-1")["id"] as string;
    await ingestFederatedPage(sql, page(change(peerSituation("t-1", 3), 1)), ctx());
    await endHere(id, "expired");
    expect(await rowOf(id)).toMatchObject({ revision: 3, tombstone_reason: "expired" });

    const next = await ingestFederatedPage(
      sql,
      page(change(peerSituation("t-1", 4, majorSeverity), 2)),
      ctx(LATER),
    );
    expect(next).toMatchObject({ accepted: 1, stale: 0 });
    expect(await rowOf(id)).toMatchObject({ revision: 4, tombstone_reason: null });
  });

  it("lets a copy a poll here withdrew come back at the peer's next change", async () => {
    const id = peerSituation("t-2")["id"] as string;
    await ingestFederatedPage(sql, page(change(peerSituation("t-2", 2), 1)), ctx());
    await endHere(id, "withdrawn");
    const next = await ingestFederatedPage(
      sql,
      page(change(peerSituation("t-2", 3, majorSeverity), 2)),
      ctx(LATER),
    );
    expect(next).toMatchObject({ accepted: 1 });
    expect(await rowOf(id)).toMatchObject({ revision: 3, tombstone_reason: null });
  });

  it.each(["rejected", "superseded"])(
    "keeps a %s copy ended through every later change of the peer's",
    async (reason) => {
      const id = peerSituation("t-3")["id"] as string;
      await ingestFederatedPage(sql, page(change(peerSituation("t-3", 2), 1)), ctx());
      await endHere(id, reason);
      expect(await rowOf(id)).toMatchObject({ revision: 2, tombstone_reason: reason });
      const later = await ingestFederatedPage(
        sql,
        page(
          change(peerSituation("t-3", 3, majorSeverity), 2),
          change(peerSituation("t-3", 4, minorSeverity), 3),
        ),
        ctx(LATER),
      );
      expect(later).toMatchObject({ accepted: 0, stale: 2 });
      expect(await rowOf(id)).toMatchObject({ revision: 2, tombstone_reason: reason });
    },
  );

  it("removes the content of a copy ended here when the peer erases it", async () => {
    const own = peerSituation("t-5", 1, {
      headline: [{ lang: "de", text: "Gegenstand auf der Fahrbahn" }],
    });
    const id = own["id"] as string;
    await ingestFederatedPage(sql, page(change(own, 1)), ctx());
    await endHere(id, "expired");
    await ingestFederatedPage(sql, page(retraction(own, "rights_revoked", 2)), ctx(LATER));
    const row = await rowOf(id);
    expect(row!.tombstone_reason).toBe("rights_revoked");
    expect(row!.record).not.toHaveProperty("headline");
    expect(row!.record).not.toHaveProperty("location");
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM conditions.situation_revision WHERE situation_id = ${id}`;
    expect(n).toBe(0);
  });

  it("journals nothing of a peer's copy it erases, and keeps where the copy came from", async () => {
    await sql`
      INSERT INTO conditions.federation_subscription (id, peer_id, delivery_mode, created_at, updated_at)
      VALUES ('sub-peer-copy', 'peer-sub', 'pull', now(), now())`;
    try {
      const own = peerSituation("t-6");
      const id = own["id"] as string;
      await ingestFederatedPage(sql, page(change(own, 1)), ctx());
      await ingestFederatedPage(sql, page(retraction(own, "rights_revoked", 2)), ctx(LATER));
      const [{ n }] = await sql`
        SELECT count(*)::int AS n FROM conditions.federation_outbox WHERE record_id = ${id}`;
      expect(n).toBe(0);
      const provenance = (await rowOf(id))!.record["provenance"] as Record<string, unknown>;
      expect(provenance["originChain"]).toEqual([
        { instanceId: PEER, viaPeer: PEER, receivedAt: NOW },
      ]);
    } finally {
      await sql`DELETE FROM conditions.federation_subscription WHERE id = 'sub-peer-copy'`;
    }
  });

  it("still takes the peer's own retraction as a revision of its own", async () => {
    const own = peerSituation("t-4", 2);
    await ingestFederatedPage(sql, page(change(own, 1)), ctx());
    await ingestFederatedPage(sql, page(retraction(own, "cancelled", 2)), ctx(LATER));
    expect(await rowOf(own["id"] as string)).toMatchObject({
      revision: 3,
      tombstone_reason: "cancelled",
    });
    const restored = await ingestFederatedPage(
      sql,
      page(change(peerSituation("t-4", 4, majorSeverity), 3)),
      ctx(LATER),
    );
    expect(restored).toMatchObject({ accepted: 1 });
    expect(await rowOf(own["id"] as string)).toMatchObject({
      revision: 4,
      tombstone_reason: null,
    });
  });
});
