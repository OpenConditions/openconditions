import {
  isKinematicallyPlausible,
  type PriorReport,
  type SignedReport,
} from "@openconditions/contrib-core";
import { centroid, coarseCell, type GeoJsonGeometry } from "@openconditions/core";
import {
  type EvidenceState,
  type LandingContext,
  landClaim,
  type Registry,
  type ValidationIssue,
} from "@openconditions/model";
import { writeRecordIn } from "@openconditions/storage";
import type postgres from "postgres";
import { checkReportRate, ReportRateLimitError } from "../abuse/rate.js";
import { lockCrowd } from "../crowd.js";
import { recomputeEvidence } from "../evidence/recompute.js";

type Sql = postgres.Sql;

export interface LandingResult {
  record: { class: "situation"; id: string };
  evidenceState: EvidenceState | null;
  routingEligible: boolean;
  /** False when the nonce was already landed (idempotent replay). */
  inserted: boolean;
  /**
   * True when the transition from this key's previous report was
   * kinematically implausible and the NEW situation was flagged (flagged_at
   * set). A post-hoc anomaly signal — the report still landed.
   */
  kinematicFlagged: boolean;
}

/** A claim the registry or the landing rules refuse, with why. */
export class ClaimRefusedError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super("claim refused");
    this.name = "ClaimRefusedError";
  }
}

/**
 * A residual PostGIS geometry-construction failure. The geometry screen is
 * the primary guard, so a claim should never reach the DB with a shape
 * PostGIS rejects; this backstop translates any that slip through into a 422
 * at the route rather than a 500 leaking the raw PostGIS message.
 */
export class GeometryInvalidError extends Error {
  constructor(cause: unknown) {
    super("geometry-invalid");
    this.name = "GeometryInvalidError";
    this.cause = cause;
  }
}

/**
 * True for a PostGIS/GEOS error raised while parsing/constructing the geometry.
 * Matches on geometry-specific vocabulary only — a bare phrase like "must have"
 * is NOT matched on its own, so an unrelated DB error can never be misclassified
 * as a 422. Still catches every realistic `ST_GeomFromGeoJSON` failure.
 */
export function isGeometryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /geojson|geometry|geometrycollection|lwgeom|geos|linestring|multiline|polygon|multipolygon|multipoint|linearring|\bring\b|ordinate|coordinate|dimension|closed linestring|requires more|too few points/i.test(
    message,
  );
}

/**
 * Land a verified crowd report as a situation record. `landClaim` makes the
 * claim a crowd draft (lifetime, provenance, the 5-minute, 24-hour and expiry
 * checks); the write seam seals and stores it as the `crowd` source; its
 * initial `report` evidence row is appended and its evidence recomputed, all
 * in ONE transaction under the crowd lock.
 *
 * Idempotency: the id is the hash of the key and the nonce, so a replayed
 * claim lands on the stored row; nothing is appended or recomputed, and the
 * stored evidence summary is returned.
 *
 * The evidence row's `occurred_at` is the SERVER clock `ctx.now` (the instant
 * the server observed the report), and the ledger counts the report from
 * the earlier of that and the claim's `reportedAt`, so `evaluateEvidence`
 * always has an admissible report and a late upload lives only what is left
 * of its lifetime.
 *
 * @throws ClaimRefusedError when the claim cannot land.
 * @throws ReportRateLimitError when the key reports too fast.
 * @throws GeometryInvalidError on a residual PostGIS geometry error.
 */
export async function landReport(
  sql: Sql,
  registry: Registry,
  report: SignedReport,
  ctx: LandingContext,
): Promise<LandingResult> {
  const landing = landClaim(registry, { claim: report.claim, keyId: report.keyId }, ctx);
  if (!landing.ok) throw new ClaimRefusedError(landing.issues);
  try {
    return await landWithin(sql, registry, landing.draft, report.keyId, ctx);
  } catch (err) {
    if (isGeometryError(err)) throw new GeometryInvalidError(err);
    throw err;
  }
}

