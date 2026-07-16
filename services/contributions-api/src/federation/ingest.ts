/**
 * The federation INBOX ingest — the trust boundary where signature-verified
 * events from PINNED peers enter `conditions.observations`. Callers (the
 * federation service's POST /peer/inbox webhook target AND the consumer-side
 * pull over a peer's /peer/outbox — {@link ingestPeerOutbox}) share this ONE
 * ingest path.
 *
 * Binding rules, in order, per event:
 *  1. EXACT canonicalId match → a RESUPPLY of the same upstream record:
 *     collapse onto the existing row (append the sending peer to its
 *     `origin.originChain`, deduped) and keep the newest `dataUpdatedAt`
 *     version's content — but ONLY when the existing row is the sending
 *     instance's OWN record. A collision against a local row or another
 *     instance's row (a peer can craft a colliding canonicalId) writes
 *     NOTHING and is reported as a non-owned collision — neither content nor
 *     provenance we did not originate is touched. NO new evidence, NO
 *     corroboration: a restated record is not an independent witness.
 *  2. CONTENT-HASH byte-equivalence → the NARROW fallback for a resupply that
 *     lost its canonicalId: collapse exactly as above. Never semantic dedup —
 *     the hash is the ingest pipeline's own `content_hash` (toRow), byte
 *     identity or nothing.
 *  3. Otherwise the event lands as a NEW row (origin fields preserved by the
 *     federation writer context) with its own `report` evidence row, and its
 *     phenomenonFingerprint feeds the TYPED matcher via the same
 *     landing-time auto-corroboration the crowd path uses: a fingerprint
 *     match only opens a candidate set, the matcher decides compatibility +
 *     source independence, and a match CORROBORATES (under the established
 *     evidence rules — never routes, never trains reputation) but NEVER
 *     auto-collapses.
 *  4. `replaces` is version/supersession ONLY: the referenced observations are
 *     marked inactive iff they belong to the incoming event's own origin
 *     instance — an instance may only supersede ITS OWN records, and
 *     supersession is never provenance and never corroboration.
 */
import type postgres from "postgres";
import type { Observation, OriginHop, Provenance } from "@openconditions/core";
import { normalizeObservation } from "@openconditions/normalize";
import { toRow } from "@openconditions/ingest/pipeline/write-postgis";
import { autoCorroborateOnLanding } from "../evidence/autoCorroborate.js";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import {
  hasActiveTombstone,
  isTombstoneReason,
  recordTombstoneFact,
  scrubJournalResidue,
  softTombstone,
  type TombstoneReason,
} from "./tombstone.js";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Jsonb = any;

export interface FederatedIngestContext {
  /** This instance's stable id (rows it originated are never peer-rewritable). */
  localInstanceId: string;
  /** The RFC-9421-authenticated sending peer's instance id. */
  peerInstanceId: string;
  /** Receipt instant (ISO 8601) — stamped on origin-chain hops and evidence. */
  now: string;
}

/** Injection seam for the federated cross-validation hook (defaults to the real fn). */
export interface FederatedIngestDeps {
  crossValidateAgainstFeeds?: typeof crossValidateAgainstFeeds;
}

export type FederatedEventOutcome =
  | {
      outcome: "inserted";
      objectId: string;
      observationId: string;
      /** Observation ids the typed matcher corroborated with (never merged). */
      corroborated: string[];
      /** Peer-owned observation ids superseded via `replaces`. */
      superseded: string[];
    }
  | {
      outcome: "resupplied";
      objectId: string;
      observationId: string;
      /** True when the resupply carried a newer version and content was updated. */
      contentUpdated: boolean;
    }
  | {
      outcome: "tombstoned";
      objectId: string;
      /** The local observation the incoming tombstone retracted. */
      observationId: string;
      /** The reason applied to the local copy (from the incoming tombstone). */
      tombstoneReason: TombstoneReason;
    }
  | { outcome: "skipped"; objectId: string; reason: string };

export interface FederatedPageResult {
  /** Events landed as new observations. */
  accepted: number;
  /** Events collapsed onto an existing row (exact canonicalId or byte-equivalent). */
  resupplied: number;
  /** Incoming tombstones applied to an owned local copy (soft-archived). */
  tombstoned: number;
  skipped: { objectId: string; reason: string }[];
  /**
   * The maximum composite `(txid, seq)` cursor processed (wire-encoded
   * `"<txid>.<seq>"`), skipped events included — the peer advances its
   * push-ack over everything this call has seen. Null when no entry carried a
   * usable cursor.
   */
  maxCursor: string | null;
  outcomes: FederatedEventOutcome[];
}

