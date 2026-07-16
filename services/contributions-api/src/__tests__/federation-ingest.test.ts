import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { phenomenonFingerprint, type ConditionEvent, type OriginHop } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import {
  FederatedPageError,
  ingestFederatedObservation,
  ingestFederatedPage,
  ingestPeerOutbox,
  type FederatedIngestContext,
} from "../federation/ingest.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = new Date().toISOString();
const VALID_FROM = new Date(Date.now() - 5 * 60_000).toISOString();

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

/** A fully-normalized published view, as a peer's outbox would serve it. */
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

interface DbRow {
  id: string;
  status: string;
  headline: string | null;
  instance_id: string | null;
  canonical_id: string | null;
  privacy_class: string;
  dp_epsilon: number | null;
  evidence_state: string | null;
  confidence_score: number | null;
  routing_eligible: boolean;
  corroborations: string[] | null;
  data_updated_at: Date;
  origin: {
    kind: string;
    reporter?: unknown;
    originChain?: OriginHop[];
  };
}

async function rowById(id: string): Promise<DbRow | undefined> {
  const rows = await sql<DbRow[]>`
    SELECT id, status, headline, instance_id, canonical_id, privacy_class,
           dp_epsilon, evidence_state, confidence_score, routing_eligible,
           corroborations, data_updated_at, origin
    FROM conditions.observations WHERE id = ${id}`;
  return rows[0];
}

async function rowsByCanonical(canonicalId: string): Promise<DbRow[]> {
  return sql<DbRow[]>`
    SELECT id, status, headline, instance_id, canonical_id, privacy_class,
           dp_epsilon, evidence_state, confidence_score, routing_eligible,
           corroborations, data_updated_at, origin
    FROM conditions.observations WHERE canonical_id = ${canonicalId}`;
}

async function evidenceCount(obsId: string): Promise<{ kind: string; actor: string | null }[]> {
  const rows = await sql<{ evidence_kind: string; actor_key_id: string | null }[]>`
    SELECT evidence_kind, actor_key_id FROM conditions.report_evidence
    WHERE observation_id = ${obsId} ORDER BY id`;
  return rows.map((r) => ({ kind: r.evidence_kind, actor: r.actor_key_id }));
}

describe("federation context preserves origin (landing)", () => {
  it("lands a federated event with preserved instanceId/canonicalId/privacyClass and dpEpsilon", async () => {
    const canonicalId = "a1".repeat(32);
    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-a:agg-1",
        canonicalId,
        privacyClass: "dp_noised",
        dpEpsilon: 0.5,
        origin: {
          kind: "crowd",
          attribution: { provider: "Peer A", license: "ODbL-1.0" },
          reporter: { keyId: "leaked-reporter-key" },
        },
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");

    const row = await rowById("peer-a:agg-1");
    expect(row).toBeDefined();
    expect(row!.instance_id).toBe("peer-a");
    expect(row!.canonical_id).toBe(canonicalId);
    expect(row!.privacy_class).toBe("dp_noised");
    expect(row!.dp_epsilon).toBe(0.5);
    // Never store another instance's reporter identity.
    expect(row!.origin.reporter).toBeUndefined();
    // The receipt hop records origin instance + via-peer.
    expect(row!.origin.originChain).toEqual([
      { instanceId: "peer-a", viaPeer: "peer-a", receivedAt: NOW },
    ]);
    // One initial report evidence row, actor NULL (no federated reporter key).
    expect(await evidenceCount("peer-a:agg-1")).toEqual([{ kind: "report", actor: null }]);
  });

  it("strips a smuggled reporter off a FEED-origin federated event (persisted row has none)", async () => {
    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-a:feed-smuggle",
        canonicalId: "aa".repeat(32),
        origin: {
          kind: "feed",
          attribution: { provider: "Peer A", license: "CC0-1.0" },
          reporter: { keyId: "smuggled-feed-key" },
        },
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");

    const row = await rowById("peer-a:feed-smuggle");
    expect(row!.origin.kind).toBe("feed");
    // The smuggled foreign key is NOT persisted into provenance.
    expect(row!.origin.reporter).toBeUndefined();
    const raw = await sql<{ origin: { reporter?: unknown } }[]>`
      SELECT origin FROM conditions.observations WHERE id = 'peer-a:feed-smuggle'`;
    expect(raw[0]!.origin.reporter).toBeUndefined();
    expect(JSON.stringify(raw[0]!.origin)).not.toContain("smuggled-feed-key");
  });

  it("rejects an event whose instanceId is a THIRD instance (no relay in v1)", async () => {
    const result = await ingestFederatedPage(
      sql,
      {
        type: "OrderedCollectionPage",
        orderedItems: [
          {
            seq: 1,
            txid: "100",
            operation: "create",
            objectId: "peer-c:evt",
            observation: fedEvent({ id: "peer-c:evt", instanceId: "peer-c" }),
          },
        ],
      },
      PEER_A
    );
    expect(result.accepted).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/authenticated peer/);
    expect(await rowById("peer-c:evt")).toBeUndefined();
  });
});

