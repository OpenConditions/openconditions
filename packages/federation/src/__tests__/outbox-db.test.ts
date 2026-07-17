import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import type { Observation } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { filterForPermissiveExport } from "@openconditions/publishers";
import { encodeOutboxCursor, readOutbox, type OutboxCursor, type OutboxEntry } from "../outbox.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const FEED_ORIGIN = {
  kind: "feed",
  attribution: { provider: "Test Authority", license: "CC-BY-4.0" },
};

const CROWD_ORIGIN = {
  kind: "crowd",
  attribution: { provider: "OpenConditions crowd", license: "CC0-1.0" },
  reporter: { keyId: "rk-secret-thumbprint-1", signature: "sig-bytes", reputation: 0.9 },
};

interface JournalRow {
  seq: string | number;
  object_id: string;
  operation: string;
  canonical_id: string | null;
  payload_snapshot: Record<string, unknown>;
  created_at: Date;
}

async function journalFor(objectId: string): Promise<JournalRow[]> {
  return sql<JournalRow[]>`
    SELECT seq, object_id, operation, canonical_id, payload_snapshot, created_at
    FROM conditions.federation_outbox
    WHERE object_id = ${objectId}
    ORDER BY seq ASC`;
}

/** The current maximum committed composite `(txid, seq)` cursor — a baseline
 *  that any subsequent (higher-txid) insert sorts strictly after. */
async function frontier(): Promise<OutboxCursor> {
  const [row] = await sql<{ txid: string; seq: string }[]>`
    SELECT txid::text AS txid, seq::text AS seq
    FROM conditions.federation_outbox
    ORDER BY txid DESC, seq DESC
    LIMIT 1`;
  return row ? { txid: row.txid, seq: Number(row.seq) } : { txid: "0", seq: 0 };
}

/** The wire-encoded composite cursor of a served entry. */
function cursorOf(entry: OutboxEntry): string {
  return encodeOutboxCursor({ txid: entry.txid, seq: entry.seq });
}

async function insertObservation(
  db: postgres.Sql | postgres.TransactionSql | postgres.ReservedSql,
  id: string,
  opts: {
    headline?: string;
    origin?: Record<string, unknown>;
    canonicalId?: string | null;
    lon?: number;
    privacyClass?: string;
    evidenceState?: string | null;
  } = {}
): Promise<void> {
  const geometry = { type: "Point", coordinates: [opts.lon ?? 5.1, 52.1] };
  await db`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, category, severity, severity_source,
       headline, status, geom, origin, data_updated_at, fetched_at,
       canonical_id, privacy_class, evidence_state)
    VALUES (${id}, 'outbox-test', 'datex2', 'roads', 'event', 'incident', 'incident', 'medium',
       'declared', ${opts.headline ?? "headline v1"}, 'active',
       ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326),
       ${db.json((opts.origin ?? FEED_ORIGIN) as never)},
       '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z',
       ${opts.canonicalId ?? null}, ${opts.privacyClass ?? "authoritative"},
       ${opts.evidenceState ?? null})`;
}

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
  // The capture trigger only journals when a peer SUBSCRIBES (migration 0023) —
  // an instance with no peers must not accumulate a journal nothing will read.
  // These suites assert the capture itself, so give them a subscriber.
  await seedSubscriber();
}, 120_000);

