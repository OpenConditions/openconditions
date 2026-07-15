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
 * filters the fingerprint-neighborhood candidate set to genuine FEED rows (real
 * `origin.kind === "feed"`, NOT merely a missing reporter keyId — a
 * federation-stripped remote CROWD row also lacks a keyId) and routes on the
 * first compatible feed.
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
  origin: { kind?: string; reporter?: { keyId?: string } } | null;
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
  if (row.origin?.kind !== "crowd" || targetActor.keyId === undefined) {
    return null;
  }

  const allCandidates = await findCandidates(sql, observationId);
  if (allCandidates.length === 0) {
    return null;
  }
  // FEED candidates ONLY, keyed on the row's REAL origin.kind — NOT on a missing
  // reporter keyId. Federation export strips `origin.reporter` from crowd rows
  // while keeping `origin.kind: "crowd"`, so a keyId-less candidate can still be a
  // (remote) CROWD report; routing against one would be forbidden crowd↔crowd
  // routing. Only genuine `origin.kind === "feed"` rows may cross-validate.
  const feedIdRows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.observations
    WHERE id = ANY(${allCandidates.map((c) => c.id)})
      AND origin->>'kind' = 'feed'
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
