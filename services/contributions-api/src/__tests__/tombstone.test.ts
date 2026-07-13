import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { readObservations } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { toPublishedArchiveRows } from "@openconditions/publishers";
import { ingestFederatedPage, type FederatedIngestContext } from "../federation/ingest.js";
import { emitTombstone } from "../federation/tombstone.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-07-13T12:00:00.000Z";
const VALID_FROM = new Date(Date.parse(NOW) - 5 * 60_000).toISOString();
const WORLD_BBOX: [number, number, number, number] = [-180, -90, 180, 90];

const PEER_A: FederatedIngestContext = {
  localInstanceId: "local",
  peerInstanceId: "peer-a",
  now: NOW,
};
const PEER_B: FederatedIngestContext = {
  localInstanceId: "local",
  peerInstanceId: "peer-b",
  now: NOW,
};

interface JournalRow {
  operation: string;
  payload_snapshot: Record<string, unknown>;
}

async function journalFor(objectId: string): Promise<JournalRow[]> {
  return sql<JournalRow[]>`
    SELECT operation, payload_snapshot FROM conditions.federation_outbox
    WHERE object_id = ${objectId} ORDER BY seq ASC`;
}

/** postgres-js adapted to core's QueryRunner (the archive/read path). */
const runner = {
  async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
    const rows = p ? await sql.unsafe(q, p as never[]) : await sql.unsafe(q);
    return rows as T;
  },
};

/** The ids a rebuilt static archive would contain — the published-view filter the
 *  GeoParquet archive applies (license, status/tombstone, expiry, privacy) run
 *  over the same DB read the nightly archive build uses. */
async function archiveIds(): Promise<string[]> {
  const obs = await readObservations(runner, { bbox: WORLD_BBOX });
  return toPublishedArchiveRows(obs, NOW).map((r) => r.id);
}

/** A fully-normalized published event as a peer's outbox serves it. */
function fedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ndw:situation-1",
    source: "ndw",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    type: "hazard",
    category: "incident",
    severity: "high",
    severitySource: "declared",
    headline: "Obstruction on A2",
    status: "active",
    validFrom: VALID_FROM,
    geometry: { type: "Point", coordinates: [5.1, 52.1] },
    origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
    dataUpdatedAt: VALID_FROM,
    fetchedAt: VALID_FROM,
    isStale: false,
    instanceId: "peer-a",
    canonicalId: "c0".repeat(32),
    privacyClass: "authoritative",
    ...overrides,
  };
}

function createPage(observation: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "OrderedCollectionPage",
    orderedItems: [
      {
        seq: 1,
        txid: "100",
        operation: "create",
        objectId: observation["id"],
        canonicalId: observation["canonicalId"],
        observation,
      },
    ],
  };
}

function deletePage(
  objectId: string,
  canonicalId: string,
  reason: string,
  seq = 2,
  txid = "200"
): Record<string, unknown> {
  return {
    type: "OrderedCollectionPage",
    orderedItems: [
      { seq, txid, operation: "delete", objectId, canonicalId, tombstone: true, reason },
    ],
  };
}

async function rowStatus(
  id: string
): Promise<
  { status: string; tombstone_reason: string | null; origin: Record<string, unknown> } | undefined