describe("exact resupply collapse on canonicalId", () => {
  const canonicalId = "b2".repeat(32);

  it("TWO peers restating one upstream record yield ONE row with both peers in the chain", async () => {
    const first = await ingestFederatedObservation(
      sql,
      fedEvent({ id: "ndw:situation-2", canonicalId, instanceId: "peer-a" }) as never,
      PEER_A
    );
    expect(first.outcome).toBe("inserted");

    const second = await ingestFederatedObservation(
      sql,
      fedEvent({ id: "ndw:situation-2", canonicalId, instanceId: "peer-b" }) as never,
      PEER_B
    );
    expect(second.outcome).toBe("resupplied");

    const rows = await rowsByCanonical(canonicalId);
    expect(rows).toHaveLength(1);
    const chain = rows[0]!.origin.originChain!;
    expect(chain.map((h) => h.viaPeer)).toEqual(["peer-a", "peer-b"]);
    // NO new evidence, NO corroboration: same record, not an independent witness.
    expect(await evidenceCount(rows[0]!.id)).toEqual([{ kind: "report", actor: null }]);
    expect(rows[0]!.corroborations).toBeNull();
  });

  it("dedups the chain on a repeat resupply from the same peer", async () => {
    const again = await ingestFederatedObservation(
      sql,
      fedEvent({ id: "ndw:situation-2", canonicalId, instanceId: "peer-b" }) as never,
      PEER_B
    );
    expect(again.outcome).toBe("resupplied");
    const rows = await rowsByCanonical(canonicalId);
    expect(rows[0]!.origin.originChain!.map((h) => h.viaPeer)).toEqual(["peer-a", "peer-b"]);
  });

  it("keeps the newest version's content: a newer resupply from the OWNING peer updates content", async () => {
    const newer = new Date(Date.parse(VALID_FROM) + 60_000).toISOString();
    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "ndw:situation-2",
        canonicalId,
        instanceId: "peer-a",
        headline: "Obstruction on A2 — lane reopened",
        dataUpdatedAt: newer,
      }) as never,
      PEER_A
    );
    expect(outcome).toMatchObject({ outcome: "resupplied", contentUpdated: true });
    const rows = await rowsByCanonical(canonicalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.headline).toBe("Obstruction on A2 — lane reopened");
    expect(rows[0]!.data_updated_at.toISOString()).toBe(newer);
  });

  it("keeps the existing content when the resupply is OLDER", async () => {
    const older = new Date(Date.parse(VALID_FROM) - 60_000).toISOString();
    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "ndw:situation-2",
        canonicalId,
        instanceId: "peer-a",
        headline: "stale headline",
        dataUpdatedAt: older,
      }) as never,
      PEER_A
    );
    expect(outcome).toMatchObject({ outcome: "resupplied", contentUpdated: false });
    const rows = await rowsByCanonical(canonicalId);
    expect(rows[0]!.headline).toBe("Obstruction on A2 — lane reopened");
  });

  it("never rewrites content of a row another instance owns, even when newer", async () => {
    const newest = new Date(Date.parse(VALID_FROM) + 120_000).toISOString();
    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "ndw:situation-2",
        canonicalId,
        instanceId: "peer-b",
        headline: "peer-b's rewrite attempt",
        dataUpdatedAt: newest,
      }) as never,
      PEER_B
    );
    expect(outcome).toMatchObject({ outcome: "resupplied", contentUpdated: false });
    const rows = await rowsByCanonical(canonicalId);
    expect(rows[0]!.headline).toBe("Obstruction on A2 — lane reopened");
  });

  it("reports a canonicalId collision with a LOCAL row as a non-owned collision and touches NOTHING", async () => {
    const localCanonical = "d4".repeat(32);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, data_updated_at, fetched_at, is_stale, instance_id, canonical_id,
         headline, privacy_class)
      VALUES ('local:evt-1', 'ndw', 'datex2', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(5.3, 52.3), 4326),
         ${sql.json({ kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } } as never)},
         ${VALID_FROM}, ${VALID_FROM}, now(), false, 'local', ${localCanonical},
         'local headline', 'authoritative')`;

    const newer = new Date(Date.parse(VALID_FROM) + 60_000).toISOString();
    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "ndw:evt-1",
        canonicalId: localCanonical,
        instanceId: "peer-a",
        headline: "peer version",
        dataUpdatedAt: newer,
      }) as never,
      PEER_A
    );
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "non-owned-collision" });

    const row = await rowById("local:evt-1");
    expect(row!.headline).toBe("local headline");
    // No receipt hop appended to provenance the peer does not own.
    expect(row!.origin.originChain).toBeUndefined();
    const rows = await rowsByCanonical(localCanonical);
    expect(rows).toHaveLength(1);
  });

  it("collapses a same-source FEED resupply from a DIFFERENT peer (the brief's cross-peer case)", async () => {
    const feedCanonical = "d5".repeat(32);
    await ingestFederatedObservation(
      sql,
      fedEvent({ id: "peer-a:feed-x", instanceId: "peer-a", canonicalId: feedCanonical }) as never,
      PEER_A
    );
    // Peer B independently ingested the SAME upstream NDW record (feed
    // canonicalId is source-derived) → legitimate cross-peer resupply, joins
    // the chain, never rewrites peer A's content.
    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-b:feed-x",
        instanceId: "peer-b",
        canonicalId: feedCanonical,
        headline: "peer-b restatement",
      }) as never,
      PEER_B
    );
    expect(outcome).toMatchObject({ outcome: "resupplied", contentUpdated: false });
    const rows = await rowsByCanonical(feedCanonical);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin.originChain!.map((h) => h.viaPeer)).toEqual(["peer-a", "peer-b"]);
    // Peer B never rewrote peer A's content.
    expect(rows[0]!.headline).toBe("Obstruction on A2");
  });

  it("reports a cross-instance CROWD canonicalId collision as non-owned, chain unchanged", async () => {
    // A crowd canonicalId is instance-namespaced, so a DIFFERENT instance
    // producing the same one is a forgery — never annotates the owner's row.
    const crowdCanonical = "d6".repeat(32);
    const crowdOrigin = { kind: "crowd", attribution: { provider: "P", license: "ODbL-1.0" } };
    await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-a:crowd-1",
        instanceId: "peer-a",
        canonicalId: crowdCanonical,
        privacyClass: "crowd_pseudonym",
        origin: crowdOrigin,
      }) as never,
      PEER_A
    );

    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-b:crowd-collide",
        instanceId: "peer-b",
        canonicalId: crowdCanonical,
        privacyClass: "crowd_pseudonym",
        origin: crowdOrigin,
        headline: "forged crowd collision",
      }) as never,
      PEER_B
    );
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "non-owned-collision" });
    const row = await rowById("peer-a:crowd-1");
    expect(row!.origin.originChain!.map((h) => h.viaPeer)).toEqual(["peer-a"]);
  });
});

describe("content-hash byte-equivalence fallback", () => {
  it("collapses a byte-identical event that LOST its canonicalId (different value)", async () => {
    const base = fedEvent({ id: "ndw:situation-3", canonicalId: "e5".repeat(32) });
    const first = await ingestFederatedObservation(sql, base as never, PEER_A);
    expect(first.outcome).toBe("inserted");

    // Same normalized bytes, different canonical id.
    const relabeled = fedEvent({ id: "ndw:situation-3", canonicalId: "f6".repeat(32) });
    const second = await ingestFederatedObservation(sql, relabeled as never, PEER_A);
    expect(second.outcome).toBe("resupplied");

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE id = 'ndw:situation-3'`;
    expect(rows).toHaveLength(1);
    // The existing identity is kept — the fallback never re-keys the row.
    expect((await rowById("ndw:situation-3"))!.canonical_id).toBe("e5".repeat(32));
  });

  it("does NOT collapse a semantically-similar but byte-different event", async () => {
    const different = fedEvent({
      id: "ndw:situation-3b",
      canonicalId: "a7".repeat(32),
      headline: "Obstruction on A2 (updated wording)",
      source: "ndw-mirror",
    });
    const outcome = await ingestFederatedObservation(sql, different as never, PEER_A);
    expect(outcome.outcome).toBe("inserted");
    expect(await rowById("ndw:situation-3b")).toBeDefined();
    expect(await rowById("ndw:situation-3")).toBeDefined();
  });
});