/** One active pull subscription — the capture trigger's gate condition. */
async function seedSubscriber(): Promise<void> {
  await sql`
    INSERT INTO conditions.federation_subscription
      (id, peer_id, delivery_mode, created_at, updated_at)
    VALUES ('sub-capture-gate', 'peer-capture-gate', 'pull', now(), now())
    ON CONFLICT (id) DO NOTHING`;
}

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("federation_outbox trigger — gated on there being a subscriber", () => {
  // Regression: the ungated trigger journalled ~1.4M rows/hour of feed churn on
  // an instance with zero peers, which nothing would ever read and the retention
  // floor refused to prune. It filled the disk and took Postgres down.
  it("journals NOTHING while no peer subscribes", async () => {
    await sql`DELETE FROM conditions.federation_subscription`;
    try {
      await insertObservation(sql, "obs-nosub", { canonicalId: "can-nosub" });
      await sql`UPDATE conditions.observations SET headline = 'v2' WHERE id = 'obs-nosub'`;
      await sql`DELETE FROM conditions.observations WHERE id = 'obs-nosub'`;
      expect(await journalFor("obs-nosub")).toEqual([]);
    } finally {
      await seedSubscriber();
    }
  }, 30_000);

  it("starts journalling as soon as a peer subscribes", async () => {
    await sql`DELETE FROM conditions.federation_subscription`;
    await insertObservation(sql, "obs-latesub", { canonicalId: "can-latesub" });
    expect(await journalFor("obs-latesub")).toEqual([]);

    await seedSubscriber();
    await sql`UPDATE conditions.observations SET headline = 'v2' WHERE id = 'obs-latesub'`;

    // Only the post-subscription mutation is journalled — the pre-subscription
    // create is deliberately absent (the documented trade-off in 0023).
    const entries = await journalFor("obs-latesub");
    expect(entries.map((e) => e.operation)).toEqual(["update"]);
  }, 30_000);
});