> {
  const rows = await sql<
    { status: string; tombstone_reason: string | null; origin: Record<string, unknown> }[]
  >`
    SELECT status, tombstone_reason, origin FROM conditions.observations WHERE id = ${id}`;
  return rows[0];
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
  sql = postgres(url, { max: 5 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("TTL is data minimisation — a short-TTL row disappears, then sweeps to an expired tombstone", () => {
  it("drops from the published view after expiresAt; a sweep delete emits an 'expired' tombstone", async () => {
    const id = "ttl:short";
    const past = new Date(Date.parse(NOW) - 60_000).toISOString();
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, category, severity, severity_source,
         headline, status, geom, origin, data_updated_at, fetched_at, expires_at,
         canonical_id, instance_id, privacy_class)
      VALUES (${id}, 'ndw', 'datex2', 'roads', 'event', 'incident', 'incident', 'low',
         'declared', 'ephemeral', 'active',
         ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[5.1,52.1]}'), 4326),
         ${sql.json({ kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } })},
         ${past}, ${past}, ${past}, ${"7f".repeat(32)}, 'local', 'authoritative')`;

    // Already past expiresAt → absent from the published read view (minimisation).
    const active = await readObservations(runner, { bbox: WORLD_BBOX });
    expect(active.map((o) => o.id)).not.toContain(id);

    // The sweep hard-deletes it with no reason → an 'expired' outbox tombstone.
    await sql`DELETE FROM conditions.observations WHERE id = ${id}`;
    const entries = await journalFor(id);
    const del = entries.find((e) => e.operation === "delete")!;
    expect(del.payload_snapshot).toMatchObject({ tombstone: true, reason: "expired" });
  }, 30_000);
});

describe("emitTombstone — signed, reasoned, propagated soft tombstone", () => {
  it("archives + scrubs a local crowd row, retains the ledger, and emits a reasoned delete tombstone", async () => {
    const id = "crowd:erase-1";
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, category, severity, severity_source,
         headline, description, status, geom, subject, attributes, origin,
         data_updated_at, fetched_at, canonical_id, instance_id, privacy_class, evidence_state)
      VALUES (${id}, 'crowd', 'crowd', 'roads', 'event', 'incident', 'incident', 'medium',
         'declared', 'Reporter says flooded', 'washed out', 'active',
         ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[4.9,52.3]}'), 4326),
         ${sql.json([{ type: "osm", id: "way/1" }])}, ${sql.json({ direction: "N" })},
         ${sql.json({ kind: "crowd", attribution: { provider: "crowd", license: "CC0-1.0" }, reporter: { keyId: "rk-secret-1", signature: "sig", reputation: 0.9 } })},
         ${NOW}, ${NOW}, ${"e1".repeat(32)}, 'local', 'crowd_pseudonym', 'self_reported')`;
    await sql`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
      VALUES (${id}, 'report', 'rk-secret-1', 'crowd', ${NOW}, ${sql.json({})})`;

    const result = await emitTombstone(sql, id, "gdpr_erasure", NOW);
    expect(result).toEqual({ tombstoned: true });

    const row = await rowStatus(id);
    expect(row!.status).toBe("archived");
    expect(row!.tombstone_reason).toBe("gdpr_erasure");
    // Reporter identity scrubbed from the public row.
    expect(row!.origin["reporter"]).toBeUndefined();
    const scrubbed = await sql<
      {
        headline: string | null;
        description: string | null;
        subject: unknown;
        attributes: Record<string, unknown>;
      }[]
    >`
      SELECT headline, description, subject, attributes FROM conditions.observations WHERE id = ${id}`;
    expect(scrubbed[0]!.headline).toBeNull();
    expect(scrubbed[0]!.description).toBeNull();
    expect(scrubbed[0]!.subject).toBeNull();
    expect(scrubbed[0]!.attributes).toMatchObject({ tombstone: true, reason: "gdpr_erasure" });
    // Audit ledger retained.
    const evid = await sql<
      { n: string }[]
    >`SELECT count(*)::text AS n FROM conditions.report_evidence WHERE observation_id = ${id}`;
    expect(Number(evid[0]!.n)).toBe(1);

    // The soft-archive propagates as a delete tombstone (not an update) with the
    // reason; the row's own INSERT already journalled the 'create'.
    const entries = await journalFor(id);
    expect(entries.map((e) => e.operation)).toEqual(["create", "delete"]);
    const del = entries.find((e) => e.operation === "delete")!;
    expect(del.payload_snapshot).toMatchObject({ tombstone: true, reason: "gdpr_erasure" });

    // Absent from the published read view AND a rebuilt archive.
    const active = await readObservations(runner, { bbox: WORLD_BBOX });
    expect(active.map((o) => o.id)).not.toContain(id);
    expect(await archiveIds()).not.toContain(id);
  }, 30_000);

  it("is idempotent — a second call and a missing row are no-ops", async () => {
    const id = "crowd:erase-2";
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, status, geom, origin,
         data_updated_at, fetched_at, canonical_id, instance_id, privacy_class)
      VALUES (${id}, 'crowd', 'crowd', 'roads', 'event', 'active',
         ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[4.9,52.3]}'), 4326),
         ${sql.json({ kind: "crowd", attribution: { provider: "crowd", license: "CC0-1.0" } })},
         ${NOW}, ${NOW}, ${"e2".repeat(32)}, 'local', 'crowd_pseudonym')`;
    expect(await emitTombstone(sql, id, "retracted_as_wrong", NOW)).toEqual({ tombstoned: true });
    expect(await emitTombstone(sql, id, "retracted_as_wrong", NOW)).toEqual({ tombstoned: false });
    expect(await emitTombstone(sql, "crowd:missing", "gdpr_erasure", NOW)).toEqual({
      tombstoned: false,
    });
    // Only one delete tombstone was emitted.
    const entries = await journalFor(id);
    expect(entries.filter((e) => e.operation === "delete")).toHaveLength(1);
  }, 30_000);
});

describe("inbox apply — an incoming federation tombstone", () => {
  it("tombstones a local copy the sending peer OWNS (its own instance)", async () => {
    const canonicalId = "aa".repeat(32);
    await ingestFederatedPage(sql, createPage(fedEvent({ id: "peer-a:own", canonicalId })), PEER_A);
    const res = await ingestFederatedPage(
      sql,
      deletePage("peer-a:own", canonicalId, "deleted_by_source"),
      PEER_A
    );
    expect(res.tombstoned).toBe(1);
    expect(res.skipped).toEqual([]);
    const row = await rowStatus("peer-a:own");
    expect(row!.status).toBe("archived");
    expect(row!.tombstone_reason).toBe("deleted_by_source");
  }, 30_000);

  it("tombstones a same-source FEED copy this instance did not originate", async () => {
    const canonicalId = "bb".repeat(32);
    // Landed from peer-a, then peer-b (which independently ingested the same NDW
    // feed record, matching canonicalId) tombstones it.
    await ingestFederatedPage(
      sql,
      createPage(fedEvent({ id: "peer-a:feed", canonicalId })),
      PEER_A
    );
    const res = await ingestFederatedPage(
      sql,
      deletePage("peer-b:feed", canonicalId, "expired"),
      PEER_B
    );
    expect(res.tombstoned).toBe(1);
    expect((await rowStatus("peer-a:feed"))!.status).toBe("archived");
  }, 30_000);

  it("refuses a tombstone against a LOCAL row (non-owned-collision, no-op)", async () => {
    const id = "local:keep";
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, status, geom, origin,
         data_updated_at, fetched_at, canonical_id, instance_id, privacy_class)
      VALUES (${id}, 'ndw', 'datex2', 'roads', 'event', 'active',
         ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[5.1,52.1]}'), 4326),
         ${sql.json({ kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } })},
         ${NOW}, ${NOW}, ${"cc".repeat(32)}, 'local', 'authoritative')`;
    const res = await ingestFederatedPage(
      sql,
      deletePage(id, "cc".repeat(32), "legal_takedown"),
      PEER_A
    );
    expect(res.tombstoned).toBe(0);
    expect(res.skipped).toEqual([{ objectId: id, reason: "non-owned-collision" }]);
    expect((await rowStatus(id))!.status).toBe("active");
  }, 30_000);

  it("refuses a tombstone against ANOTHER instance's CROWD row (non-owned-collision)", async () => {
    const canonicalId = "dd".repeat(32);
    // A CROWD row owned by peer-a: its canonicalId is instance-namespaced, so it
    // is NOT a same-source-feed record any peer may retract. peer-b tombstoning
    // it (even with the matching canonicalId) owns nothing here.
    await ingestFederatedPage(
      sql,
      createPage(
        fedEvent({
          id: "peer-a:xinst",
          canonicalId,
          origin: { kind: "crowd", attribution: { provider: "crowd", license: "CC0-1.0" } },
          privacyClass: "crowd_pseudonym",
          evidenceState: "self_reported",
        })
      ),
      PEER_A
    );
    const res = await ingestFederatedPage(
      sql,
      deletePage("peer-a:xinst", canonicalId, "gdpr_erasure"),
      PEER_B
    );
    expect(res.tombstoned).toBe(0);
    expect(res.skipped[0]!.reason).toBe("non-owned-collision");
    expect((await rowStatus("peer-a:xinst"))!.status).toBe("active");
  }, 30_000);

  it("reports a tombstone whose target is unknown here", async () => {
    const res = await ingestFederatedPage(
      sql,
      deletePage("peer-a:ghost", "ff".repeat(32), "expired"),
      PEER_A
    );
    expect(res.tombstoned).toBe(0);
    expect(res.skipped).toEqual([
      { objectId: "peer-a:ghost", reason: "tombstone-target-not-found" },
    ]);
  }, 30_000);

  it("a gdpr_erasure from the owning peer removes a long-lived copy from the view + archive", async () => {
    const canonicalId = "1a".repeat(32);
    await ingestFederatedPage(
      sql,
      createPage(fedEvent({ id: "peer-a:longlived", canonicalId })),
      PEER_A
    );
    expect(await archiveIds()).toContain("peer-a:longlived");

    const res = await ingestFederatedPage(
      sql,
      deletePage("peer-a:longlived", canonicalId, "gdpr_erasure"),
      PEER_A
    );
    expect(res.tombstoned).toBe(1);

    const active = await readObservations(runner, { bbox: WORLD_BBOX });
    expect(active.map((o) => o.id)).not.toContain("peer-a:longlived");
    expect(await archiveIds()).not.toContain("peer-a:longlived");
    // The apply re-emits a signed delete tombstone for onward propagation.
    const entries = await journalFor("peer-a:longlived");
    expect(
      entries.some(
        (e) => e.operation === "delete" && e.payload_snapshot["reason"] === "gdpr_erasure"
      )
    ).toBe(true);
  }, 30_000);
});

