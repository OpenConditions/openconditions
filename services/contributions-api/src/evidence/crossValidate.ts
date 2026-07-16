/**
 * Landing-time official cross-validation: the ADR §4 default routing gate driven
 * by authoritative feeds. When a just-landed CROWD report phenomenon-matches an
 * existing OFFICIAL FEED observation of the same event, that feed is an EXTERNAL
 * validator — the crowd report is routed via {@link applyExternalResolution}
 * (source "official"), which flips `routing_eligible` and trains the reporter's
 * Beta posterior. This is the supplementary validator; peer corroboration
 * ({@link autoCorroborateOnLanding}) remains the primary one for short-lived
 * events that never reach a feed and NEVER routes.
 *
 * The compatibility decision is the same pure, crowd/feed-aware
 * {@link matchPhenomenonCandidates} used everywhere else (a crowd/feed pair is
 * always independent, even when their source strings coincide). This module only
 * filters the fingerprint-neighborhood candidate set to genuine LOCAL FEED rows
 * (real `origin.kind === "feed"`, NOT merely a missing reporter keyId — a
 * federation-stripped remote CROWD row also lacks a keyId) and routes on the
 * first compatible feed.
 *
 * Trust boundary: only genuinely-LOCAL official feeds cross-validate. A LOCAL
 * feed — configured on and landed by this instance via services/ingest — carries
 * no `origin.originChain`; a FEDERATED feed relayed from a peer always carries
 * ≥1 originChain hop. A federated feed is a weaker, peer-dependent signal, so it
 * is excluded from the candidate set and can never grant local routing
 * eligibility (a peer-echo trust hole otherwise).
 *
 * Federated CROWD target (`deps.allowFederatedTarget`): federation export strips
 * `origin.reporter`, so a federated crowd row is keyId-less and the STRICT guard
 * skips it. The federation-ingest path opts into routing such a row on a LOCAL
 * feed via `allowFederatedTarget: true` — a route-without-training IN THE
 * FEDERATED-ONLY case (the NULL-keyed originator resolves to no affected keys and
 * no local confirmer exists, so `applyExternalResolution`'s reputation blocks
 * no-op). It is NOT unconditionally training-free: a genuine pre-cutoff LOCAL
 * confirmer of the federated row (a local crowd report that earlier merged into it
 * via corroboration, carrying its keyId) is still trained, exactly as on any
 * external resolution. The trust anchor stays OUR OWN local feed, never the peer's
 * word. Only the keyId requirement is relaxed:
 * the origin.kind='crowd' check (a federated FEED is never a routable target) and
 * the local-feed-only candidate guard (crowd↔crowd never routes) are unchanged.
 *
 * Accountability asymmetry (documented at the federation-ingest call site):
 * route-without-training removes the per-key deterrents a local reporter has
 * (rate-limit / reputation / block). A misbehaving peer that spams keyId-less
 * crowd rows shadowing local feeds is handled by the peer-level kill-switch (the
 * peer-blocklist rejects its inbound ingest), NOT by per-report throttling.
 *
 * Scope: the CROWD landing hook only. Feed landings never notify
 * contributions-api, so a feed that arrives AFTER a crowd report does not
 * retroactively validate it in v1 (a feed-side hook or a periodic cross-match
 * job is a tracked follow-on).
 */
import type postgres from "postgres";
import { matchPhenomenonCandidates, type PhenomenonCandidate } from "@openconditions/contrib-core";
import { findCandidates } from "./phenomenon.js";
import { applyExternalResolution } from "../reputation/resolve.js";

type Sql = postgres.Sql;

interface TargetRow {
  domain: string;
  type: string | null;
  kind: string;
  geojson: string;
  valid_from: Date | null;
  attributes: Record<string, unknown> | null;
  origin: { kind?: string; reporter?: { keyId?: string }; originChain?: unknown } | null;
  source: string;
  status: string;
  flagged_at: Date | null;
}

function actorFor(row: TargetRow): { keyId?: string; source: string } {
  if (row.origin?.kind === "crowd") {
    const keyId = row.origin.reporter?.keyId;
    return keyId !== undefined ? { keyId, source: row.source } : { source: row.source };
  }
  return { source: row.source };
}

/** Injection seam for the routing function (defaults to the real resolution). */
export interface CrossValidateDeps {
  applyExternalResolution?: typeof applyExternalResolution;
  /**
   * Relax the strict target guard to also route a genuinely-FEDERATED CROWD row
   * (origin.kind='crowd', reporter stripped → keyId-less, non-empty
   * origin.originChain). Defaults FALSE — the crowd-landing path AND the
   * feed-arrives-later sweep keep the strict keyId guard so a keyId-less target
   * is never routed there. Only the federation-ingest call sets this true.
   *
   * When true, only the KEY-ID requirement is relaxed, and only for a real
   * federated crowd target: a federated FEED row (also keyId-less +
   * originChain-present) still fails the origin.kind='crowd' check, and a
   * keyId-less crowd row WITHOUT an originChain (a local anomaly) is still
   * rejected. The LOCAL-feed-only candidate guard below is unchanged, so
   * crowd↔crowd never routes and only OUR own local official feed can grant
   * routing eligibility.
   */
  allowFederatedTarget?: boolean;
}

/** Whether `origin.originChain` is a non-empty array — proof a row is genuinely federated. */
function hasOriginChain(origin: { originChain?: unknown } | null): boolean {
  return Array.isArray(origin?.originChain) && origin.originChain.length > 0;
}