describe("phenomenonFingerprint feeds the typed matcher — never auto-collapse", () => {
  it("two INDEPENDENT compatible events stay separate records and corroborate", async () => {
    // A local crowd report of the same phenomenon, EARLIER, different source.
    const localValidFrom = new Date(Date.parse(VALID_FROM) - 120_000).toISOString();
    const fp = phenomenonFingerprint({
      kind: "event",
      domain: "roads",
      type: "hazard",
      geometry: { type: "Point", coordinates: [6.201, 52.501] },
      validFrom: localValidFrom,
    } as ConditionEvent);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale,
         instance_id, canonical_id, privacy_class)
      VALUES ('crowd:local-1', 'crowd', 'crowd', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(6.201, 52.501), 4326),
         ${sql.json({ kind: "crowd", attribution: { provider: "local", license: "ODbL-1.0" }, reporter: { keyId: "local-reporter" } } as never)},
         ${localValidFrom}, ${fp}, ${localValidFrom}, now(), false,
         'local', ${"b8".repeat(32)}, 'crowd_pseudonym')`;
    await sql`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, occurred_at, details)
      VALUES ('crowd:local-1', 'report', 'local-reporter', ${localValidFrom}, '{}'::jsonb)`;

    // The federated event: ~20 m away, same type, 2 min later, different source.
    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-a:fed-1",
        canonicalId: "c9".repeat(32),
        geometry: { type: "Point", coordinates: [6.2012, 52.5011] },
        validFrom: VALID_FROM,
        dataUpdatedAt: VALID_FROM,
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");
    expect(outcome.outcome === "inserted" && outcome.corroborated).toEqual(["crowd:local-1"]);

    // TWO rows — corroboration links them, it never merges them into one row.
    const local = await rowById("crowd:local-1");
    const fed = await rowById("peer-a:fed-1");
    expect(local).toBeDefined();
    expect(fed).toBeDefined();
    // The EARLIER (local) row survives and carries the corroboration lineage.
    expect(local!.status).toBe("active");
    expect(local!.corroborations).toEqual(["peer-a:fed-1"]);
    const evidence = await evidenceCount("crowd:local-1");
    expect(evidence).toContainEqual({ kind: "confirm", actor: null });
    // Corroboration NEVER routes.
    expect(local!.routing_eligible).toBe(false);
  });

  it("a deliberate fingerprint COLLISION with incompatible geometry does NOT merge", async () => {
    // The incoming event's fingerprint, planted on a row 5 km away.
    const collidingFp = phenomenonFingerprint({
      kind: "event",
      domain: "roads",
      type: "hazard",
      geometry: { type: "Point", coordinates: [7.4, 53.4] },
      validFrom: VALID_FROM,
    } as ConditionEvent);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale,
         instance_id, canonical_id, privacy_class)
      VALUES ('crowd:far-1', 'crowd', 'crowd', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(7.445, 53.4), 4326),
         ${sql.json({ kind: "crowd", attribution: { provider: "local", license: "ODbL-1.0" }, reporter: { keyId: "far-reporter" } } as never)},
         ${VALID_FROM}, ${collidingFp}, ${VALID_FROM}, now(), false,
         'local', ${"d0".repeat(32)}, 'crowd_pseudonym')`;
    await sql`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, occurred_at, details)
      VALUES ('crowd:far-1', 'report', 'far-reporter', ${VALID_FROM}, '{}'::jsonb)`;

    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-a:fed-2",
        canonicalId: "e1".repeat(32),
        geometry: { type: "Point", coordinates: [7.4, 53.4] },
        validFrom: VALID_FROM,
        dataUpdatedAt: VALID_FROM,
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");
    expect(outcome.outcome === "inserted" && outcome.corroborated).toEqual([]);

    // Both remain separate ACTIVE records; no lineage was written.
    expect((await rowById("crowd:far-1"))!.status).toBe("active");
    expect((await rowById("peer-a:fed-2"))!.status).toBe("active");
    expect((await rowById("crowd:far-1"))!.corroborations).toBeNull();
  });
});