describe("terminal tombstone — a retraction is terminal for 30 days (no resurrection)", () => {
  it("a same-origin resupply with a newer version does NOT resurrect a tombstoned row", async () => {
    const canonicalId = "2b".repeat(32);
    await ingestFederatedPage(sql, createPage(fedEvent({ id: "peer-a:res", canonicalId })), PEER_A);
    expect(await emitTombstone(sql, "peer-a:res", "gdpr_erasure", NOW)).toEqual({
      tombstoned: true,
    });

    // A resupply of the SAME record with a strictly newer dataUpdatedAt.
    const newer = new Date(Date.parse(NOW) + 3_600_000).toISOString();
    const res = await ingestFederatedPage(
      sql,
      createPage(
        fedEvent({ id: "peer-a:res", canonicalId, headline: "RESURRECTED", dataUpdatedAt: newer })
      ),
      PEER_A
    );
    expect(res.accepted).toBe(0);
    expect(res.resupplied).toBe(0);
    expect(res.skipped).toEqual([{ objectId: "peer-a:res", reason: "tombstoned" }]);

    // The row stays archived and scrubbed — the tombstone won.
    const row = await rowStatus("peer-a:res");
    expect(row!.status).toBe("archived");
    const [content] = await sql<{ headline: string | null }[]>`
      SELECT headline FROM conditions.observations WHERE id = 'peer-a:res'`;
    expect(content!.headline).toBeNull();
  }, 30_000);

  it("refuses a create of a canonicalId whose tombstone arrived BEFORE the object (the race)", async () => {
    const canonicalId = "3c".repeat(32);
    // The tombstone lands first — no local row yet, but the fact is recorded.
    const t = await ingestFederatedPage(
      sql,
      deletePage("peer-a:race", canonicalId, "deleted_by_source"),
      PEER_A
    );
    expect(t.skipped).toEqual([{ objectId: "peer-a:race", reason: "tombstone-target-not-found" }]);

    // The create races in afterwards — refused, never resurrected.
    const c = await ingestFederatedPage(
      sql,
      createPage(fedEvent({ id: "peer-a:race", canonicalId })),
      PEER_A
    );
    expect(c.accepted).toBe(0);
    expect(c.skipped).toEqual([{ objectId: "peer-a:race", reason: "tombstoned" }]);
    expect(await rowStatus("peer-a:race")).toBeUndefined();
  }, 30_000);
});

