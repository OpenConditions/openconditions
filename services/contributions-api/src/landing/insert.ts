import type postgres from "postgres";
import type { EvidenceState } from "@openconditions/core";
import {
  reportToObservation,
  type CrowdLandingObservation,
  type LandingContext,
  type SignedReport,
} from "@openconditions/contrib-core";
import { normalizeObservation } from "@openconditions/ingest/pipeline/normalize";
import { recomputeEvidence } from "../evidence/recompute.js";

type Sql = postgres.Sql;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Jsonb = any;

export interface LandingResult {
  observationId: string;
  evidenceState: EvidenceState | null;
  routingEligible: boolean;
  /** False when the nonce was already landed (idempotent replay). */
  inserted: boolean;
}

/**
 * A residual PostGIS geometry-construction failure (`ST_GeomFromGeoJSON`).
 * Plausibility's arity/structure check is the primary guard, so a claim should
 * never reach the DB with a shape PostGIS rejects; this backstop translates any
 * that slip through into a 422 at the route rather than a 500 leaking the raw
 * PostGIS message.
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
    message
  );
}

/**
 * Land a verified crowd report as an Observation. The single row is normalized
 * through the SAME central seam the feed path uses (crowd writer context) — so
 * privacyClass/instanceId/canonicalId/phenomenonFingerprint are stamped
 * centrally and never trusted from the untrusted claim — then inserted with its
 * initial `report` evidence row, and its evidence state is recomputed, all in
 * ONE transaction.
 *
 * Idempotency: the id is `crowd:<keyId>:<nonce>`, so a replayed nonce hits
 * `ON CONFLICT (id) DO NOTHING`. On a replay we neither append a duplicate
 * evidence row nor recompute; we return the existing row's derived state. Since
 * the insert + evidence + recompute are one transaction, a committed
 * observation always has exactly one initial evidence row.
 *
 * The evidence row's `occurred_at` is the SERVER clock `ctx.now` (the instant
 * the server observed the report), which is `<= now`, so `evaluateEvidence`
 * always has an admissible report and the no-admissible-report TypeError from
 * clock skew cannot fire. The claim's `reportedAt` stays the observation's
 * `validFrom` (the phenomenon/decay basis).
 */
export async function landReport(
  sql: Sql,
  report: SignedReport,
  ctx: LandingContext
): Promise<LandingResult> {
  const mapped: CrowdLandingObservation = reportToObservation(report, ctx);
  const obs = normalizeObservation(mapped, {
    kind: "crowd",
    instanceId: ctx.instanceId,
  }) as CrowdLandingObservation;

  try {
    return await landWithin(sql, obs, report, ctx);
  } catch (err) {
    if (isGeometryError(err)) {
      throw new GeometryInvalidError(err);
    }
    throw err;
  }
}

async function landWithin(
  sql: Sql,
  obs: CrowdLandingObservation,
  report: SignedReport,
  ctx: LandingContext
): Promise<LandingResult> {
  return sql.begin(async (tx) => {
    const insertedRows = await tx<{ id: string }[]>`
      INSERT INTO conditions.observations (
        id, source, source_format, domain, kind, type,
        status, geom, subject, attributes,
        valid_from, origin, data_updated_at, fetched_at, is_stale,
        instance_id, canonical_id, phenomenon_fingerprint,
        fuzziness, privacy_class, severity_level, source_uri, source_license
      )
      VALUES (
        ${obs.id}, ${obs.source}, ${obs.sourceFormat}, ${obs.domain}, ${obs.kind}, ${obs.type},
        ${obs.status}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(obs.geometry)}), 4326),
        ${obs.subject ? tx.json(obs.subject as Jsonb) : null},
        ${obs.attributes ? tx.json(obs.attributes as Jsonb) : null},
        ${obs.validFrom ?? null}, ${tx.json(obs.origin as Jsonb)},
        ${obs.dataUpdatedAt}, ${obs.fetchedAt}, ${obs.isStale},
        ${obs.instanceId ?? null}, ${obs.canonicalId ?? null}, ${obs.phenomenonFingerprint ?? null},
        ${obs.fuzziness ?? null}, ${obs.privacyClass ?? null}, ${obs.severityLevel ?? null},
        ${obs.sourceUri ?? null}, ${obs.sourceLicense ?? null}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    if (insertedRows.length === 0) {
      const existing = await tx<
        { evidence_state: EvidenceState | null; routing_eligible: boolean }[]
      >`
        SELECT evidence_state, routing_eligible
        FROM conditions.observations WHERE id = ${obs.id}
      `;
      const row = existing[0];
      return {
        observationId: obs.id,
        evidenceState: row?.evidence_state ?? null,
        routingEligible: row?.routing_eligible ?? false,
        inserted: false,
      };
    }

    await tx`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, occurred_at, details)
      VALUES (${obs.id}, 'report', ${report.keyId}, ${ctx.now}, ${tx.json({} as Jsonb)})
    `;

    const result = await recomputeEvidence(sql, obs.id, ctx.now, tx);
    return {
      observationId: obs.id,
      evidenceState: result?.state ?? null,
      routingEligible: result?.routingEligible ?? false,
      inserted: true,
    };
  });
}