describe("federation_outbox trigger — transactional capture", () => {
  it("captures create, update and delete as three entries in order", async () => {
    await insertObservation(sql, "obs-lifecycle", { canonicalId: "can-lifecycle" });
    await sql`UPDATE conditions.observations SET headline = 'headline v2' WHERE id = 'obs-lifecycle'`;
    await sql`DELETE FROM conditions.observations WHERE id = 'obs-lifecycle'`;

    const entries = await journalFor("obs-lifecycle");
    expect(entries.map((e) => e.operation)).toEqual(["create", "update", "delete"]);
    expect(entries.map((e) => e.canonical_id)).toEqual([
      "can-lifecycle",
      "can-lifecycle",
      "can-lifecycle",
    ]);
    const seqs = entries.map((e) => Number(e.seq));
    expect(seqs[0]).toBeLessThan(seqs[1]!);
    expect(seqs[1]).toBeLessThan(seqs[2]!);
  }, 30_000);

  it("a bare delete appends a minimal tombstone marker with the default 'expired' reason", async () => {
    await insertObservation(sql, "obs-tombstone", { canonicalId: "can-tombstone" });
    await sql`DELETE FROM conditions.observations WHERE id = 'obs-tombstone'`;

    const entries = await journalFor("obs-tombstone");
    expect(entries[1]!.payload_snapshot).toEqual({
      id: "obs-tombstone",
      canonical_id: "can-tombstone",
      tombstone: true,
      reason: "expired",
    });
  }, 30_000);

  it("a delete carries the row's tombstone_reason when one was set", async () => {
    await insertObservation(sql, "obs-reason", { canonicalId: "can-reason" });
    await sql`UPDATE conditions.observations SET tombstone_reason = 'legal_takedown' WHERE id = 'obs-reason'`;
    await sql`DELETE FROM conditions.observations WHERE id = 'obs-reason'`;

    const entries = await journalFor("obs-reason");
    const del = entries.find((e) => e.operation === "delete")!;
    expect(del.payload_snapshot).toMatchObject({ tombstone: true, reason: "legal_takedown" });
  }, 30_000);

  it("a soft-archive (status -> archived) propagates as a delete tombstone, not an update", async () => {
    await insertObservation(sql, "obs-soft", { canonicalId: "can-soft" });
    await sql`
      UPDATE conditions.observations
      SET status = 'archived', tombstone_reason = 'gdpr_erasure'
      WHERE id = 'obs-soft'`;

    const entries = await journalFor("obs-soft");
    expect(entries.map((e) => e.operation)).toEqual(["create", "delete"]);
    const del = entries[1]!;
    expect(del.payload_snapshot).toEqual({
      id: "obs-soft",
      canonical_id: "can-soft",
      tombstone: true,
      reason: "gdpr_erasure",
    });
  }, 30_000);

  it("keeps point-in-time snapshots: two real updates leave two distinct payloads", async () => {
    await insertObservation(sql, "obs-pit", { headline: "pit v1" });
    await sql`UPDATE conditions.observations SET headline = 'pit v2' WHERE id = 'obs-pit'`;
    await sql`UPDATE conditions.observations SET headline = 'pit v3' WHERE id = 'obs-pit'`;

    const entries = await journalFor("obs-pit");
    expect(entries.map((e) => e.operation)).toEqual(["create", "update", "update"]);
    expect(entries.map((e) => e.payload_snapshot["headline"])).toEqual([
      "pit v1",
      "pit v2",
      "pit v3",
    ]);
  }, 30_000);

  it("a no-op UPDATE (identical row image) appends nothing", async () => {
    await insertObservation(sql, "obs-noop");
    await sql`UPDATE conditions.observations SET headline = headline WHERE id = 'obs-noop'`;

    const entries = await journalFor("obs-noop");
    expect(entries.map((e) => e.operation)).toEqual(["create"]);
  }, 30_000);

  it("a rolled-back transaction appends nothing", async () => {
    await expect(
      sql.begin(async (tx) => {
        await insertObservation(tx, "obs-rollback");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await journalFor("obs-rollback")).toEqual([]);
    const rows = await sql`SELECT id FROM conditions.observations WHERE id = 'obs-rollback'`;
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("stores the geometry snapshot as GeoJSON", async () => {
    await insertObservation(sql, "obs-geom", { lon: 6.6 });
    const entries = await journalFor("obs-geom");
    expect(entries[0]!.payload_snapshot["geom"]).toMatchObject({
      type: "Point",
      coordinates: [6.6, 52.1],
    });
  }, 30_000);
});

describe("federation_outbox trigger — no raw reporter identity at rest", () => {
  it("strips origin.reporter from crowd snapshots, matching the app-level stripReporter", async () => {
    await insertObservation(sql, "obs-crowd", {
      origin: CROWD_ORIGIN,
      privacyClass: "crowd_pseudonym",
      evidenceState: "self_reported",
    });

    const entries = await journalFor("obs-crowd");
    const origin = entries[0]!.payload_snapshot["origin"] as Record<string, unknown>;
    expect(Object.keys(origin).sort()).toEqual(["attribution", "kind"]);

    const serialized = JSON.stringify(entries[0]!.payload_snapshot);
    expect(serialized).not.toContain("rk-secret-thumbprint-1");
    expect(serialized).not.toContain("sig-bytes");
    expect(serialized).not.toContain("reporter");

    const [appStripped] = filterForPermissiveExport([
      { origin: CROWD_ORIGIN } as unknown as Observation,
    ]);
    expect(origin).toEqual(appStripped!.origin);
  }, 30_000);
});

describe("readOutbox — the composite (txid, seq) cursor page", () => {
  it("returns entries after the cursor in order, respecting the limit", async () => {
    const base = await frontier();
    await insertObservation(sql, "page-a", { headline: "page a" });
    await insertObservation(sql, "page-b", { headline: "page b" });
    await insertObservation(sql, "page-c", { headline: "page c" });

    const page = await readOutbox(sql, { after: base, limit: 2 });
    expect(page.type).toBe("OrderedCollectionPage");
    expect(page.orderedItems.map((e) => e.objectId)).toEqual(["page-a", "page-b"]);
    expect(page.highWaterMark).toBe(cursorOf(page.orderedItems[1]!));
    expect(page.next).toBe(`/peer/outbox?after=${page.highWaterMark}`);

    const rest = await readOutbox(sql, { after: page.highWaterMark, limit: 100 });
    expect(rest.orderedItems.map((e) => e.objectId)).toEqual(["page-c"]);
    expect(rest.next).toBeUndefined();
  }, 30_000);

  it("maps create snapshots back to the wire Observation shape", async () => {
    const base = await frontier();
    await insertObservation(sql, "wire-a", { headline: "wire headline", lon: 5.3 });

    const page = await readOutbox(sql, { after: base });
    const item = page.orderedItems.find((e) => e.objectId === "wire-a")!;
    expect(item.operation).toBe("create");
    const observation = item.observation!;
    expect(observation.id).toBe("wire-a");
    expect(observation.geometry).toEqual({ type: "Point", coordinates: [5.3, 52.1] });
    expect(observation.origin).toEqual(FEED_ORIGIN);
    expect(observation.privacyClass).toBe("authoritative");
    expect((observation as { headline?: string }).headline).toBe("wire headline");
  }, 30_000);

  it("keeps a delete entry as a tombstone marker and surfaces its reason", async () => {
    const base = await frontier();
    await insertObservation(sql, "wire-del", { canonicalId: "can-del" });
    await sql`DELETE FROM conditions.observations WHERE id = 'wire-del'`;

    const page = await readOutbox(sql, { after: base });
    const del = page.orderedItems.find((e) => e.operation === "delete")!;
    expect(del.tombstone).toBe(true);
    expect(del.objectId).toBe("wire-del");
    expect(del.canonicalId).toBe("can-del");
    expect(del.reason).toBe("expired");
    expect(del.observation).toBeUndefined();
  }, 30_000);

  it("accepts the wire-encoded highWaterMark string as the next `after`", async () => {
    const base = await frontier();
    await insertObservation(sql, "chain-a");
    await insertObservation(sql, "chain-b");

    const first = await readOutbox(sql, { after: base, limit: 1 });
    expect(first.orderedItems.map((e) => e.objectId)).toEqual(["chain-a"]);
    // highWaterMark is a "<txid>.<seq>" string fed straight back in.
    const second = await readOutbox(sql, { after: first.highWaterMark, limit: 1 });
    expect(second.orderedItems.map((e) => e.objectId)).toEqual(["chain-b"]);
  }, 30_000);

  it("is idempotent on retry: re-fetching the same cursor returns the same entries", async () => {
    const base = await frontier();
    await insertObservation(sql, "retry-a");
    await insertObservation(sql, "retry-b");

    const first = await readOutbox(sql, { after: base });
    const second = await readOutbox(sql, { after: base });
    expect(second.orderedItems).toEqual(first.orderedItems);
    expect(second.highWaterMark).toBe(first.highWaterMark);
  }, 30_000);

  it("advances the highWaterMark even when the filter drops every scanned entry", async () => {
    const base = await frontier();
    await insertObservation(sql, "filtered-a", { lon: 5.1 });
    await insertObservation(sql, "filtered-b", { lon: 5.2 });

    const page = await readOutbox(sql, {
      after: base,
      filter: { bbox: [100, 0, 101, 1] },
    });
    expect(page.orderedItems).toEqual([]);
    expect(page.highWaterMark).not.toBe(encodeOutboxCursor(base));
    expect(page.highWaterMark).toBe(encodeOutboxCursor(await frontier()));
  }, 30_000);

  it("filters at source: an out-of-bbox entry leaves a seq gap", async () => {
    const base = await frontier();
    await insertObservation(sql, "bbox-in", { lon: 5.1 });
    await insertObservation(sql, "bbox-out", { lon: 100.5 });
    await insertObservation(sql, "bbox-in-2", { lon: 5.2 });

    const page = await readOutbox(sql, {
      after: base,
      filter: { bbox: [5.0, 52.0, 5.5, 52.5] },
    });
    expect(page.orderedItems.map((e) => e.objectId)).toEqual(["bbox-in", "bbox-in-2"]);
    const seqs = page.orderedItems.map((e) => e.seq);
    expect(seqs[1]! - seqs[0]!).toBe(2);
    expect(page.highWaterMark).toBe(cursorOf(page.orderedItems[1]!));
  }, 30_000);

  it("leaves an untouched cursor when there is nothing new", async () => {
    const base = await frontier();
    const page = await readOutbox(sql, { after: base });
    expect(page.orderedItems).toEqual([]);
    expect(page.highWaterMark).toBe(encodeOutboxCursor(base));
    expect(page.next).toBeUndefined();
  }, 30_000);
});

describe("readOutbox — the aligned-case xmin fence (no permanent skip)", () => {
  it("holds the frontier below an in-flight transaction, then delivers with no skip", async () => {
    const base = await frontier();

    // A slow transaction grabs the LOWER seq (bigserial is assigned at INSERT,
    // not COMMIT) but stays open, while a fast transaction commits a HIGHER seq.
    const slow = await sql.reserve();
    let slowSeq: number;
    let fastSeq: number;
    try {
      await slow`BEGIN`;
      await insertObservation(slow, "fence-slow", { headline: "slow" });
      const [slowRow] = await slow<{ seq: string }[]>`
        SELECT seq::text AS seq FROM conditions.federation_outbox WHERE object_id = 'fence-slow'`;
      slowSeq = Number(slowRow!.seq);

      // A separate pooled connection: commits immediately with the higher seq.
      await insertObservation(sql, "fence-fast", { headline: "fast" });
      const [fastRow] = await sql<{ seq: string }[]>`
        SELECT seq::text AS seq FROM conditions.federation_outbox WHERE object_id = 'fence-fast'`;
      fastSeq = Number(fastRow!.seq);
      expect(slowSeq).toBeLessThan(fastSeq);

      // While the slow tx is in flight the fence withholds BOTH: the fast row's
      // txid is >= the still-running slow tx's, so neither is below xmin. The
      // reader's cursor cannot advance past the not-yet-committed slow tx.
      const fenced = await readOutbox(sql, { after: base });
      const servedIds = fenced.orderedItems.map((e) => e.objectId);
      expect(servedIds).not.toContain("fence-fast");
      expect(servedIds).not.toContain("fence-slow");
      expect(fenced.highWaterMark).toBe(encodeOutboxCursor(base));

      await slow`COMMIT`;
    } finally {
      await slow.release();
    }

    // With no in-flight writer both settle below xmin; a poll from the same
    // baseline delivers BOTH — the slow (lower) seq is never skipped.
    const after = await readOutbox(sql, { after: base, limit: 500 });
    const ids = after.orderedItems.map((e) => e.objectId);
    expect(ids).toContain("fence-slow");
    expect(ids).toContain("fence-fast");
    const slowEntry = after.orderedItems.find((e) => e.objectId === "fence-slow")!;
    expect(slowEntry.seq).toBe(slowSeq);
  }, 30_000);
});

describe("readOutbox — the composite cursor closes the interleaving skip", () => {
  // The reviewer's reachable scenario: R1 (earlier BEGIN → LOWER txid) holds
  // seqs that interleave ABOVE R2 (later BEGIN → HIGHER txid). A bare seq cursor
  // fenced only by xmin would serve R1's higher seqs, advance past them, and
  // then permanently skip R2's lower seqs once R2 commits. The composite
  // (txid, seq) cursor advances in TRANSACTION order, so R2 (higher txid) always
  // sorts after the cursor and is delivered on the next poll.
  it("delivers a later-txid, lower-seq transaction after the reader passed the earlier-txid rows", async () => {
    const base = await frontier();

    const r1 = await sql.reserve();
    const r2 = await sql.reserve();
    try {
      // R1 begins first → lower txid; its first row gets the lowest seq.
      await r1`BEGIN`;
      await insertObservation(r1, "r1-first", { headline: "r1 first" });

      // R2 begins next → higher txid; its row gets a MIDDLE seq.
      await r2`BEGIN`;
      await insertObservation(r2, "r2-only", { headline: "r2 only" });

      // R1 writes AGAIN → same (low) txid, but a seq ABOVE R2's row. This is the
      // interleaving: (r1.txid, r1-first.seq) < (r2.txid, r2-only.seq) <
      // (r1.txid, r1-second.seq) is FALSE under (txid, seq) order — r1-second
      // sorts with r1-first (same low txid), both before r2-only.
      await insertObservation(r1, "r1-second", { headline: "r1 second" });

      // Each row's (txid, seq) is only visible inside its own still-open
      // transaction (READ COMMITTED hides uncommitted rows from other conns).
      const r1Rows = await r1<{ object_id: string; txid: string; seq: string }[]>`
        SELECT object_id, txid::text AS txid, seq::text AS seq
        FROM conditions.federation_outbox
        WHERE object_id IN ('r1-first', 'r1-second')
        ORDER BY seq ASC`;
      const [r2Row] = await r2<{ txid: string; seq: string }[]>`
        SELECT txid::text AS txid, seq::text AS seq
        FROM conditions.federation_outbox WHERE object_id = 'r2-only'`;
      const r1First = r1Rows.find((r) => r.object_id === "r1-first")!;
      const r1Second = r1Rows.find((r) => r.object_id === "r1-second")!;

      // The interleaving that breaks a bare seq cursor: physical seq order is
      // r1-first < r2-only < r1-second, yet r1's txid is BELOW r2's.
      expect(Number(r1First.seq)).toBeLessThan(Number(r2Row!.seq));
      expect(Number(r2Row!.seq)).toBeLessThan(Number(r1Second.seq));
      expect(BigInt(r1First.txid)).toBeLessThan(BigInt(r2Row!.txid));

      // R1 commits; R2 is still open. The fence withholds everything at/above
      // R2's txid, so the reader sees NOTHING yet (R1's rows share no txid below
      // xmin while R2 runs) — its cursor does not advance past R2.
      await r1`COMMIT`;
      const afterR1 = await readOutbox(sql, { after: base, limit: 500 });
      expect(afterR1.orderedItems.map((e) => e.objectId)).not.toContain("r2-only");

      // R2 commits; now the reader drains from the SAME baseline. Both R1 rows
      // and R2's row are delivered — critically R2's LOWER-seq row is NOT
      // skipped even though the reader would have passed R1's higher seq.
      await r2`COMMIT`;
    } finally {
      await r1.release();
      await r2.release();
    }

    const drained = await readOutbox(sql, { after: base, limit: 500 });
    const ids = drained.orderedItems.map((e) => e.objectId);
    expect(ids).toContain("r1-first");
    expect(ids).toContain("r1-second");
    expect(ids).toContain("r2-only");
    // Delivery order is (txid, seq): both r1 rows (lower txid) precede r2-only.
    expect(ids.indexOf("r1-first")).toBeLessThan(ids.indexOf("r2-only"));
    expect(ids.indexOf("r1-second")).toBeLessThan(ids.indexOf("r2-only"));
  }, 30_000);

  it("does not skip R2 when a reader drains R1 BEFORE R2 commits (the real skip case)", async () => {
    const base = await frontier();

    const r1 = await sql.reserve();
    const r2 = await sql.reserve();
    try {
      await r1`BEGIN`;
      await insertObservation(r1, "skip-r1a", { headline: "r1 a" });
      await r2`BEGIN`;
      await insertObservation(r2, "skip-r2", { headline: "r2" });
      await insertObservation(r1, "skip-r1b", { headline: "r1 b" });

      // R1 commits and the reader ADVANCES its cursor over R1's rows while R2 is
      // still open. Under a bare seq cursor this is the fatal step: the cursor
      // would jump to skip-r1b's (highest) seq and skip R2's lower seq forever.
      await r1`COMMIT`;
      const firstPoll = await readOutbox(sql, { after: base, limit: 500 });
      const advanced = firstPoll.highWaterMark;

      // Now R2 commits, and the reader polls from its ADVANCED cursor.
      await r2`COMMIT`;
      const secondPoll = await readOutbox(sql, { after: advanced, limit: 500 });
      // R2's row MUST appear: its higher txid sorts after the advanced cursor.
      expect(secondPoll.orderedItems.map((e) => e.objectId)).toContain("skip-r2");
    } finally {
      await r1.release();
      await r2.release();
    }
  }, 30_000);
});