describe("GDPR journal residue — a gdpr_erasure scrubs historical outbox snapshots", () => {
  it("removes free-text from prior create/update snapshots while keeping the tombstone entry", async () => {
    const id = "crowd:residue";
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, category, severity, severity_source,
         headline, description, status, geom, subject, attributes, origin,
         data_updated_at, fetched_at, canonical_id, instance_id, privacy_class)
      VALUES (${id}, 'crowd', 'crowd', 'roads', 'event', 'incident', 'incident', 'medium',
         'declared', 'SECRETHEADLINE', 'SECRETDESC', 'active',
         ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[4.9,52.3]}'), 4326),
         ${sql.json([{ type: "osm", id: "way/SECRETSUBJECT" }])}, ${sql.json({ note: "SECRETATTR" })},
         ${sql.json({ kind: "crowd", attribution: { provider: "crowd", license: "CC0-1.0" } })},
         ${NOW}, ${NOW}, ${"4d".repeat(32)}, 'local', 'crowd_pseudonym')`;
    // A second version → an update snapshot also carrying free text.
    await sql`UPDATE conditions.observations SET headline = 'SECRETHEADLINE2' WHERE id = ${id}`;

    expect(await emitTombstone(sql, id, "gdpr_erasure", NOW)).toEqual({ tombstoned: true });

    const entries = await journalFor(id);
    // No non-delete snapshot still carries any of the erased free text.
    for (const e of entries.filter((x) => x.operation !== "delete")) {
      expect(JSON.stringify(e.payload_snapshot)).not.toContain("SECRET");
    }
    // Structural keys survive on the create snapshot.
    const create = entries.find((e) => e.operation === "create")!;
    expect(create.payload_snapshot["id"]).toBe(id);
    expect(create.payload_snapshot["canonical_id"]).toBe("4d".repeat(32));
    // The tombstone entry is intact with its reason.
    expect(
      entries.some(
        (e) => e.operation === "delete" && e.payload_snapshot["reason"] === "gdpr_erasure"
      )
    ).toBe(true);
  }, 30_000);
});
