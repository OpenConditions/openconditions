/**
 * The StreetComplete landing rule: after a new report lands, if its phenomenon
 * neighborhood matches an OPEN flagged observation (flagged, active, and
 * type-compatible per the T3 matcher), flag the NEW observation too. A cheap
 * "don't let reports pile onto a disputed element unnoticed" signal — warn-level
 * and post-hoc: the report has already landed 200; this NEVER blocks it.
 *
 * Reuses T3 `findCandidates` (the fingerprint-neighborhood opener) and
 * `matchPhenomenonCandidates` (the pure compatibility decision); nothing merges.
 */
import type postgres from "postgres";
import { matchPhenomenonCandidates, type PhenomenonCandidate } from "@openconditions/contrib-core";
import { findCandidates } from "../evidence/phenomenon.js";

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
}

function actorFor(row: TargetRow): { keyId?: string; source: string } {
  if (row.origin?.kind === "crowd") {
    const keyId = row.origin.reporter?.keyId;
    return keyId !== undefined ? { keyId, source: row.source } : { source: row.source };
  }
  return { source: row.source };
}

/**
 * If `observationId` is type-compatible with any OPEN flagged observation in its
 * fingerprint neighborhood, set `flagged_at` on it (idempotently) and return
 * true. Returns false when the observation is not a time-bucketed event, has no
 * neighbors, or none of its compatible neighbors are open-flagged.
 */
export async function flagOntoOpenFlagged(
  sql: Sql,
  observationId: string,
  now: string
): Promise<boolean> {
  const rows = await sql<TargetRow[]>`
    SELECT domain, type, kind, ST_AsGeoJSON(geom) AS geojson, valid_from,
           attributes, origin, source, status
    FROM conditions.observations
    WHERE id = ${observationId}
  `;
  const row = rows[0];
  if (row === undefined || row.kind !== "event" || row.valid_from === null) {
    return false;
  }

  const candidates = await findCandidates(sql, observationId);
  if (candidates.length === 0) {
    return false;
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
    return false;
  }

  const openFlagged = await sql<{ id: string }[]>`
    SELECT id FROM conditions.observations
    WHERE id = ANY(${compatibleIds})
      AND status = 'active'
      AND flagged_at IS NOT NULL
    LIMIT 1
  `;
  if (openFlagged.length === 0) {
    return false;
  }

  await sql`
    UPDATE conditions.observations SET flagged_at = ${now}
    WHERE id = ${observationId} AND flagged_at IS NULL
  `;
  return true;
}