/** A structurally invalid page (not per-event trouble) — routes answer 400. */
export class FederatedPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederatedPageError";
  }
}

interface WireEntry {
  seq?: unknown;
  txid?: unknown;
  operation?: unknown;
  objectId?: unknown;
  canonicalId?: unknown;
  observation?: unknown;
  tombstone?: unknown;
  reason?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Dedup key for an origin-chain hop: one hop per (origin instance, via-peer). */
function hopKey(hop: OriginHop): string {
  return `${hop.instanceId}\u0000${hop.viaPeer ?? ""}`;
}

function isOriginHop(value: unknown): value is OriginHop {
  return (
    isRecord(value) &&
    typeof value["instanceId"] === "string" &&
    typeof value["receivedAt"] === "string" &&
    (value["viaPeer"] === undefined || typeof value["viaPeer"] === "string")
  );
}

/**
 * Merges origin-chain hops in order (existing → incoming → the new receipt
 * hop), dropping malformed incoming hops and deduping by (instanceId, viaPeer)
 * with the FIRST occurrence winning, so a resupply never grows the chain.
 */
function mergeOriginChain(
  existing: OriginHop[] | undefined,
  incoming: unknown,
  receipt: OriginHop
): OriginHop[] {
  const merged: OriginHop[] = [];
  const seen = new Set<string>();
  const push = (hop: OriginHop): void => {
    const key = hopKey(hop);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(hop);
  };
  for (const hop of existing ?? []) push(hop);
  if (Array.isArray(incoming)) {
    for (const hop of incoming) {
      if (isOriginHop(hop)) push(hop);
    }
  }
  push(receipt);
  return merged;
}

/**
 * Ingest one page of federated events (the OrderedCollectionPage shape the
 * outbox serves and the webhook pushes). Per-event failures SKIP that event
 * with a named reason and never abort the page; only a structurally invalid
 * page throws ({@link FederatedPageError}).
 */
export async function ingestFederatedPage(
  sql: Sql,
  page: unknown,
  ctx: FederatedIngestContext
): Promise<FederatedPageResult> {
  if (!isRecord(page) || !Array.isArray(page["orderedItems"])) {
    throw new FederatedPageError(
      "federated page must be an object with an orderedItems array (OrderedCollectionPage)"
    );
  }

  const outcomes: FederatedEventOutcome[] = [];
  let maxCursor: { txid: bigint; seq: number } | null = null;

  for (const item of page["orderedItems"]) {
    const entry: WireEntry = isRecord(item) ? item : {};

    // Advance the processed frontier over EVERY entry that carries a usable
    // composite cursor — a skipped event is still processed (skip-and-report),
    // so the peer's push-ack never wedges on one bad event.
    if (typeof entry.txid === "string" && /^\d+$/.test(entry.txid)) {
      const seq = typeof entry.seq === "number" && Number.isSafeInteger(entry.seq) ? entry.seq : 0;
      const txid = BigInt(entry.txid);
      if (
        maxCursor === null ||
        txid > maxCursor.txid ||
        (txid === maxCursor.txid && seq > maxCursor.seq)
      ) {
        maxCursor = { txid, seq };
      }
    }

    const observation = entry.observation;
    const objectId =
      typeof entry.objectId === "string"
        ? entry.objectId
        : isRecord(observation) && typeof observation["id"] === "string"
          ? (observation["id"] as string)
          : "unknown";

    if (!isRecord(item)) {
      outcomes.push({ outcome: "skipped", objectId, reason: "malformed-entry" });
      continue;
    }
    if (entry.operation === "delete" || entry.tombstone === true) {
      // A tombstone retracts the SENDING peer's record. Apply it to a local copy
      // the peer OWNS under the same source-aware ownership rule a resupply uses;
      // a tombstone against a row the peer does not own is a no-op, reported.
      const canonicalId = typeof entry.canonicalId === "string" ? entry.canonicalId : undefined;
      const reason = isTombstoneReason(entry.reason) ? entry.reason : "deleted_by_source";
      try {
        outcomes.push(await applyFederatedTombstone(sql, { objectId, canonicalId, reason }, ctx));
      } catch (err) {
        outcomes.push({
          outcome: "skipped",
          objectId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if ((entry.operation !== "create" && entry.operation !== "update") || !isRecord(observation)) {
      outcomes.push({ outcome: "skipped", objectId, reason: "malformed-entry" });
      continue;
    }

    try {
      outcomes.push(
        await ingestFederatedObservation(sql, observation as unknown as Observation, ctx, objectId)
      );
    } catch (err) {
      outcomes.push({
        outcome: "skipped",
        objectId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const skipped = outcomes.flatMap((o) =>
    o.outcome === "skipped" ? [{ objectId: o.objectId, reason: o.reason }] : []
  );
  return {
    accepted: outcomes.filter((o) => o.outcome === "inserted").length,
    resupplied: outcomes.filter((o) => o.outcome === "resupplied").length,
    tombstoned: outcomes.filter((o) => o.outcome === "tombstoned").length,
    skipped,
    maxCursor: maxCursor === null ? null : `${maxCursor.txid}.${maxCursor.seq}`,
    outcomes,
  };
}

/**
 * The consumer-side PULL ingest: runs the SAME federated ingest on a page
 * pulled from a peer's /peer/outbox, so pull and webhook share one trust
 * boundary. The polling loop that fetches pages (cursor persistence, signed
 * GET, backoff) is wiring left to its caller; this is the ingest deliverable.
 */
export async function ingestPeerOutbox(
  sql: Sql,
  peer: { instanceId: string },
  page: unknown,
  opts: { localInstanceId: string; now?: string }
): Promise<FederatedPageResult> {
  return ingestFederatedPage(sql, page, {
    localInstanceId: opts.localInstanceId,
    peerInstanceId: peer.instanceId,
    now: opts.now ?? new Date().toISOString(),
  });
}

interface ExistingRow {
  id: string;
  source: string;
  instance_id: string | null;
  origin: Provenance & { originChain?: OriginHop[] };
  data_updated_at: Date;
}

type LandedWithin =
  | { kind: "inserted"; superseded: string[] }
  | { kind: "resupplied"; observationId: string; contentUpdated: boolean }
  | { kind: "id-conflict" }
  | { kind: "non-owned-collision" }
  | { kind: "tombstoned" };

/**
 * Ingest ONE federated observation: normalize through the central federation
 * writer context (preserve origin fields, strip local-only fields), then run
 * the dedup ladder inside one transaction, then — only for a genuinely NEW
 * event row — feed the typed phenomenon matcher.
 */
export async function ingestFederatedObservation(
  sql: Sql,
  wire: Observation,
  ctx: FederatedIngestContext,
  objectId?: string,
  deps: FederatedIngestDeps = {}
): Promise<FederatedEventOutcome> {
  const crossValidate = deps.crossValidateAgainstFeeds ?? crossValidateAgainstFeeds;
  const normalized = normalizeObservation(wire, {
    kind: "federation",
    instanceId: ctx.localInstanceId,
    peerInstanceId: ctx.peerInstanceId,
  });
  const oid = objectId ?? normalized.id;
  const row = toRow(normalized);

  const landed: LandedWithin = await sql.begin(async (tx): Promise<LandedWithin> => {
    // Serialize concurrent deliveries of the SAME upstream record (two peers
    // pushing one canonicalId at once): without this both would pass the
    // row lookup below and land duplicate rows. Released with the transaction.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${normalized.canonicalId!}))`;

    // A terminal tombstone WINS: neither a re-discovered create nor a resupply of
    // a tombstoned canonicalId may resurrect it while the deletion fact is live.
    // Checked BEFORE the row lookup so the create-after-tombstone race (the
    // tombstone recorded its fact before the object arrived) is closed too.
    if (await hasActiveTombstone(tx, normalized.canonicalId, ctx.now)) {
      return { kind: "tombstoned" };
    }

    const byCanonical = await tx<ExistingRow[]>`
      SELECT id, source, instance_id, origin, data_updated_at
      FROM conditions.observations
      WHERE canonical_id = ${normalized.canonicalId!}
      ORDER BY data_updated_at DESC
      LIMIT 1
      FOR UPDATE`;
    if (byCanonical[0] !== undefined) {
      return collapseResupply(tx, byCanonical[0], normalized, row, ctx);
    }

    // The NARROW byte-equivalence fallback: identical normalized content whose
    // canonicalId was lost. Byte identity of the pipeline's own content hash —
    // never a semantic match.
    const byHash = await tx<ExistingRow[]>`
      SELECT id, source, instance_id, origin, data_updated_at
      FROM conditions.observations
      WHERE content_hash = ${row.content_hash}
      ORDER BY data_updated_at DESC
      LIMIT 1
      FOR UPDATE`;
    if (byHash[0] !== undefined) {
      return collapseResupply(tx, byHash[0], normalized, row, ctx);
    }

    const inserted = await insertFederatedRow(tx, normalized, row, ctx);
    if (!inserted) {
      return { kind: "id-conflict" };
    }

    await tx`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
      VALUES (${normalized.id}, 'report', ${null}, ${normalized.source}, ${ctx.now},
              ${tx.json({ via: "federation", peer: ctx.peerInstanceId } as Jsonb)})`;

    const superseded = await applySupersession(tx, normalized);
    return { kind: "inserted", superseded };
  });

  if (landed.kind === "id-conflict") {
    // Same id, different canonicalId AND different content: an unrelated local
    // record already owns this id. Overwriting it would let a peer clobber
    // rows it never produced — refuse.
    return { outcome: "skipped", objectId: oid, reason: "id-conflict-with-unrelated-record" };
  }
  if (landed.kind === "tombstoned") {
    // The canonicalId carries an active terminal tombstone — a re-discovery must
    // not resurrect the retracted record. Skip and report.
    return { outcome: "skipped", objectId: oid, reason: "tombstoned" };
  }
  if (landed.kind === "non-owned-collision") {
    // The incoming canonicalId (or content hash) collides with a row the
    // SENDING peer's origin instance does not own (a local row, or another
    // instance's). A peer can craft a colliding canonicalId, so appending its
    // receipt hop to that row's provenance would be attacker-controlled noise —
    // append NOTHING and report.
    return { outcome: "skipped", objectId: oid, reason: "non-owned-collision" };
  }
  if (landed.kind === "resupplied") {
    // A content-updating resupply (a peer's newer version) may now geometry/type-
    // match a LOCAL feed the inserted-path hook did not see when the row first
    // landed. Re-run the SAME federated cross-validation on the surviving row so it
    // routes immediately, not only on the next #1 federated-sweep tick.
    // crossValidateAgainstFeeds is idempotent + fully guarded (crowd target,
    // keyId-less + originChain, local-feed-only, trains nobody in the federated-only
    // case), so it no-ops on any resupplied id that is not a routable federated
    // crowd row or is already routed. Gate on contentUpdated so a no-content
    // resupply does not waste the call, AND on the same crowd-event kind/origin as
    // the inserted-path hook so a content-updating FEED/measurement resupply (the
    // bulk of federation traffic) does not pay a point-SELECT that just no-ops at
    // crossValidateAgainstFeeds's kind/origin guards. The surviving row's kind/origin
    // equal normalized's after a content update, so this gate is exact. Best-effort:
    // a throw never aborts the resupply.
    if (
      landed.contentUpdated &&
      normalized.kind === "event" &&
      normalized.origin.kind === "crowd"
    ) {
      try {
        const matchedFeedId = await crossValidate(sql, landed.observationId, ctx.now, {
          allowFederatedTarget: true,
        });
        if (matchedFeedId !== null) {
          console.info(
            `[federation] routed resupplied federated crowd ${landed.observationId} ` +
              `on local feed ${matchedFeedId} (peer ${ctx.peerInstanceId})`
          );
        }
      } catch (err) {
        console.warn(
          `[federation] federated cross-validate failed for resupplied ${landed.observationId} ` +
            `(peer ${ctx.peerInstanceId}): ${String(err)}`
        );
      }
    }
    return {
      outcome: "resupplied",
      objectId: oid,
      observationId: landed.observationId,
      contentUpdated: landed.contentUpdated,
    };
  }

  // Phenomenon evidence, OUTSIDE the landing transaction (same shape as the
  // crowd landing route): the fingerprint neighborhood opens candidates, the
  // typed matcher decides, a match corroborates under the evidence rules and
  // NEVER auto-collapses. Measurements never fingerprint.
  const corroborated =
    normalized.kind === "event" ? await autoCorroborateOnLanding(sql, normalized.id, ctx.now) : [];

  // Federated CROWD → LOCAL feed cross-validation (route-without-training). A
  // federated crowd row (origin.kind='crowd', reporter stripped → keyId-less,
  // origin.originChain present) is skipped by the strict landing/sweep guard. When
  // a LOCAL official feed this instance already ingested independently confirms the
  // same event, make the local copy routing-eligible via applyExternalResolution.
  // In the FEDERATED-ONLY case this trains NOBODY (a NULL-keyed originator, no
  // local confirmers, so its reputation blocks no-op). It is NOT unconditionally
  // training-free: if a genuine LOCAL crowd report (with a keyId) earlier merged
  // into this federated row as a pre-cutoff confirmer — autoCorroborate runs above
  // and isEarlier can make the federated row the survivor carrying that local
  // confirm — that LOCAL key IS trained, exactly as on any external resolution.
  // That is the pre-accepted "a local reporter who separately confirmed the row is
  // still trained" case (positive-direction only). routing_eligible stays purely
  // local; the trust anchor is OUR feed, never the peer's word. allowFederatedTarget
  // relaxes ONLY the keyId guard, and only for a genuinely-federated crowd target —
  // the local-feed-only candidate guard (crowd↔crowd never routes) and the
  // origin.kind='crowd' guard (a federated FEED is never a routable target) are
  // unchanged.
  //
  // Accountability asymmetry (FABLE FIX 3b): route-without-training removes the
  // per-key deterrents (rate-limit / reputation / block) a local reporter has. A
  // compromised pinned peer spamming keyId-less crowd rows to shadow local feeds is
  // handled by the peer-level kill-switch — the peer-blocklist rejects its inbound
  // ingest so it can no longer land rows at all — NOT by per-report throttling. Each
  // federated route is LOGGED with the sending peer id + the matched local feed id
  // so a spamming peer is observable in logs. A persisted per-peer routed-counter is
  // a future monitoring enhancement, not required here.
  //
  // Scope (both directions now covered): this inserted-path hook cross-validates a
  // federated crowd row against local feeds present AT federation-ingest time. The
  // two feed/content-arrives-later gaps are closed elsewhere:
  //   - feed-arrives-later: a LOCAL feed that lands AFTER a federated crowd row is
  //     picked up by the STARVATION-SAFE federated sweep (sweepFederatedCrossValidate
  //     in crossValidateSweep.ts). It scans exactly the keyId-less federated crowd
  //     rows the local T2 sweep skips, bounded by `expires_at > now` (which also
  //     excludes never-expiring rows) and ordered soonest-to-expire first, so it
  //     densifies without reopening the T2 sweep's oldest-first starvation.
  //   - content-arrives-later: a content-updating RESUPPLY (a peer's newer version
  //     that now matches a local feed) re-runs this same cross-validation on the
  //     surviving row in the resupply branch above (gated on contentUpdated), so it
  //     routes immediately rather than waiting on the next sweep tick.
  // Honest caveats preserved: the sweep is best-effort + bounded (a row may expire
  // un-attempted at extreme volume — the sensor/feed base still stands), and routing
  // still TRAINS NOBODY in the federated-only case regardless of which path routes.
  //
  // Life-extension caveat (FABLE FIX 3e): a later local recompute rebuilds
  // expires_at/confidence from the LOCAL ledger whose report occurred_at is the
  // federation RECEIPT time, so routing can extend the row's life vs its true origin
  // age. Pre-existing for corroborated federated rows; noted, not fixed here.
  //
  // Best-effort: a failure here must never abort a successful landing.
  if (normalized.kind === "event" && normalized.origin.kind === "crowd") {
    try {
      const matchedFeedId = await crossValidate(sql, normalized.id, ctx.now, {
        allowFederatedTarget: true,
      });
      if (matchedFeedId !== null) {
        console.info(
          `[federation] routed federated crowd ${normalized.id} on local feed ${matchedFeedId} ` +
            `(peer ${ctx.peerInstanceId})`
        );
      }
    } catch (err) {
      console.warn(
        `[federation] federated cross-validate failed for ${normalized.id} ` +
          `(peer ${ctx.peerInstanceId}): ${String(err)}`
      );
    }
  }

  return {
    outcome: "inserted",
    objectId: oid,
    observationId: normalized.id,
    corroborated,
    superseded: landed.superseded,
  };
}

interface TombstoneTarget {
  objectId: string;
  canonicalId: string | undefined;
  reason: TombstoneReason;
}

interface TombstoneRow {
  id: string;
  status: string;
  source: string;
  instance_id: string | null;
  canonical_id: string | null;
  origin: Provenance;
}

/**
 * Apply an incoming federation tombstone to a local copy the SENDING peer owns.
 *
 * Ownership is the SAME source-aware rule as {@link collapseResupply}: the peer
 * owns the row iff its own origin instance produced it (`instance_id` equals the
 * authenticated peer) OR it is a same-source FEED record this instance did not
 * originate (a `canonicalId` match already implies same source+recordId, since a
 * feed canonicalId is `hash(source, recordId)` — not instance-namespaced). A
 * tombstone against a LOCAL row, or another instance's row, is a NON-OWNED
 * collision (no-op, reported): a peer cannot erase a row it never produced.
 *
 * Note the by-id resolution + the feed-origin branch mean ANY pinned peer may
 * retract ANY non-locally-owned feed-origin row: a peer's claim to a source feed
 * is unverifiable here, so this is inherent federation trust in the pinned peer
 * set (unchanged from the resupply rule). LOCALLY-originated rows are absolutely
 * protected regardless of what a peer sends.
 *
 * When owned, the local copy is SOFT-tombstoned (archived + scrubbed, the
 * `report_evidence` ledger retained, the incoming reason recorded), which the
 * outbox trigger re-emits as a signed `delete` tombstone so the retraction
 * propagates onward. Idempotent: an already-archived copy is reported tombstoned
 * without a second scrub or a duplicate outbox entry.
 */
async function applyFederatedTombstone(
  sql: Sql,
  target: TombstoneTarget,
  ctx: FederatedIngestContext
): Promise<FederatedEventOutcome> {
  return sql.begin(async (tx): Promise<FederatedEventOutcome> => {
    const existing = await resolveTombstoneTarget(tx, target);
    if (existing === undefined) {
      // The object is not here YET. Record the terminal fact anyway so a
      // create/resupply that arrives AFTER this tombstone (the race) is refused;
      // it stays live for the ADR §7.2 retention window.
      await recordTombstoneFact(tx, target.canonicalId, target.reason, ctx.now);
      return {
        outcome: "skipped",
        objectId: target.objectId,
        reason: "tombstone-target-not-found",
      };
    }

    const sameOriginInstance = existing.instance_id === ctx.peerInstanceId;
    const existingLocallyOwned = existing.instance_id === ctx.localInstanceId;
    const sameSourceFeed = existing.origin.kind === "feed";
    const owns = sameOriginInstance || (!existingLocallyOwned && sameSourceFeed);
    if (!owns) {
      // A peer may not block a row it demonstrably does not own (a local row or
      // another instance's) — do NOT record the fact here.
      return { outcome: "skipped", objectId: target.objectId, reason: "non-owned-collision" };
    }

    if (existing.status !== "archived") {
      await softTombstone(tx, existing.id, target.reason, ctx.now);
    }
    // The deletion fact is terminal (resurrection guard); an erasure/takedown
    // also strips this row's historical journal PII.
    await recordTombstoneFact(
      tx,
      existing.canonical_id ?? target.canonicalId,
      target.reason,
      ctx.now
    );
    await scrubJournalResidue(tx, existing.id, target.reason);
    return {
      outcome: "tombstoned",
      objectId: target.objectId,
      observationId: existing.id,
      tombstoneReason: target.reason,
    };
  });
}

/**
 * Resolve and lock the local row a tombstone targets: by `canonicalId` first
 * (the source-derived key that unites independent ingests of the same upstream
 * record), then by the tombstone's own `id`. Returns undefined when neither
 * matches — the object is unknown here and the tombstone is skip-and-reported.
 */
async function resolveTombstoneTarget(
  tx: Tx,
  target: TombstoneTarget
): Promise<TombstoneRow | undefined> {
  if (target.canonicalId !== undefined) {
    const byCanonical = await tx<TombstoneRow[]>`
      SELECT id, status, source, instance_id, canonical_id, origin
      FROM conditions.observations
      WHERE canonical_id = ${target.canonicalId}
      ORDER BY data_updated_at DESC
      LIMIT 1
      FOR UPDATE`;
    if (byCanonical[0] !== undefined) return byCanonical[0];
  }
  const byId = await tx<TombstoneRow[]>`
    SELECT id, status, source, instance_id, canonical_id, origin
    FROM conditions.observations
    WHERE id = ${target.objectId}
    LIMIT 1
    FOR UPDATE`;
  return byId[0];
}

/**
 * Collapse a LEGITIMATE resupply of an already-known upstream record: append
 * the receipt hop to the row's origin chain (deduped) and, when the SAME origin
 * instance sends a NEWER version, update the content to it. Local lineage
 * columns (origin identity, instance_id, canonical_id, corroborations,
 * replaces, evidence_state, confidence_score, routing_eligible, flagged_at) are
 * never touched by a resupply — and NO evidence row is appended: a restated
 * record is the SAME record, not an independent witness.
 *
 * A resupply is legitimate iff either:
 *  - the SAME origin instance is restating its own row (`instance_id` equal) —
 *    this is the only path that may also UPDATE content to a newer version; or
 *  - two DIFFERENT peers independently ingested the SAME upstream FEED record,
 *    whose `canonicalId` is source-derived (`hash(source, recordId)`, not
 *    instance-namespaced), so a matching canonicalId on a same-source feed row
 *    that this instance did NOT originate is that same upstream record — the
 *    peer joins the origin chain but never rewrites the other instance's
 *    content.
 *
 * Anything else — a collision against a LOCAL row, a cross-instance CROWD
 * canonicalId (which IS instance-namespaced, so a different instance sharing it
 * is a forgery), or a source mismatch — is a NON-OWNED collision: a peer can
 * craft a colliding canonicalId/content, so we write NOTHING (no hop into
 * provenance we did not originate, no content) and report it.
 */
async function collapseResupply(
  tx: Tx,
  existing: ExistingRow,
  normalized: Observation,
  row: ReturnType<typeof toRow>,
  ctx: FederatedIngestContext
): Promise<LandedWithin> {
  const sameOriginInstance = existing.instance_id === normalized.instanceId;
  const existingLocallyOwned = existing.instance_id === ctx.localInstanceId;
  const sameSourceFeed =
    existing.origin.kind === "feed" &&
    normalized.origin.kind === "feed" &&
    existing.source === normalized.source;
  // A local row is never a cross-peer feed resupply target (that is the
  // confirmed provenance-poison vector); a cross-instance crowd collision is a
  // forgery (crowd canonicalId is instance-namespaced).
  const legitimateResupply = sameOriginInstance || (!existingLocallyOwned && sameSourceFeed);
  if (!legitimateResupply) {
    return { kind: "non-owned-collision" };
  }

  const receipt: OriginHop = {
    instanceId: normalized.instanceId!,
    viaPeer: ctx.peerInstanceId,
    receivedAt: ctx.now,
  };
  const chain = mergeOriginChain(
    existing.origin.originChain,
    (normalized.origin as { originChain?: unknown }).originChain,
    receipt
  );
  const origin: Provenance = { ...existing.origin, originChain: chain };

  // Only the origin instance's OWN restatement may rewrite content — a peer
  // never overwrites another instance's (or a local) row's content.
  const contentUpdated =
    sameOriginInstance && Date.parse(row.data_updated_at) > existing.data_updated_at.getTime();

  if (contentUpdated) {
    await tx`
      UPDATE conditions.observations SET
        source = ${row.source},
        source_format = ${row.source_format},
        domain = ${row.domain},
        kind = ${row.kind},
        type = ${row.type},
        subtype = ${row.subtype},
        category = ${row.category},
        severity = ${row.severity},
        severity_source = ${row.severity_source},
        headline = ${row.headline},
        description = ${row.description},
        label = ${row.label},
        metric = ${row.metric},
        value = ${row.value},
        level = ${row.level},
        unit = ${row.unit},
        aggregation = ${row.aggregation},
        status = ${row.status},
        geom = ST_SetSRID(ST_GeomFromGeoJSON(${row.geometry_json}), 4326),
        subject = ${row.subject ? tx.json(row.subject as Jsonb) : null},
        attributes = ${row.attributes ? tx.json(row.attributes as Jsonb) : null},
        valid_from = ${row.valid_from},
        valid_to = ${row.valid_to},
        schedule = ${row.schedule ? tx.json(row.schedule as Jsonb) : null},
        confidence = ${row.confidence},
        is_forecast = ${row.is_forecast},
        related_ids = ${row.related_ids ? tx.json(row.related_ids as Jsonb) : null},
        data_updated_at = ${row.data_updated_at},
        fetched_at = ${row.fetched_at},
        expires_at = ${row.expires_at},
        content_hash = ${row.content_hash},
        phenomenon_fingerprint = ${row.phenomenon_fingerprint},
        fuzziness = COALESCE(${row.fuzziness}, fuzziness),
        severity_level = ${row.severity_level},
        privacy_class = ${row.privacy_class},
        k_anonymity = ${row.k_anonymity},
        dp_epsilon = ${row.dp_epsilon},
        dp_delta = ${row.dp_delta},
        informed = ${row.informed ? tx.json(row.informed as Jsonb) : null},
        source_uri = ${row.source_uri},
        source_license = ${row.source_license},
        origin = ${tx.json(origin as Jsonb)}
      WHERE id = ${existing.id}`;
    // A genuinely newer version may carry new `replaces` lineage — apply the
    // same origin-owned supersession the insert path applies.
    await applySupersession(tx, normalized, existing.id);
  } else {
    await tx`
      UPDATE conditions.observations SET origin = ${tx.json(origin as Jsonb)}
      WHERE id = ${existing.id}`;
  }

  return { kind: "resupplied", observationId: existing.id, contentUpdated };
}

/** Lands the new row. Returns false when the id is already taken (refused). */
async function insertFederatedRow(
  tx: Tx,
  normalized: Observation,
  row: ReturnType<typeof toRow>,
  ctx: FederatedIngestContext
): Promise<boolean> {
  const receipt: OriginHop = {
    instanceId: normalized.instanceId!,
    viaPeer: ctx.peerInstanceId,
    receivedAt: ctx.now,
  };
  const origin: Provenance = {
    ...normalized.origin,
    originChain: mergeOriginChain(
      undefined,
      (normalized.origin as { originChain?: unknown }).originChain,
      receipt
    ),
  };

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO conditions.observations (
      id, source, source_format, domain, kind,
      type, subtype, category, severity, severity_source,
      headline, description, label,
      metric, value, level, unit, aggregation,
      status, geom, subject, attributes,
      valid_from, valid_to, schedule,
      confidence, is_forecast, related_ids,
      origin, data_updated_at, fetched_at, expires_at, is_stale, content_hash,
      instance_id, canonical_id, phenomenon_fingerprint, replaces, corroborations,
      fuzziness, confidence_score, evidence_state, severity_level, privacy_class,
      k_anonymity, dp_epsilon, dp_delta, informed, source_uri, source_license
    ) VALUES (
      ${row.id}, ${row.source}, ${row.source_format}, ${row.domain}, ${row.kind},
      ${row.type}, ${row.subtype}, ${row.category}, ${row.severity}, ${row.severity_source},
      ${row.headline}, ${row.description}, ${row.label},
      ${row.metric}, ${row.value}, ${row.level}, ${row.unit}, ${row.aggregation},
      ${row.status}, ST_SetSRID(ST_GeomFromGeoJSON(${row.geometry_json}), 4326),
      ${row.subject ? tx.json(row.subject as Jsonb) : null},
      ${row.attributes ? tx.json(row.attributes as Jsonb) : null},
      ${row.valid_from}, ${row.valid_to},
      ${row.schedule ? tx.json(row.schedule as Jsonb) : null},
      ${row.confidence}, ${row.is_forecast},
      ${row.related_ids ? tx.json(row.related_ids as Jsonb) : null},
      ${tx.json(origin as Jsonb)}, ${row.data_updated_at}, ${row.fetched_at},
      ${row.expires_at}, ${row.is_stale}, ${row.content_hash},
      ${row.instance_id}, ${row.canonical_id}, ${row.phenomenon_fingerprint},
      ${row.replaces ? tx.json(row.replaces as Jsonb) : null},
      ${row.corroborations ? tx.json(row.corroborations as Jsonb) : null},
      COALESCE(${row.fuzziness}, 'exact'), ${row.confidence_score}, ${row.evidence_state},
      ${row.severity_level}, ${row.privacy_class},
      ${row.k_anonymity}, ${row.dp_epsilon}, ${row.dp_delta},
      ${row.informed ? tx.json(row.informed as Jsonb) : null},
      ${row.source_uri}, ${row.source_license}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return inserted.length > 0;
}

/**
 * `replaces` supersession — version lineage ONLY, never provenance and never
 * corroboration. Marks the referenced observations inactive iff they belong to
 * the incoming event's own origin instance (`instance_id` equal): an instance
 * may only supersede its OWN records, so a peer can never deactivate a local
 * row or another instance's row. Matches on either the row id or its
 * canonical id (`replaces` may carry either lineage key).
 */
async function applySupersession(
  tx: Tx,
  normalized: Observation,
  selfId?: string
): Promise<string[]> {
  const replaces = normalized.replaces ?? [];
  if (replaces.length === 0) return [];
  const rows = await tx<{ id: string }[]>`
    UPDATE conditions.observations SET status = 'inactive'
    WHERE (id = ANY(${tx.array(replaces)}::text[])
           OR canonical_id = ANY(${tx.array(replaces)}::text[]))
      AND instance_id = ${normalized.instanceId!}
      AND id <> ${selfId ?? normalized.id}
      AND status <> 'inactive'
    RETURNING id`;
  return rows.map((r) => r.id);
}
