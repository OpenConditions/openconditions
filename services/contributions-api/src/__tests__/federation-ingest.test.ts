import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
