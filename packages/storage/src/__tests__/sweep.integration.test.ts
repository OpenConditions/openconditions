import { sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase } from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { REPORTER_RETENTION_MONTHS, type SweepOptions, sweepRecords } from "../sweep.js";
import { writeRecord } from "../write-record.js";
import { writeSnapshot } from "../write-records.js";
import { FETCHED_AT, firePixel, observationDraft, situationDraft } from "./drafts.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const T0 = "2026-10-01T10:00:05.000Z";
const LATER = "2026-10-01T12:00:00.000Z";
const write = { registry, instanceId: "test.local", now: T0 };
const sweep = (now: string, over: Partial<SweepOptions> = {}) =>
  sweepRecords(sql, { ...write, now, maxAgeSec: 3600, historyDays: 90, ...over });

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(T0),
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.observation_latest,
    conditions.source_status, conditions.reporter, conditions.report_evidence,
    conditions.spent_token, conditions.federation_tombstone CASCADE`;
});

/** A reporter last enrolled at `at`, its entitlement ending `entitledFor` later. */
async function reporterActive(key: string, at: string, entitledFor = "1 day") {
  await sql`INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha, reputation_beta,
      entitlement_expires_at, created_at, last_active_at)
    VALUES (${key}, '{}'::jsonb, 1, 1, ${at}::timestamptz + ${entitledFor}::interval, ${at}, ${at})`;
}

/** The source polled successfully at `at`. */
async function polled(source: string, at: string) {
  await sql`INSERT INTO conditions.source_status (source, last_success_at, freshness_window_sec)
    VALUES (${source}, ${at}, 900)`;
}

async function state(id: string) {
  const [row] = await sql`SELECT tombstone_reason, revision FROM conditions.situation
    WHERE id = ${id}`;
  return row;
}

describe("sweepRecords", () => {
  it("tombstones a record once its own expiry passes, and leaves an ended one its source still publishes", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      {
        situations: [
          situationDraft("exp", {
            freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T11:00:00Z" },
          }),
          situationDraft("ended", {
            validity: {
              status: "ended",
              start: "2026-10-01T08:00:00Z",
              end: "2026-10-01T09:00:00Z",
            },
          }),
        ],
      },
      { ...write, complete: true },
    );
    expect(await sweep(LATER)).toMatchObject({ expired: 1, orphaned: 0 });
    expect(await state("oc:situation:nl-ndw-events:exp")).toEqual({
      tombstone_reason: "expired",
      revision: 2,
    });
    expect(await state("oc:situation:nl-ndw-events:ended")).toEqual({
      tombstone_reason: null,
      revision: 1,
    });
    const [revision] = await sql`SELECT change_kinds FROM conditions.situation_revision
      WHERE situation_id = 'oc:situation:nl-ndw-events:exp' AND revision = 2`;
    expect(revision).toEqual({ change_kinds: ["tombstoned"] });
  });

  it("expires a peer's copy at the peer's revision, writing it no history", async () => {
    const draft = situationDraft("peer-exp", {
      freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T11:00:00Z" },
    });
    const sealed = sealRecord(registry, draft, {
      instanceId: "peer.example",
      revision: 4,
      recordedAt: FETCHED_AT,
    });
    if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
    const copy = {
      ...sealed.value,
      provenance: {
        ...(sealed.value["provenance"] as object),
        originChain: [
          { instanceId: "peer.example", viaPeer: "peer.example", receivedAt: FETCHED_AT },
        ],
      },
    };
    expect((await writeRecord(sql, { stored: copy }, write)).status).toBe("created");
    expect(await sweep(LATER)).toMatchObject({ expired: 1 });
    const [row] = await sql`
      SELECT tombstone_reason, revision, recorded_at, record ->> 'revision' AS stated
        FROM conditions.situation WHERE id = ${draft["id"] as string}`;
    expect(row).toEqual({
      tombstone_reason: "expired",
      revision: 4,
      recorded_at: new Date(FETCHED_AT),
      stated: "4",
    });
    const history = await sql`SELECT revision FROM conditions.situation_revision
      WHERE situation_id = ${draft["id"] as string}`;
    expect(history).toEqual([{ revision: 4 }]);
  });

  it("tombstones the feed records of a source that stopped polling, not crowd or peer records", async () => {
    await polled("nl-ndw-events", "2026-10-01T09:00:00Z");
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("old")] },
      { ...write, complete: true },
    );
    const crowd = situationDraft("c1", {
      id: "oc:situation:test.local:c1",
      provenance: {
        origin: "crowd",
        sourceId: "crowd",
        sourceFormat: "crowd",
        accessMode: "bulk",
        recordId: "c1",
        attribution: { provider: "OpenConditions contributors", license: "CC0-1.0" },
        privacy: { class: "crowd_pseudonym" },
      },
    });
    await writeRecord(sql, { draft: crowd }, write);
    expect(await sweep(LATER)).toMatchObject({ orphaned: 1 });
    expect(await state("oc:situation:nl-ndw-events:old")).toMatchObject({
      tombstone_reason: "expired",
    });
    expect(await state("oc:situation:test.local:c1")).toMatchObject({ tombstone_reason: null });
  });

  it("keeps the records of a source that is still polling", async () => {
    await polled("nl-ndw-events", "2026-10-01T11:30:00Z");
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("live")] },
      { ...write, complete: true },
    );
    expect(await sweep(LATER)).toEqual({
      expired: 0,
      orphaned: 0,
      lapsed: 0,
      purged: 0,
      dropped: 0,
      crowdExpired: 0,
      transient: 0,
      reporters: 0,
      tokenQuotas: 0,
      spentTokens: 0,
      federationTombstones: 0,
      busy: 0,
    });
  });

  it("keeps the records of a source whose poll is still running, however long it runs", async () => {
    await sql`TRUNCATE conditions.source_poll_attempt`;
    await polled("nl-ndw-events", "2026-10-01T09:00:00Z");
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("publishing")] },
      { ...write, complete: true },
    );
    // A first publish that has been writing since 10:30.
    const [attempt] = await sql<{ id: string }[]>`
      INSERT INTO conditions.source_poll_attempt (source, attempted_at, outcome, network_validated)
      VALUES ('nl-ndw-events', '2026-10-01T10:30:00Z', 'running', false) RETURNING id`;
    expect(await sweep(LATER)).toMatchObject({ orphaned: 0 });
    expect(await state("oc:situation:nl-ndw-events:publishing")).toMatchObject({
      tombstone_reason: null,
    });
    // The poll ended without success: the source has stopped, and its records go.
    await sql`UPDATE conditions.source_poll_attempt SET outcome = 'failed', finished_at = now()
      WHERE id = ${attempt!.id}`;
    expect(await sweep(LATER)).toMatchObject({ orphaned: 1 });
  });

  it("deletes on-demand rows at expiry, records and series alike", async () => {
    const onDemand = (draft: Record<string, unknown>) => ({
      ...draft,
      provenance: { ...(draft["provenance"] as object), accessMode: "on_demand" },
      freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" },
    });
    await polled("nl-ndw-events", LATER);
    await polled("nl-ndw-flow", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [onDemand(situationDraft("od"))] },
      { ...write, complete: true },
    );
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [
          onDemand(
            observationDraft(
              "traffic.speed",
              { type: "quantity", value: 50, unit: "km/h" },
              { at: "2026-10-01T10:00:00Z" },
            ),
          ),
        ],
      },
      { ...write, complete: true },
    );
    expect(await sweep(LATER)).toMatchObject({ dropped: 2, expired: 0 });
  });

  it("deletes a bulk transient series once its reading expired, and keeps other expired series", async () => {
    await polled("nasa-firms-viirs-fires", LATER);
    await polled("nl-ndw-flow", LATER);
    await writeSnapshot(
      sql,
      "nasa-firms-viirs-fires",
      {
        observations: [
          // Acquired three days and more before LATER: expired at 09:00.
          firePixel(-120.5, 38.25, "2026-09-28T09:00:00Z"),
          firePixel(-120.6, 38.3, "2026-10-01T09:00:00Z"),
        ],
      },
      { ...write, complete: true },
    );
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [
          observationDraft(
            "traffic.speed",
            { type: "quantity", value: 50, unit: "km/h" },
            {
              at: "2026-10-01T10:00:00Z",
              freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" },
            },
          ),
        ],
      },
      { ...write, complete: true },
    );
    expect(await sweep(LATER)).toMatchObject({ transient: 1, dropped: 0 });
    const rows = await sql`SELECT property, effective_from FROM conditions.observation_latest
      ORDER BY property, effective_from`;
    expect(rows).toEqual([
      { property: "fire.frp", effective_from: new Date("2026-10-01T09:00:00Z") },
      { property: "traffic.speed", effective_from: new Date("2026-10-01T10:00:00Z") },
    ]);
  });

  it("purges a record tombstoned longer ago than the history window, with its revisions", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("gone")] },
      { ...write, complete: true },
    );
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [] },
      { ...write, now: LATER, complete: true },
    );
    expect(await sweep("2026-11-01T00:00:00Z", { maxAgeSec: 1e9 })).toMatchObject({ purged: 0 });
    expect(await sweep("2027-01-05T00:00:00Z", { maxAgeSec: 1e9 })).toMatchObject({ purged: 1 });
    const [{ revisions }] =
      await sql`SELECT count(*)::int AS revisions FROM conditions.situation_revision`;
    expect(revisions).toBe(0);
  });

  it("purges a record's graph bindings with it", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("gone")] },
      { ...write, complete: true },
    );
    await sql`INSERT INTO conditions.record_binding (record_class, record_id, effect_id, status,
        direction_mode, resolver_version, geom_hash, record_revision, bound_at)
      VALUES ('situation', 'oc:situation:nl-ndw-events:gone', '', 'exact', 'single', 'v', 'h', 1, now())`;
    await sql`INSERT INTO conditions.record_segment (record_class, record_id, effect_id, seq,
        segment_id, way_id, dir, start_fraction, end_fraction)
      VALUES ('situation', 'oc:situation:nl-ndw-events:gone', '', 0, '1:f', 1, 'f', 0, 1)`;
    await sql`UPDATE conditions.situation SET tombstoned_at = '2026-06-01T00:00:00Z',
      tombstone_reason = 'withdrawn'`;
    expect(await sweep(LATER)).toMatchObject({ purged: 1 });
    expect(await sql`SELECT 1 FROM conditions.record_binding`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM conditions.record_segment`).toHaveLength(0);
  });

  it("purges a record's crowd evidence and votes with it", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      { situations: [situationDraft("voted")] },
      { ...write, complete: true },
    );
    const id = "oc:situation:nl-ndw-events:voted";
    await reporterActive("k", LATER);
    await sql`INSERT INTO conditions.report_evidence
        (record_class, record_id, evidence_kind, actor_key_id, occurred_at)
      VALUES ('situation', ${id}, 'confirm', 'k', now())`;
    await sql`INSERT INTO conditions.sub_claim
        (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
      VALUES ('s1', 'situation', ${id}, 'confirm', 'k', 'sig', now())`;
    await sql`UPDATE conditions.situation SET tombstoned_at = '2026-06-01T00:00:00Z',
      tombstone_reason = 'withdrawn'`;
    expect(await sweep(LATER)).toMatchObject({ purged: 1 });
    expect(await sql`SELECT 1 FROM conditions.report_evidence`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM conditions.sub_claim`).toHaveLength(0);
  });

  it("waits for a poll of the source before purging or dropping its rows", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      {
        situations: [
          situationDraft("gone"),
          {
            ...situationDraft("od"),
            provenance: {
              ...(situationDraft("od")["provenance"] as object),
              accessMode: "on_demand",
            },
            freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" },
          },
        ],
      },
      { ...write, complete: true },
    );
    await sql`UPDATE conditions.situation SET tombstoned_at = '2026-06-01T00:00:00Z',
      tombstone_reason = 'withdrawn' WHERE id = 'oc:situation:nl-ndw-events:gone'`;
    const poll = await sql.reserve();
    await poll`SELECT pg_advisory_lock(hashtext('nl-ndw-events'))`;
    const swept = sweep(LATER);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [{ held }] = await sql`SELECT count(*)::int AS held FROM conditions.situation`;
    expect(held).toBe(2);
    await poll`SELECT pg_advisory_unlock(hashtext('nl-ndw-events'))`;
    poll.release();
    expect(await swept).toMatchObject({ purged: 1, dropped: 1 });
  });

  it("leaves a source whose lock is held past lock_timeout to the next sweep", async () => {
    await polled("nl-ndw-events", LATER);
    await writeSnapshot(
      sql,
      "nl-ndw-events",
      {
        situations: [
          situationDraft("exp", {
            freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T11:00:00Z" },
          }),
        ],
      },
      { ...write, complete: true },
    );
    const maintenance = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      connection: { lock_timeout: 200 },
    });
    const poll = await sql.reserve();
    try {
      await poll`SELECT pg_advisory_lock(hashtext('nl-ndw-events'))`;
      const busy = await sweepRecords(maintenance, {
        ...write,
        now: LATER,
        maxAgeSec: 3600,
        historyDays: 90,
      });
      expect(busy).toMatchObject({ expired: 0, busy: 1 });
      expect(await state("oc:situation:nl-ndw-events:exp")).toMatchObject({
        tombstone_reason: null,
      });
      await poll`SELECT pg_advisory_unlock(hashtext('nl-ndw-events'))`;
      expect(await sweep(LATER)).toMatchObject({ expired: 1, busy: 0 });
    } finally {
      poll.release();
      await maintenance.end();
    }
  });
});

describe("sweepRecords retention", () => {
  const keys = async () =>
    (await sql<{ key_id: string }[]>`SELECT key_id FROM conditions.reporter ORDER BY key_id`).map(
      (r) => r.key_id,
    );

  it(`deletes a reporter once its activity and entitlement are both ${REPORTER_RETENTION_MONTHS} months old`, async () => {
    // LATER is 2026-10-01T12:00Z, so the cutoff is 2025-10-01T12:00Z.
    await reporterActive("stale", "2025-09-01T00:00:00Z");
    await reporterActive("entitled-since", "2025-09-01T00:00:00Z", "2 months");
    await reporterActive("active-since", "2026-09-01T00:00:00Z", "-20 months");
    await reporterActive("at-cutoff", "2025-10-01T12:00:00Z", "0 days");
    await reporterActive("recent", "2026-09-30T00:00:00Z");
    expect(await sweep(LATER)).toMatchObject({ reporters: 1, busy: 0 });
    expect(await keys()).toEqual(["active-since", "at-cutoff", "entitled-since", "recent"]);
  });

  it("takes a deleted reporter's votes, refusals and quotas, and keeps its evidence keyless", async () => {
    await reporterActive("stale", "2025-09-01T00:00:00Z");
    await reporterActive("recent", "2026-09-30T00:00:00Z");
    for (const key of ["stale", "recent"]) {
      await sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES (${`s-${key}`}, 'situation', 'subj', 'confirm', ${key}, 'sig', now())`;
      await sql`INSERT INTO conditions.report_refusal (actor_key_id, cell, occurred_at)
        VALUES (${key}, 'cell', now())`;
      await sql`INSERT INTO conditions.token_quota (key_id, epoch, issued)
        VALUES (${key}, '2026-10-01', 1)`;
      await sql`INSERT INTO conditions.report_evidence
          (record_class, record_id, evidence_kind, actor_key_id, occurred_at)
        VALUES ('situation', 'subj', 'confirm', ${key}, now())`;
    }
    expect(await sweep(LATER)).toMatchObject({ reporters: 1, tokenQuotas: 0 });
    expect(await sql`SELECT key_id FROM conditions.sub_claim`).toEqual([{ key_id: "recent" }]);
    expect(await sql`SELECT actor_key_id FROM conditions.report_refusal`).toEqual([
      { actor_key_id: "recent" },
    ]);
    expect(await sql`SELECT key_id FROM conditions.token_quota`).toEqual([{ key_id: "recent" }]);
    expect(
      await sql`SELECT actor_key_id FROM conditions.report_evidence
        ORDER BY actor_key_id NULLS FIRST`,
    ).toEqual([{ actor_key_id: null }, { actor_key_id: "recent" }]);
  });

  it("deletes the token quotas of an ended UTC day and keeps today's and other epochs", async () => {
    await reporterActive("recent", "2026-09-30T00:00:00Z");
    for (const epoch of ["2026-09-29", "2026-09-30", "2026-10-01", "epoch-42"]) {
      await sql`INSERT INTO conditions.token_quota (key_id, epoch, issued)
        VALUES ('recent', ${epoch}, 1)`;
    }
    // Still 2026-09-30 in UTC-10, already 2026-10-01 in UTC: the epoch is a UTC day.
    expect(await sweep("2026-09-30T20:00:00-10:00")).toMatchObject({ tokenQuotas: 2 });
    expect(
      (await sql<{ epoch: string }[]>`SELECT epoch FROM conditions.token_quota ORDER BY epoch`).map(
        (r) => r.epoch,
      ),
    ).toEqual(["2026-10-01", "epoch-42"]);
  });

  it("deletes spent tokens a day past their expiry and erasure facts past theirs", async () => {
    // A day's margin: a contributions service whose clock runs behind would
    // still redeem a token whose row went at its expiry.
    await sql`INSERT INTO conditions.spent_token (token_hash, purpose, spent_at, expires_at)
      VALUES ('gone', 'report:-:2026-09-01', '2026-09-01T00:00:00Z', '2026-09-30T11:59:59Z'),
             ('kept', 'report:-:2026-09-01', '2026-09-01T00:00:00Z', '2026-09-30T12:00:00Z')`;
    await sql`INSERT INTO conditions.federation_tombstone
        (canonical_id, peer_instance_id, reason, tombstoned_at, expires_at)
      VALUES ('gone', '', 'rights_revoked', '2026-08-01T00:00:00Z', '2026-08-31T00:00:00Z'),
             ('gone', 'peer.example', 'rights_revoked', '2026-08-01T00:00:00Z', '2026-08-31T00:00:00Z'),
             ('kept', '', 'rights_revoked', '2026-09-30T00:00:00Z', '2026-10-30T00:00:00Z')`;
    expect(await sweep(LATER)).toMatchObject({ spentTokens: 1, federationTombstones: 2 });
    expect(await sql`SELECT token_hash FROM conditions.spent_token`).toEqual([
      { token_hash: "kept" },
    ]);
    expect(await sql`SELECT canonical_id FROM conditions.federation_tombstone`).toEqual([
      { canonical_id: "kept" },
    ]);
  });

  it("deletes in batches until nothing is left", async () => {
    await sql`INSERT INTO conditions.spent_token (token_hash, purpose, spent_at, expires_at)
      SELECT 'expired-' || n, 'report:-:2026-09-01', '2026-09-01T00:00:00Z',
             '2026-09-02T00:00:00Z'
      FROM generate_series(1, 1201) n`;
    expect(await sweep(LATER)).toMatchObject({ spentTokens: 1201 });
    expect(await sql`SELECT 1 FROM conditions.spent_token`).toHaveLength(0);
  });

  it("leaves a reporter another transaction holds to the next sweep", async () => {
    await reporterActive("held", "2025-09-01T00:00:00Z");
    await reporterActive("stale", "2025-08-01T00:00:00Z");
    const enrolment = await sql.reserve();
    try {
      await enrolment`BEGIN`;
      await enrolment`SELECT 1 FROM conditions.reporter WHERE key_id = 'held' FOR UPDATE`;
      expect(await sweep(LATER)).toMatchObject({ reporters: 1, busy: 0 });
      expect(await keys()).toEqual(["held"]);
    } finally {
      await enrolment`ROLLBACK`;
      enrolment.release();
    }
    expect(await sweep(LATER)).toMatchObject({ reporters: 1 });
    expect(await keys()).toEqual([]);
  });

  it("waits for a landing holding the crowd's lock before deleting reporters", async () => {
    await reporterActive("stale", "2025-09-01T00:00:00Z");
    const landing = await sql.reserve();
    try {
      await landing`BEGIN`;
      await landing`SELECT pg_advisory_xact_lock(hashtext('crowd'))`;
      const swept = sweep(LATER);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await keys()).toEqual(["stale"]);
      await landing`COMMIT`;
      expect(await swept).toMatchObject({ reporters: 1, busy: 0 });
      expect(await keys()).toEqual([]);
    } finally {
      await landing`ROLLBACK`;
      landing.release();
    }
  });

  it("leaves the reporters to the next sweep while a landing holds the crowd's lock past lock_timeout", async () => {
    await reporterActive("stale", "2025-09-01T00:00:00Z");
    const maintenance = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      connection: { lock_timeout: 200 },
    });
    const landing = await sql.reserve();
    try {
      await landing`BEGIN`;
      await landing`SELECT pg_advisory_xact_lock(hashtext('crowd'))`;
      const busy = await sweepRecords(maintenance, {
        ...write,
        now: LATER,
        maxAgeSec: 3600,
        historyDays: 90,
      });
      expect(busy).toMatchObject({ reporters: 0 });
      expect(busy.busy).toBeGreaterThanOrEqual(1);
      expect(await keys()).toEqual(["stale"]);
    } finally {
      await landing`ROLLBACK`;
      landing.release();
      await maintenance.end();
    }
    expect(await sweep(LATER)).toMatchObject({ reporters: 1 });
  });
});
