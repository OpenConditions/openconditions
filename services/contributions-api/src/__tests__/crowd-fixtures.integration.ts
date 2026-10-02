/**
 * Shared fixtures for the crowd suites: a disposable database, situation
 * claims, landing a signed report straight through the landing seam, and
 * seeding the feed and peer situations crowd reports are matched against.
 * Test-only: no runtime module imports this file.
 */
import {
  generateReporterKey,
  type ReporterKey,
  type SignedReport,
  type SituationClaim,
  signReport,
} from "@openconditions/contrib-core";
import { runMigrations } from "@openconditions/core/server";
import { type Attribution, type EvidenceState, sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { writeRecord } from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { recomputeEvidence } from "../evidence/recompute.js";
import { type LandingResult, landReport } from "../landing/land.js";

type Rec = Record<string, unknown>;

export const registry = productionRegistry();
export const INSTANCE = "maps.example.org";
export const PEER = "peer.example.net";
export const CROWD_ATTRIBUTION: Attribution = {
  provider: `OpenConditions contributors at ${INSTANCE}`,
  license: "ODbL-1.0",
};

/** A disposable PostGIS database with every migration applied. */
export async function createTestDatabase(): Promise<{
  sql: postgres.Sql;
  url: string;
  close(): Promise<void>;
}> {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  await runMigrations(url);
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return {
    sql,
    url,
    async close() {
      try {
        await sql.end();
      } finally {
        await container.stop();
      }
    },
  };
}

/** A crowd report of an obstruction (debris on the road) at a point. */
export function situationClaim(over: Partial<SituationClaim> = {}): SituationClaim {
  return {
    claimClass: "situation",
    kind: "incident",
    type: "obstruction",
    geometry: { type: "Point", coordinates: [8.4, 49] },
    fuzziness: "exact",
    reportedAt: "2026-07-12T07:59:00.000Z",
    nonce: "nonce-000000000001",
    ...over,
  } as SituationClaim;
}

export function reportAs(key: ReporterKey, claim: SituationClaim): Promise<SignedReport> {
  return signReport(registry, claim, key);
}

/** An active reporter row for a key, as enrollment leaves it. */
export async function enrollDirect(
  sql: postgres.Sql,
  key: ReporterKey,
  now: string,
  over: { alpha?: number; beta?: number } = {},
): Promise<void> {
  await sql`
    INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha, reputation_beta,
      entitlement_expires_at, status, created_at, last_active_at)
    VALUES (${key.keyId}, ${sql.json(key.publicJwk as never)}, ${over.alpha ?? 1},
      ${over.beta ?? 1}, ${now}::timestamptz + interval '30 days', 'active', ${now}, ${now})
    ON CONFLICT (key_id) DO NOTHING`;
}

/** Lands a signed report through the landing seam, as the route does after its checks. */
export async function landAs(
  sql: postgres.Sql,
  key: ReporterKey,
  claim: SituationClaim,
  now: string,
): Promise<LandingResult> {
  const report = await reportAs(key, claim);
  return landReport(sql, registry, report, {
    instanceId: INSTANCE,
    now,
    attribution: CROWD_ATTRIBUTION,
  });
}

/** A feed situation draft: an obstruction published by a local feed. */
export function feedSituationDraft(local: string, over: Rec = {}): Rec {
  return {
    id: `oc:situation:de-autobahn:${local}`,
    class: "situation",
    kind: "incident",
    type: "obstruction",
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "moderate", source: "derived" },
    validity: { status: "active", start: "2026-07-12T07:00:00Z" },
    effects: [],
    details: { kind: "incident", v: 1 },
    location: {
      geometry: { type: "Point", coordinates: [8.4, 49] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
    provenance: {
      origin: "feed",
      sourceId: "de-autobahn",
      sourceFormat: "autobahn",
      accessMode: "bulk",
      recordId: local,
      attribution: { provider: "Die Autobahn GmbH", license: "DL-DE-BY-2.0" },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: "2026-07-12T07:00:00.000Z" },
    ...over,
  };
}

/** Stores a local feed situation. */
export async function seedFeedSituation(
  sql: postgres.Sql,
  local: string,
  over: Rec = {},
  now = "2026-07-12T07:00:00.000Z",
): Promise<string> {
  const draft = feedSituationDraft(local, over);
  const written = await writeRecord(sql, { draft }, { registry, instanceId: INSTANCE, now });
  if (written.status === "rejected") throw new Error(JSON.stringify(written.issues));
  return draft["id"] as string;
}

/**
 * A record a peer sealed and federated here: its provenance names the peer,
 * carries no reporter, and its origin chain records the receipt.
 */
export function peerRecord(
  draft: Rec,
  revision = 1,
  recordedAt = "2026-07-12T07:00:00Z",
  instanceId = PEER,
): Rec {
  const sealed = sealRecord(registry, draft, { instanceId, revision, recordedAt });
  if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
  const record = sealed.value as Rec;
  const { reporter: _reporter, ...provenance } = record["provenance"] as Rec;
  return {
    ...record,
    provenance: {
      ...provenance,
      originChain: [{ instanceId, viaPeer: instanceId, receivedAt: recordedAt }],
    },
  };
}

/** A peer's crowd report of an obstruction, as it arrives here. */
export function peerCrowdReport(local: string, over: Rec = {}): Rec {
  return peerRecord({
    ...feedSituationDraft(local, {
      id: `oc:situation:${PEER}:${local}`,
      certainty: "observed",
      severity: { label: "unknown" },
      validity: { status: "active", start: "2026-07-12T07:59:00.000Z" },
      location: {
        geometry: { type: "Point", coordinates: [8.4, 49] },
        extent: "point",
        geometryOrigin: "crowd_device",
        fuzziness: "exact",
      },
      provenance: {
        origin: "crowd",
        sourceId: "crowd",
        sourceFormat: "crowd",
        accessMode: "bulk",
        recordId: local,
        attribution: { provider: `OpenConditions contributors at ${PEER}`, license: "ODbL-1.0" },
        privacy: { class: "crowd_pseudonym" },
      },
      freshness: { fetchedAt: "2026-07-12T08:00:00.000Z", expiresAt: "2026-07-12T12:00:00.000Z" },
    }),
    ...over,
  });
}

/** The evidence a situation row carries. */
export async function evidenceOf(
  sql: postgres.Sql,
  id: string,
): Promise<{
  evidence_state: EvidenceState | null;
  routing_eligible: boolean;
  corroborations: number;
  flagged_at: Date | null;
  tombstone_reason: string | null;
  expires_at: Date | null;
}> {
  const [row] = await sql<
    {
      evidence_state: EvidenceState | null;
      routing_eligible: boolean;
      corroborations: number;
      flagged_at: Date | null;
      tombstone_reason: string | null;
      expires_at: Date | null;
    }[]
  >`SELECT evidence_state, routing_eligible, corroborations, flagged_at, tombstone_reason,
           expires_at
      FROM conditions.situation WHERE id = ${id}`;
  if (row === undefined) throw new Error(`no situation ${id}`);
  return row;
}

/** A fresh reporter key, enrolled at the cohort prior Beta(2, 2). */
export async function enrolledKey(sql: postgres.Sql, now: string): Promise<ReporterKey> {
  const key = await generateReporterKey();
  await enrollDirect(sql, key, now, { alpha: 2, beta: 2 });
  return key;
}

/**
 * Stores a peer's crowd report at a point as the federation inbox lands it:
 * the record, a keyless `report` evidence row from the peer, and its evidence.
 */
export async function seedPeerCrowdReport(
  sql: postgres.Sql,
  local: string,
  coordinates: [number, number] = [8.4, 49],
  now = "2026-07-12T08:00:00.000Z",
): Promise<string> {
  const record = peerCrowdReport(local, {
    location: {
      geometry: { type: "Point", coordinates },
      extent: "point",
      geometryOrigin: "crowd_device",
      fuzziness: "exact",
    },
  });
  const written = await writeRecord(
    sql,
    { stored: record },
    { registry, instanceId: INSTANCE, now },
  );
  if (written.status === "rejected") throw new Error(JSON.stringify(written.issues));
  const id = record["id"] as string;
  const reportedAt = (record["validity"] as { start: string }).start;
  await sql`
    INSERT INTO conditions.report_evidence
      (record_class, record_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
    VALUES ('situation', ${id}, 'report', NULL, ${PEER}, ${now},
            ${sql.json({ via: "federation", peer: PEER, reportedAt })})`;
  await recomputeEvidence(sql, registry, id, now);
  return id;
}

export type { LandingResult };