describe("replaces — supersession only", () => {
  it("an incoming event with replaces:[id] supersedes the peer's OWN earlier observation", async () => {
    const v1 = await ingestFederatedObservation(
      sql,
      fedEvent({ id: "peer-a:versioned-1", canonicalId: "f2".repeat(32) }) as never,
      PEER_A
    );
    expect(v1.outcome).toBe("inserted");

    const v2 = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-a:versioned-2",
        canonicalId: "a3".repeat(32),
        headline: "superseding version",
        replaces: ["peer-a:versioned-1"],
      }) as never,
      PEER_A
    );
    expect(v2.outcome).toBe("inserted");
    expect(v2.outcome === "inserted" && v2.superseded).toEqual(["peer-a:versioned-1"]);

    expect((await rowById("peer-a:versioned-1"))!.status).toBe("inactive");
    expect((await rowById("peer-a:versioned-2"))!.status).toBe("active");
    // Supersession is NOT corroboration and adds no evidence to the superseded row.
    expect(await evidenceCount("peer-a:versioned-1")).toEqual([{ kind: "report", actor: null }]);
  });

  it("never supersedes a row the peer's instance does not own", async () => {
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, data_updated_at, fetched_at, is_stale, instance_id, canonical_id, privacy_class)
      VALUES ('local:protected-1', 'ndw', 'datex2', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(5.9, 52.9), 4326),
         ${sql.json({ kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } } as never)},
         ${VALID_FROM}, ${VALID_FROM}, now(), false, 'local', ${"b4".repeat(32)}, 'authoritative')`;

    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({
        id: "peer-a:usurper",
        canonicalId: "c5".repeat(32),
        replaces: ["local:protected-1"],
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");
    expect(outcome.outcome === "inserted" && outcome.superseded).toEqual([]);
    expect((await rowById("local:protected-1"))!.status).toBe("active");
  });
});

describe("page ingest — skip-and-report, cursor, shared pull path", () => {
  it("rejects a structurally invalid page", async () => {
    await expect(ingestFederatedPage(sql, { foo: 1 }, PEER_A)).rejects.toThrow(FederatedPageError);
  });

  it("skips bad events, reports reasons, and advances maxCursor over everything processed", async () => {
    const result = await ingestFederatedPage(
      sql,
      {
        type: "OrderedCollectionPage",
        orderedItems: [
          {
            seq: 10,
            txid: "900",
            operation: "create",
            objectId: "peer-a:page-1",
            observation: fedEvent({ id: "peer-a:page-1", canonicalId: "0a".repeat(32) }),
          },
          { seq: 11, txid: "900", operation: "delete", objectId: "gone:1", tombstone: true },
          {
            seq: 3,
            txid: "901",
            operation: "create",
            objectId: "peer-x:bad",
            observation: fedEvent({ id: "peer-x:bad", instanceId: "peer-x" }),
          },
          { seq: 4, txid: "901", operation: "create", objectId: "no-obs" },
        ],
      },
      PEER_A
    );
    expect(result.accepted).toBe(1);
    expect(result.skipped.map((s) => s.objectId).sort()).toEqual([
      "gone:1",
      "no-obs",
      "peer-x:bad",
    ]);
    // (txid 901, seq 4) is the highest composite cursor processed.
    expect(result.maxCursor).toBe("901.4");
  });

  it("ingestPeerOutbox (pull) runs the same ingest path as the inbox", async () => {
    const page = {
      type: "OrderedCollectionPage",
      orderedItems: [
        {
          seq: 20,
          txid: "1000",
          operation: "create",
          objectId: "peer-b:pulled-1",
          observation: fedEvent({
            id: "peer-b:pulled-1",
            instanceId: "peer-b",
            canonicalId: "e7".repeat(32),
          }),
        },
      ],
    };
    const result = await ingestPeerOutbox(sql, { instanceId: "peer-b" }, page, {
      localInstanceId: "local",
      now: NOW,
    });
    expect(result.accepted).toBe(1);
    expect(result.maxCursor).toBe("1000.20");
    const row = await rowById("peer-b:pulled-1");
    expect(row!.instance_id).toBe("peer-b");
    // The receipt hop marks the via-peer exactly like the webhook inbox does.
    expect(row!.origin.originChain!.map((h) => h.viaPeer)).toEqual(["peer-b"]);
  });

  it("refuses an id collision with an unrelated local record", async () => {
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, data_updated_at, fetched_at, is_stale, instance_id, canonical_id, privacy_class)
      VALUES ('shared:id-1', 'other', 'geojson', 'roads', 'event', 'roadworks', 'active',
         ST_SetSRID(ST_MakePoint(4.5, 51.5), 4326),
         ${sql.json({ kind: "feed", attribution: { provider: "X", license: "CC0-1.0" } } as never)},
         ${VALID_FROM}, ${VALID_FROM}, now(), false, 'local', ${"f8".repeat(32)}, 'authoritative')`;

    const outcome = await ingestFederatedObservation(
      sql,
      fedEvent({ id: "shared:id-1", canonicalId: "a9".repeat(32), headline: "clobber" }) as never,
      PEER_A
    );
    expect(outcome).toMatchObject({
      outcome: "skipped",
      reason: "id-conflict-with-unrelated-record",
    });
    expect((await rowById("shared:id-1"))!.headline).toBeNull();
  });
});