async function landWithin(
  sql: Sql,
  registry: Registry,
  draft: Record<string, unknown>,
  keyId: string,
  ctx: LandingContext,
): Promise<LandingResult> {
  const id = draft["id"] as string;
  const geometry = (draft["location"] as { geometry: GeoJsonGeometry }).geometry;
  return sql.begin(async (tx) => {
    // Admission and evidence insertion share the crowd lock. Replays return
    // before admission, including when the key has filled its quota.
    await lockCrowd(tx);
    const [existing] = await tx<
      { evidence_state: EvidenceState | null; routing_eligible: boolean }[]
    >`SELECT evidence_state, routing_eligible FROM conditions.situation WHERE id = ${id}`;
    if (existing) {
      return {
        record: { class: "situation", id },
        evidenceState: existing.evidence_state,
        routingEligible: existing.routing_eligible,
        inserted: false,
        kinematicFlagged: false,
      };
    }
    const [lon, lat] = centroid(geometry);
    const admission = await checkReportRate(tx, keyId, lon, lat, ctx.now);
    if (!admission.ok) throw new ReportRateLimitError(admission.reason!);

    const written = await writeRecordIn(
      tx,
      { draft },
      { registry, instanceId: ctx.instanceId, now: ctx.now },
    );
    if (written.status === "rejected") throw new ClaimRefusedError(written.issues);

    // The evidence row is the server's: `occurred_at` is when the report
    // arrived, which the rate limiter and the kinematic check count by, so a
    // backdated claim dodges neither. It carries the report's coarse area cell
    // (the per-(key, cell) rate limiter counts on `details->>'cell'` without a
    // geometry join) and the reporter's own instant, which the report's
    // lifetime counts from.
    const reportedAt = (draft["validity"] as { start: string }).start;
    await tx`
      INSERT INTO conditions.report_evidence
        (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
      VALUES ('situation', ${id}, 'report', ${keyId}, ${ctx.now},
              ${tx.json({ cell: coarseCell(lon, lat), reportedAt })})
    `;
    const result = await recomputeEvidence(sql, registry, id, ctx.now, tx);
    const kinematicFlagged = await flagIfKinematicallyImplausible(tx, id, geometry, keyId, ctx.now);
    return {
      record: { class: "situation", id },
      evidenceState: result?.state ?? null,
      routingEligible: result?.routingEligible ?? false,
      inserted: true,
      kinematicFlagged,
    };
  });
}

/**
 * Post-hoc kinematic plausibility (ADR anomaly flagging): if reaching this
 * report from the key's PREVIOUS landed report would imply an impossible
 * speed, set flagged_at on the NEW situation. Both instants are the SERVER
 * clock (`occurred_at` / now), so a client cannot dodge the check by
 * backdating `reportedAt`. This NEVER blocks the landing — a truthful fast
 * mover must not be censored; the report stays self_reported and only gains
 * reviewer-queue visibility.
 */
async function flagIfKinematicallyImplausible(
  tx: postgres.TransactionSql,
  id: string,
  geometry: GeoJsonGeometry,
  keyId: string,
  now: string,
): Promise<boolean> {
  const [previousRow] = await tx<{ geometry: string; occurred_at: Date }[]>`
    SELECT ST_AsGeoJSON(s.geom) AS geometry, e.occurred_at
    FROM conditions.report_evidence e
    JOIN conditions.situation s ON s.id = e.record_id
    WHERE e.actor_key_id = ${keyId}
      AND e.evidence_kind = 'report'
      AND e.record_class = 'situation'
      AND e.record_id <> ${id}
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT 1
  `;
  if (previousRow === undefined) return false;
  const previous: PriorReport = {
    geometry: JSON.parse(previousRow.geometry),
    reportedAt: new Date(previousRow.occurred_at).toISOString(),
  };
  if (isKinematicallyPlausible(previous, { geometry, reportedAt: now })) return false;
  await tx`
    UPDATE conditions.situation SET flagged_at = ${now}
    WHERE id = ${id} AND flagged_at IS NULL
  `;
  return true;
}
