/**
 * Peer records and outbox pages for the inbox suites, and this instance's own
 * stored situations for the outbox suites. Test-only: no runtime module
 * imports this file.
 */
import { sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";

type Rec = Record<string, unknown>;

export const registry = productionRegistry();

/** A feed situation a peer sealed, as its outbox serves it. */
export function peerSituation(instanceId: string, local: string, revision = 1): Rec {
  const recordedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const sealed = sealRecord(
    registry,
    {
      id: `oc:situation:nl-ndw-events:${local}`,
      class: "situation",
      kind: "incident",
      type: "obstruction",
      temporality: "live",
      planned: false,
      certainty: "observed",
      severity: { label: "moderate", source: "derived" },
      validity: { status: "active", start: recordedAt },
      effects: [],
      details: { kind: "incident", v: 1 },
      location: {
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      provenance: {
        origin: "feed",
        sourceId: "nl-ndw-events",
        sourceFormat: "datex2",
        accessMode: "bulk",
        recordId: local,
        attribution: { provider: "NDW", license: "CC0-1.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: recordedAt },
    },
    { instanceId, revision, recordedAt },
  );
  if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
  return sealed.value as Rec;
}

/** An outbox page of record changes. */
export function pageOf(entries: { seq: number; txid: string; record: Rec }[]): Rec {
  return {
    type: "OrderedCollectionPage",
    partOf: "https://a.example.net/peer/outbox",
    highWaterMark: "0.0",
    orderedItems: entries.map(({ seq, txid, record }) => ({
      seq,
      txid,
      operation: "update",
      recordClass: record["class"],
      recordId: record["id"],
      canonicalId: record["canonicalId"],
      kind: record["kind"],
      domain: record["domain"],
      createdAt: record["recordedAt"],
      record,
    })),
  };
}

/** The instance the outbox suites run as. */
export const OWN_INSTANCE = "oc-test";

/** The record id of a test situation from the NDW feed. */
export const situationId = (local: string) => `oc:situation:nl-ndw-events:${local}`;

export interface OwnSituationOptions {
  lon?: number;
  lat?: number;
  license?: string;
  /** An incident by default (a priority entry); `roadworks` is not one. */
  kind?: "incident" | "roadworks";
  /** A carriageway closure effect, which makes any situation a priority entry. */
  closure?: boolean;
  headline?: string;
  revision?: number;
  recordedAt?: string;
}

/** A feed situation this instance sealed, as the write seam stores it. */
export function ownSituation(local: string, opts: OwnSituationOptions = {}): Rec {
  const recordedAt = opts.recordedAt ?? new Date().toISOString();
  const kind = opts.kind ?? "incident";
  const sealed = sealRecord(
    registry,
    {
      id: situationId(local),
      class: "situation",
      kind,
      type: kind === "incident" ? "obstruction" : "works",
      temporality: "live",
      planned: kind === "roadworks",
      certainty: "observed",
      severity: { label: "moderate", source: "derived" },
      headline: [{ lang: "en", text: opts.headline ?? local }],
      validity: { status: "active", start: "2026-07-13T09:00:00Z" },
      effects: opts.closure
        ? [
            {
              id: `${local}/closure`,
              kind: "closure",
              v: 1,
              scope: "carriageway",
              applicability: { kind: "all" },
              compliance: "mandatory",
              normalization: "complete",
            },
          ]
        : [],
      details: { kind, v: 1 },
      location: {
        geometry: { type: "Point", coordinates: [opts.lon ?? 5.1, opts.lat ?? 52.1] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      provenance: {
        origin: "feed",
        sourceId: "nl-ndw-events",
        sourceFormat: "datex2",
        accessMode: "bulk",
        recordId: local,
        attribution: { provider: "NDW", license: opts.license ?? "CC0-1.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: "2026-07-13T10:00:00.000Z" },
    },
    { instanceId: OWN_INSTANCE, revision: opts.revision ?? 1, recordedAt },
  );
  if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
  return sealed.value as Rec;
}

/**
 * Stores a sealed situation (insert, or a newer revision over the stored
 * one), so the outbox capture journals it as the write seam's store would.
 */
export async function storeSituation(sql: postgres.Sql, record: Rec): Promise<void> {
  const provenance = record["provenance"] as Rec;
  const location = record["location"] as Rec;
  const validity = record["validity"] as Rec;
  const severity = record["severity"] as Rec;
  await sql`
    INSERT INTO conditions.situation
      (id, record, canonical_id, kind, type, domain, temporality, source_id, source_record_id,
       origin, access_mode, privacy_class, instance_id, revision, recorded_at, content_hash,
       fetched_at, geom, severity, certainty, planned, validity_status, valid_from)
    VALUES (
      ${record["id"] as string}, ${sql.json(record as never)},
      ${record["canonicalId"] as string}, ${record["kind"] as string},
      ${record["type"] as string}, ${record["domain"] as string},
      ${record["temporality"] as string}, ${provenance["sourceId"] as string},
      ${provenance["recordId"] as string}, ${provenance["origin"] as string},
      ${provenance["accessMode"] as string}, ${(provenance["privacy"] as Rec)["class"] as string},
      ${provenance["instanceId"] as string}, ${record["revision"] as number},
      ${record["recordedAt"] as string}, ${record["contentHash"] as string},
      ${(record["freshness"] as Rec)["fetchedAt"] as string},
      ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(location["geometry"])}), 4326),
      ${severity["label"] as string}, ${record["certainty"] as string},
      ${record["planned"] as boolean}, ${validity["status"] as string},
      ${validity["start"] as string})
    ON CONFLICT (id) DO UPDATE SET
      record = EXCLUDED.record, revision = EXCLUDED.revision,
      recorded_at = EXCLUDED.recorded_at, content_hash = EXCLUDED.content_hash,
      geom = EXCLUDED.geom, tombstone_reason = NULL, tombstoned_at = NULL`;
}

/** Tombstones a stored situation at its next revision, as the write seam does. */
export async function tombstoneSituation(
  sql: postgres.Sql,
  id: string,
  reason: string,
  at = new Date().toISOString(),
): Promise<void> {
  await sql`
    UPDATE conditions.situation
    SET record = record || jsonb_build_object(
          'tombstone', jsonb_build_object('reason', ${reason}::text, 'at', ${at}::text),
          'revision', revision + 1, 'recordedAt', ${at}::text),
        revision = revision + 1, recorded_at = ${at}::timestamptz,
        tombstone_reason = ${reason}, tombstoned_at = ${at}::timestamptz
    WHERE id = ${id}`;
}

/**
 * A pull subscription wanting every class: the capture only journals for a
 * subscriber, so a suite that reads the journal registers one first.
 */
export async function subscribeAll(sql: postgres.Sql, id: string): Promise<void> {
  await sql`
    INSERT INTO conditions.federation_subscription
      (id, peer_id, delivery_mode, created_at, updated_at)
    VALUES (${id}, ${`peer-${id}`}, 'pull', now(), now())
    ON CONFLICT (id) DO NOTHING`;
}

/** Backdates a record's journal entries to `msAgo` before `now`. */
export async function setOutboxAge(
  sql: postgres.Sql,
  recordId: string,
  msAgo: number,
  now: string,
): Promise<void> {
  const ts = new Date(Date.parse(now) - msAgo).toISOString();
  await sql`
    UPDATE conditions.federation_outbox
    SET created_at = ${ts}::timestamptz
    WHERE record_id = ${recordId}`;
}