/**
 * Cross-validate the just-landed CROWD `observationId` against every OFFICIAL
 * FEED observation in its fingerprint neighborhood. On the FIRST phenomenon-
 * compatible feed, route the crowd report via
 * `applyExternalResolution(..., { source: "official", outcome: "confirmed" })`
 * and return that feed's id. Returns null when the observation is not an active
 * crowd event, has no feed neighbor, or none is compatible.
 *
 * Idempotent: `applyExternalResolution`'s insert is NOT-EXISTS-guarded, so a
 * replay appends no second external row and trains no second time.
 */
export async function crossValidateAgainstFeeds(
  sql: Sql,
  observationId: string,
  now: string,
  deps: CrossValidateDeps = {}
): Promise<string | null> {
  const resolve = deps.applyExternalResolution ?? applyExternalResolution;

  const rows = await sql<TargetRow[]>`
    SELECT domain, type, kind, ST_AsGeoJSON(geom) AS geojson, valid_from,
           attributes, origin, source, status, flagged_at
    FROM conditions.observations
    WHERE id = ${observationId}
  `;
  const row = rows[0];
  if (row === undefined || row.kind !== "event" || row.valid_from === null) {
    return null;
  }
  // Only an ACTIVE crowd report is validated here. A feed target never routes via
  // this path, and a row a concurrent corroboration already merged away
  // (inactive) must not be resolved.
  if (row.status !== "active") {
    return null;
  }
  // A flagged (kinematically-implausible / StreetComplete pile-on) landing is a
  // disputed report: exactly as autoCorroborate refuses flagged witnesses, we do
  // not route a report while its reviewer flag is still open.
  if (row.flagged_at !== null) {
    return null;
  }
  const targetActor = actorFor(row);
  // The target must be a CROWD row (a feed never routes via this path). FABLE FIX
  // 3c: keep this origin.kind='crowd' check even under allowFederatedTarget — a
  // federated FEED row is ALSO keyId-less + originChain-present, and must NOT be
  // routed as if it were crowd.
  if (row.origin?.kind !== "crowd") {
    return null;
  }
  if (targetActor.keyId === undefined) {
    // A keyId-less crowd row is a FEDERATED crowd report (federation export strips
    // origin.reporter). By default (crowd-landing + sweep) it is skipped — the
    // strict guard is preserved. Only an explicit allowFederatedTarget caller
    // routes it, and ONLY when its origin.originChain proves it is genuinely
    // federated (≥1 hop). A keyId-less crowd row WITHOUT an originChain is a local
    // anomaly (a local crowd row always carries a reporter keyId) and is never
    // routed.
    if (deps.allowFederatedTarget !== true || !hasOriginChain(row.origin)) {
      return null;
    }
  }

  const allCandidates = await findCandidates(sql, observationId);
  if (allCandidates.length === 0) {
    return null;
  }
  // LOCAL FEED candidates ONLY, keyed on the row's REAL origin.kind — NOT on a
  // missing reporter keyId. Federation export strips `origin.reporter` from crowd
  // rows while keeping `origin.kind: "crowd"`, so a keyId-less candidate can still
  // be a (remote) CROWD report; routing against one would be forbidden crowd↔crowd
  // routing. Only genuine `origin.kind === "feed"` rows may cross-validate.
  //
  // The originChain clause further narrows this to genuinely-LOCAL feeds: a feed
  // this instance configured and landed via services/ingest has NO originChain,
  // whereas a FEDERATED feed relayed from a peer always carries ≥1 originChain hop
  // (stamped by federation/ingest.ts). A federated feed is a weaker, peer-dependent
  // trust signal, so it must not grant local routing eligibility — letting a
  // less-trusted or compromised peer's relayed "feed" route a local crowd report
  // would be a peer-echo trust hole. Only local official feeds cross-validate.
  // A malformed (non-array) originChain fails closed via the jsonb_typeof guard:
  // it does not match the local condition, so it is treated as federated (never
  // routes) rather than throwing on jsonb_array_length.
  const feedIdRows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.observations
    WHERE id = ANY(${allCandidates.map((c) => c.id)})
      AND origin->>'kind' = 'feed'
      AND (
        origin->'originChain' IS NULL
        OR (jsonb_typeof(origin->'originChain') = 'array' AND jsonb_array_length(origin->'originChain') = 0)
      )
  `;
  const feedIds = new Set(feedIdRows.map((r) => r.id));
  const feedCandidates = allCandidates.filter((c) => feedIds.has(c.id));
  if (feedCandidates.length === 0) {
    return null;
  }

  const target: PhenomenonCandidate = {
    id: observationId,
    domain: row.domain,
    type: row.type ?? "",
    geometry: JSON.parse(row.geojson),
    validFrom: row.valid_from.toISOString(),
    attributes: row.attributes ?? undefined,
    actor: targetActor,
    status: row.status,
  };

  const match = matchPhenomenonCandidates(target, feedCandidates).find(
    (decision) => decision.compatible
  );
  if (match === undefined) {
    return null;
  }

  // One official match suffices to route; applyExternalResolution is replay-safe
  // if multiple feeds match or the hook re-fires.
  await resolve(sql, observationId, { source: "official", outcome: "confirmed" }, now);
  return match.candidateId;
}