describe("federated CROWD → LOCAL feed route-without-training", () => {
  /** Seed a genuinely-LOCAL official feed EVENT (origin.kind='feed', NO originChain). */
  async function seedLocalFeed(opts: {
    id: string;
    lon: number;
    lat: number;
    validFrom: string;
    type?: string;
    source?: string;
  }): Promise<void> {
    const type = opts.type ?? "hazard";
    const fp = phenomenonFingerprint({
      kind: "event",
      domain: "roads",
      type,
      geometry: { type: "Point", coordinates: [opts.lon, opts.lat] },
      validFrom: opts.validFrom,
    } as ConditionEvent);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale,
         instance_id, canonical_id, privacy_class)
      VALUES
        (${opts.id}, ${opts.source ?? "ndw"}, 'datex2', 'roads', 'event', ${type}, 'active',
         ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326),
         ${sql.json({ kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } } as never)},
         ${opts.validFrom}, ${fp}, ${opts.validFrom}, now(), false,
         'local', ${
           "fe" +
           opts.id
             .replace(/[^a-f0-9]/gi, "")
             .slice(0, 30)
             .padEnd(30, "0")
         },
         'authoritative')`;
  }

  /**
   * A federated CROWD wire event (origin.kind='crowd'; reporter stripped on
   * ingest). Its `source` defaults to a crowd source distinct from the official
   * feed's, but the matcher now keys independence on the REAL origin.kind, so a
   * federated crowd row and a local feed are independent EVEN when their `source`
   * strings coincide (see the same-source route test below) — no longer a
   * fail-closed missed route.
   */
  function fedCrowd(overrides: Record<string, unknown>): Record<string, unknown> {
    return fedEvent({
      source: "peer-a-crowd",
      privacyClass: "crowd_pseudonym",
      origin: { kind: "crowd", attribution: { provider: "Peer A", license: "ODbL-1.0" } },
      ...overrides,
    });
  }

  async function seedReporter(keyId: string): Promise<void> {
    await sql`
      INSERT INTO conditions.reporter
        (key_id, pub_jwk, reputation_alpha, reputation_beta,
         entitlement_expires_at, status, created_at, last_active_at)
      VALUES (${keyId}, '{}'::jsonb, 2, 2, '2027-01-01T00:00:00Z', 'active', ${NOW}, ${NOW})`;
  }

  async function reporterSnapshot(): Promise<string> {
    const rows = await sql<{ key_id: string; a: number; b: number; c: number }[]>`
      SELECT key_id, reputation_alpha AS a, reputation_beta AS b, corroborated_count AS c
      FROM conditions.reporter ORDER BY key_id`;
    return JSON.stringify(rows);
  }

  async function externalCount(obsId: string): Promise<number> {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.report_evidence
      WHERE observation_id = ${obsId}
        AND evidence_kind IN ('official_match', 'reviewer_accept', 'reviewer_reject')`;
    return rows[0]!.n;
  }

  async function readReporter(keyId: string): Promise<{ a: number; b: number; c: number }> {
    const rows = await sql<{ a: number; b: number; c: number }[]>`
      SELECT reputation_alpha AS a, reputation_beta AS b, corroborated_count AS c
      FROM conditions.reporter WHERE key_id = ${keyId}`;
    return rows[0]!;
  }

  /** Seed a genuinely-LOCAL crowd EVENT (origin.kind='crowd' WITH reporter keyId) + its ledger. */
  async function seedLocalCrowd(opts: {
    id: string;
    lon: number;
    lat: number;
    validFrom: string;
    keyId: string;
    source?: string;
  }): Promise<void> {
    const fp = phenomenonFingerprint({
      kind: "event",
      domain: "roads",
      type: "hazard",
      geometry: { type: "Point", coordinates: [opts.lon, opts.lat] },
      validFrom: opts.validFrom,
    } as ConditionEvent);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale,
         instance_id, canonical_id, privacy_class)
      VALUES
        (${opts.id}, ${opts.source ?? "local-crowd"}, 'native', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326),
         ${sql.json({ kind: "crowd", attribution: { provider: "local", license: "ODbL-1.0" }, reporter: { keyId: opts.keyId } } as never)},
         ${opts.validFrom}, ${fp}, ${opts.validFrom}, now(), false,
         'local', ${
           "1c" +
           opts.id
             .replace(/[^a-f0-9]/gi, "")
             .slice(0, 30)
             .padEnd(30, "0")
         },
         'crowd_pseudonym')`;
    await sql`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, occurred_at, details)
      VALUES (${opts.id}, 'report', ${opts.keyId}, ${opts.validFrom}, '{}'::jsonb)`;
  }

  it("routes a federated crowd row on a LOCAL feed after ingest and trains NOBODY", async () => {
    await seedReporter("witness-untouched");
    await seedLocalFeed({ id: "route:local-feed", lon: 20.5, lat: 40.5, validFrom: VALID_FROM });

    const before = await reporterSnapshot();
    const outcome = await ingestFederatedObservation(
      sql,
      fedCrowd({
        id: "peer-a:fedcrowd-route",
        canonicalId: "ab".repeat(32),
        geometry: { type: "Point", coordinates: [20.5001, 40.5] },
        validFrom: VALID_FROM,
        dataUpdatedAt: VALID_FROM,
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");

    const row = await rowById("peer-a:fedcrowd-route");
    // Landed as a genuinely-federated crowd row (reporter stripped, originChain stamped).
    expect(row!.origin.kind).toBe("crowd");
    expect(row!.origin.reporter).toBeUndefined();
    expect(row!.origin.originChain!.length).toBeGreaterThan(0);
    // Routed on OUR local feed.
    expect(row!.evidence_state).toBe("externally_resolved");
    expect(row!.routing_eligible).toBe(true);
    expect(await externalCount("peer-a:fedcrowd-route")).toBe(1);
    // The feed itself is authoritative and untouched.
    expect(await externalCount("route:local-feed")).toBe(0);
    // No reporter row's alpha/beta/corroborated_count changed — trained nobody.
    expect(await reporterSnapshot()).toBe(before);
  }, 30_000);

  it("THE #3 FIX end-to-end: routes a federated crowd row on a LOCAL feed whose SOURCE STRING COINCIDES, training nobody", async () => {
    // The federated crowd row and the local feed share the same `source` ("ndw").
    // Before A4 the keyId-inference matcher read the keyId-less federated crowd row
    // as feed-like and the same-source guard BLOCKED the route (the #3 missed
    // route). Now, keyed on origin.kind, the crowd/feed pair is independent → routes.
    await seedReporter("samesrc-witness-untouched");
    await seedLocalFeed({
      id: "route:local-feed-samesrc",
      lon: 25.5,
      lat: 45.5,
      validFrom: VALID_FROM,
    });

    const before = await reporterSnapshot();
    const outcome = await ingestFederatedObservation(
      sql,
      fedCrowd({
        id: "peer-a:fedcrowd-samesrc",
        canonicalId: "cd".repeat(32),
        source: "ndw",
        geometry: { type: "Point", coordinates: [25.5001, 45.5] },
        validFrom: VALID_FROM,
        dataUpdatedAt: VALID_FROM,
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");

    const row = await rowById("peer-a:fedcrowd-samesrc");
    expect(row!.origin.kind).toBe("crowd");
    expect(row!.origin.reporter).toBeUndefined();
    expect(row!.origin.originChain!.length).toBeGreaterThan(0);
    // Routed on OUR local feed despite the coincident source string.
    expect(row!.evidence_state).toBe("externally_resolved");
    expect(row!.routing_eligible).toBe(true);
    expect(await externalCount("peer-a:fedcrowd-samesrc")).toBe(1);
    expect(await externalCount("route:local-feed-samesrc")).toBe(0);
    // Trained nobody.
    expect(await reporterSnapshot()).toBe(before);
  }, 30_000);

  it("trains the genuine pre-cutoff LOCAL confirmer (merged into the federated survivor), and no other key", async () => {
    // The one brief-pre-accepted path where a federated route DOES train: a LOCAL
    // crowd report A (keyId K) that corroborates into the federated row and, being
    // EARLIER, makes the federated row the survivor carrying A's confirm. The
    // following federated route then finds K as a pre-cutoff confirmer and trains
    // it — exactly as on any external resolution. This is positive-direction only
    // and bounded (a second peer echo can't inherit K's confirm — autoCorroborate
    // excludes keyId-less survivors, and A is inactive after one merge). Pin it so
    // a future change can't silently WIDEN the trained set.
    const K = "merged-local-witness";
    const control = "merged-control-untouched";
    await seedReporter(K);
    await seedReporter(control);
    // Local crowd A is LATER than the federated row (so the federated row survives).
    const aValidFrom = VALID_FROM;
    const fValidFrom = new Date(Date.parse(VALID_FROM) - 60_000).toISOString();
    await seedLocalCrowd({
      id: "route:local-crowd-A",
      lon: 24.5,
      lat: 44.5,
      validFrom: aValidFrom,
      keyId: K,
    });
    await seedLocalFeed({
      id: "route:merged-feed",
      lon: 24.50005,
      lat: 44.5,
      validFrom: fValidFrom,
    });

    const outcome = await ingestFederatedObservation(
      sql,
      fedCrowd({
        id: "peer-a:fedcrowd-merged",
        canonicalId: "ae".repeat(32),
        geometry: { type: "Point", coordinates: [24.5001, 44.5] },
        validFrom: fValidFrom,
        dataUpdatedAt: fValidFrom,
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");

    // Local A merged INTO the federated row (F is the earlier survivor), which then
    // routed on the local feed.
    expect((await rowById("route:local-crowd-A"))!.status).toBe("inactive");
    const survivor = await rowById("peer-a:fedcrowd-merged");
    expect(survivor!.status).toBe("active");
    expect(survivor!.routing_eligible).toBe(true);
    expect(survivor!.evidence_state).toBe("externally_resolved");

    // The genuine pre-cutoff LOCAL confirmer K IS trained (+alpha, +corroborated_count).
    const trained = await readReporter(K);
    expect(trained.a).toBe(3);
    expect(trained.c).toBe(1);
    // The trained set is EXACTLY the genuine local witnesses — no other key moved.
    const untouched = await readReporter(control);
    expect(untouched.a).toBe(2);
    expect(untouched.b).toBe(2);
    expect(untouched.c).toBe(0);
  }, 30_000);

  it("does NOT route a federated crowd row against a FEDERATED (peer-relayed) feed", async () => {
    // A peer-relayed feed carries an originChain hop — weaker, peer-dependent signal.
    const fp = phenomenonFingerprint({
      kind: "event",
      domain: "roads",
      type: "hazard",
      geometry: { type: "Point", coordinates: [21.5, 41.5] },
      validFrom: VALID_FROM,
    } as ConditionEvent);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale,
         instance_id, canonical_id, privacy_class)
      VALUES ('route:fed-feed', 'peer-b', 'datex2', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(21.5, 41.5), 4326),
         ${sql.json({ kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" }, originChain: [{ instanceId: "peer-b", receivedAt: VALID_FROM }] } as never)},
         ${VALID_FROM}, ${fp}, ${VALID_FROM}, now(), false,
         'peer-b', ${"cc".repeat(32)}, 'authoritative')`;

    const outcome = await ingestFederatedObservation(
      sql,
      fedCrowd({
        id: "peer-a:fedcrowd-vs-fedfeed",
        canonicalId: "ad".repeat(32),
        geometry: { type: "Point", coordinates: [21.5001, 41.5] },
        validFrom: VALID_FROM,
        dataUpdatedAt: VALID_FROM,
      }) as never,
      PEER_A
    );
    expect(outcome.outcome).toBe("inserted");
    const row = await rowById("peer-a:fedcrowd-vs-fedfeed");
    expect(row!.routing_eligible).toBe(false);
    expect(row!.evidence_state).not.toBe("externally_resolved");
    expect(await externalCount("peer-a:fedcrowd-vs-fedfeed")).toBe(0);
  }, 30_000);

  it("spam shape: N federated crowd rows shadowing one local feed all route, attributable via the logged peer id, training nobody", async () => {
    await seedReporter("spam-witness");
    await seedLocalFeed({ id: "route:spam-feed", lon: 22.5, lat: 42.5, validFrom: VALID_FROM });

    const before = await reporterSnapshot();
    const logged: string[] = [];
    const infoSpy = vi.spyOn(console, "info").mockImplementation((...args) => {
      logged.push(args.map(String).join(" "));
    });
    const ids: string[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const id = `peer-a:spam-${i}`;
        ids.push(id);
        const outcome = await ingestFederatedObservation(
          sql,
          fedCrowd({
            id,
            canonicalId: (i.toString(16).padStart(2, "0") + "e").repeat(16).slice(0, 64),
            // Distinct content per row (a real spammer must vary content to create
            // separate records — byte-identical rows legitimately collapse).
            headline: `Obstruction on A2 sighting ${i}`,
            geometry: { type: "Point", coordinates: [22.5001, 42.5] },
            validFrom: VALID_FROM,
            dataUpdatedAt: VALID_FROM,
          }) as never,
          PEER_A
        );
        expect(outcome.outcome).toBe("inserted");
      }
    } finally {
      infoSpy.mockRestore();
    }

    // Every shadowing row routed on the same local feed (route-without-training).
    for (const id of ids) {
      const row = await rowById(id);
      expect(row!.routing_eligible).toBe(true);
      expect(row!.evidence_state).toBe("externally_resolved");
      expect(await externalCount(id)).toBe(1);
    }
    // Each route is attributable: the peer id + matched feed id are logged per route.
    const routeLogs = logged.filter((m) => m.includes("routed federated crowd"));
    expect(routeLogs.length).toBe(ids.length);
    expect(routeLogs.every((m) => m.includes("peer peer-a") && m.includes("route:spam-feed"))).toBe(
      true
    );
    // No reputation trained by any of the spam routes — the deterrent is the
    // per-peer kill-switch, not per-report throttling.
    expect(await reporterSnapshot()).toBe(before);
  }, 60_000);

  it("is idempotent: re-ingesting the same federated crowd row does not double-route", async () => {
    await seedLocalFeed({ id: "route:idem-feed", lon: 23.5, lat: 43.5, validFrom: VALID_FROM });
    const canonicalId = "af".repeat(32);
    const wire = fedCrowd({
      id: "peer-a:fedcrowd-idem",
      canonicalId,
      geometry: { type: "Point", coordinates: [23.5001, 43.5] },
      validFrom: VALID_FROM,
      dataUpdatedAt: VALID_FROM,
    });

    const first = await ingestFederatedObservation(sql, wire as never, PEER_A);
    expect(first.outcome).toBe("inserted");
    const second = await ingestFederatedObservation(sql, wire as never, PEER_A);
    // A re-ingest of the same canonicalId collapses as a resupply — no second route.
    expect(second.outcome).toBe("resupplied");

    expect((await rowById("peer-a:fedcrowd-idem"))!.routing_eligible).toBe(true);
    expect(await externalCount("peer-a:fedcrowd-idem")).toBe(1);
  }, 30_000);
});
