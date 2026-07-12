/**
 * Landing-time auto-corroboration: the second step of the §7 evidence ladder.
 * After a fresh report lands, if an INDEPENDENT report of the same phenomenon is
 * already in its fingerprint neighborhood and type-compatible, the two are
 * merged. The survivor is NOT "the just-landed row" — `applyCorroboration`
 * chooses it by a stable global order (earlier survives) under the row lock, so
 * two concurrent landings converge on one survivor instead of annihilating each
 * other. Two independent witnesses raise the survivor to `corroborated`.
 *
 * Reuses the existing pieces (nothing is redefined here): `findCandidates` (the
 * fingerprint-neighborhood opener), `matchPhenomenonCandidates` (the pure
 * type/distance/time/direction/independence decision), and `applyCorroboration`
 * (the atomic merge + recompute). Corroboration NEVER sets `routing_eligible`
 * and NEVER trains reputation — only an external resolution routes.
 */
import type postgres from "postgres";
import { matchPhenomenonCandidates, type PhenomenonCandidate } from "@openconditions/contrib-core";
import { applyCorroboration, findCandidates } from "./phenomenon.js";

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

/**
 * Auto-corroborate the just-landed `observationId` against every INDEPENDENT,
 * type-compatible report already in its fingerprint neighborhood. Returns the
 * candidate ids it corroborated with (empty when the observation is not a
 * time-bucketed event, is flagged, has no neighbors, or none are compatible).
 *
 * Passes both ids to `applyCorroboration`, which determines the survivor itself
 * under the lock (earlier survives). Corroboration is idempotent, converges under
 * concurrency, and never routes.
 */
export async function autoCorroborateOnLanding(
  sql: Sql,
  observationId: string,
  now: string
): Promise<string[]> {
  const rows = await sql<TargetRow[]>`
    SELECT domain, type, kind, ST_AsGeoJSON(geom) AS geojson, valid_from,
           attributes, origin, source, status, flagged_at
    FROM conditions.observations
    WHERE id = ${observationId}
  `;
  const row = rows[0];
  if (row === undefined || row.kind !== "event" || row.valid_from === null) {
    return [];
  }
  // A disputed (flagged) landing is not a clean witness: a kinematically
  // implausible report, or one that piled onto an already-disputed element (the
  // StreetComplete rule), must stay a distinct row for review rather than be
  // silently merged into another observation. Corroboration waits for the
  // dispute to clear.
  if (row.flagged_at !== null) {
    return [];
  }

  const allCandidates = await findCandidates(sql, observationId);
  // Crowd-only for now: matching a crowd report to an OFFICIAL FEED observation
  // (cross-source validation) is a larger pass that would let one crowd report
  // corroborate an authoritative feed row. It is deliberately DEFERRED as a
  // tracked follow-up — reviewer external-resolution remains the routing gate in
  // the interim. Feed candidates carry no reporter keyId (actorFor sets keyId
  // only for crowd origin), so exclude them here.
  const candidates = allCandidates.filter((c) => c.actor.keyId !== undefined);
  if (candidates.length === 0) {
    return [];
  }

  const target: PhenomenonCandidate = {
    id: observationId,
    domain: row.domain,
    type: row.type ?? "",
    geometry: JSON.parse(row.geojson),
    validFrom: row.valid_from.toISOString(),
    attributes: row.attributes ?? undefined,
    actor: actorFor(row),
    status: row.status,
  };

  const compatibleIds = matchPhenomenonCandidates(target, candidates)
    .filter((decision) => decision.compatible)
    .map((decision) => decision.candidateId);
  if (compatibleIds.length === 0) {
    return [];
  }

  // Never corroborate ONTO a disputed (flagged) survivor either — raising a
  // disputed observation's confidence should wait for a reviewer, not a fresh
  // independent report.
  const flaggedRows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.observations
    WHERE id = ANY(${compatibleIds}) AND flagged_at IS NOT NULL
  `;
  const flagged = new Set(flaggedRows.map((r) => r.id));

  const corroborated: string[] = [];
  for (const candidateId of compatibleIds) {
    if (flagged.has(candidateId)) {
      continue;
    }
    await applyCorroboration(sql, observationId, candidateId, now);
    corroborated.push(candidateId);
  }
  return corroborated;
}
