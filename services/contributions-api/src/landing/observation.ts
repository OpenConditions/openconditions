import {
  isKinematicallyPlausible,
  type PriorReport,
  type SignedReport,
} from "@openconditions/contrib-core";
import {
  canonicalKeyOf,
  centroid,
  coarseCell,
  coarseCellCentre,
  type GeoJsonGeometry,
} from "@openconditions/core";
import {
  crowdLocalId,
  type EvidenceState,
  jcs,
  type LandingContext,
  type LocationRef,
  landClaim,
  type ObservationClaim,
  qualifierKey,
  type Registry,
  type ResolvedFeature,
  subjectKey,
} from "@openconditions/model";
import { isPublicCandidate, loadCanonical, writeRecordIn } from "@openconditions/storage";
import type postgres from "postgres";
import { checkReportRate, ReportRateLimitError } from "../abuse/rate.js";
import { lockCrowd } from "../crowd.js";
import { recomputeObservationEvidence } from "../evidence/recompute.js";
import { ClaimRefusedError, GeometryInvalidError, isGeometryError } from "./land.js";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Rec = Record<string, unknown>;

export interface ObservationLandingResult {
  record: { class: "observation"; id: string };
  evidenceState: EvidenceState | null;
  /** False when nothing new landed: a replay, or the same reading the same key already gave. */
  inserted: boolean;
  /** True when the report was taken as a confirmation of the same reading another key gave. */
  confirmed: boolean;
  /**
   * True when reaching where this report was made from the key's previous
   * report implies an impossible speed. An observation has no flag column:
   * the signal is logged by the route and the report still lands.
   */
  kinematicFlagged: boolean;
}

/** A reading of the same subject, property and instant, with another result, is already held. */
export class ConflictingReportError extends Error {
  constructor(readonly existingId: string) {
    super("conflicting_report");
    this.name = "ConflictingReportError";
  }
}

const refused = (path: string[], code: string, message: string) =>
  new ClaimRefusedError([{ path, code, message }]);

/**
 * Lands a verified observation claim: a reading of a feature, a component or
 * a place the crowd may report. A feature named by a per-source or a
 * canonical id lands on its canonical feature, a component on the canonical
 * component it stands in (`feature_canonical.components`), at a public
 * member's location (see `resolveSubject`). A place lands only where a feed
 * already publishes a series of that property for it, and takes a public
 * series' location. The public scope serves crowd rows, so a crowd row never
 * takes a restricted source's location: with no public member it sits at the
 * centre of the reporter's area cell, and with no public series at the place
 * the reporter named. Either way the reporter must stand within reach of
 * where the restricted source puts it. The crowd row is written under the crowd
 * lock with its `report` evidence (`details.localId` keys replays: a
 * reading's id is its subject and instant, not its reporter), its evidence
 * recomputed into the row and the subject's fused row recomputed.
 *
 * A second key reporting the same reading of the same subject at the same
 * instant confirms the stored report when the results agree and is refused
 * with {@link ConflictingReportError} when they do not. The rate limiter and
 * the kinematic check use where the reporter stood, which is never stored as
 * it is.
 *
 * @throws ClaimRefusedError when the claim cannot land.
 * @throws ConflictingReportError when another key reported another result.
 * @throws ReportRateLimitError when the key reports too fast.
 */
export async function landObservationReport(
  sql: Sql,
  registry: Registry,
  report: SignedReport,
  ctx: Omit<LandingContext, "resolveFeature" | "placeReachFrom">,
): Promise<ObservationLandingResult> {
  const claim = report.claim as ObservationClaim;
  const keyId = report.keyId;
  const localId = crowdLocalId(keyId, claim.nonce);
  try {
    return await sql.begin(async (tx) => {
      await lockCrowd(tx);
      const replayed = await replay(tx, keyId, localId);
      if (replayed !== undefined) return replayed;

      const { claim: placed, resolveFeature, placeReachFrom } = await resolveSubject(tx, claim);
      const landing = landClaim(
        registry,
        { claim: placed, keyId },
        {
          ...ctx,
          ...(resolveFeature === undefined ? {} : { resolveFeature }),
          ...(placeReachFrom === undefined ? {} : { placeReachFrom }),
        },
      );
      if (!landing.ok) throw new ClaimRefusedError(landing.issues);
      const draft = landing.draft;
      const id = draft["id"] as string;

      const held = await heldReading(tx, id);
      if (held !== undefined) {
        if (jcs(held.result) !== jcs(draft["result"])) throw new ConflictingReportError(id);
        if (held.reporters.includes(keyId)) {
          return {
            record: { class: "observation" as const, id },
            evidenceState: held.evidenceState,
            inserted: false,
            confirmed: false,
            kinematicFlagged: false,
          };
        }
      }

      const [lon, lat] = claim.geometry.coordinates;
      const admission = await checkReportRate(tx, keyId, lon, lat, ctx.now);
      if (!admission.ok) throw new ReportRateLimitError(admission.reason!);
      const kinematicFlagged = await implausibleFromLast(tx, keyId, claim.geometry, ctx.now);

      if (held === undefined) {
        const written = await writeRecordIn(
          tx,
          { draft },
          { registry, instanceId: ctx.instanceId, now: ctx.now },
        );
        if (written.status === "rejected") throw new ClaimRefusedError([...written.issues]);
      }
      // The ledger dates a report by when it was made; a confirmation of the
      // same reading by another key is a `confirm` by that key.
      await tx`
        INSERT INTO conditions.report_evidence
          (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
        VALUES ('observation', ${id}, ${held === undefined ? "report" : "confirm"}, ${keyId},
                ${ctx.now}, ${tx.json({
                  cell: coarseCell(lon, lat),
                  reportedAt: claim.reportedAt,
                  localId,
                  // A later reading of the series replaces this one's row; a
                  // colliding report is still compared with what this said.
                  ...(held === undefined ? { result: draft["result"] } : { via: "same-reading" }),
                } as never)})
      `;
      const result = await recomputeObservationEvidence(tx, registry, id, ctx.now);
      return {
        record: { class: "observation" as const, id },
        evidenceState: result?.state ?? null,
        inserted: true,
        confirmed: held !== undefined,
        kinematicFlagged,
      };
    });
  } catch (err) {
    if (isGeometryError(err)) throw new GeometryInvalidError(err);
    throw err;
  }
}

/** A replay of a report this key landed: the same key and nonce, so the same local id. */
async function replay(
  tx: Tx,
  keyId: string,
  localId: string,
): Promise<ObservationLandingResult | undefined> {
  const [row] = await tx<{ record_id: string; evidence_state: EvidenceState | null }[]>`
    SELECT e.record_id, l.evidence_state
      FROM conditions.report_evidence e
      LEFT JOIN conditions.observation_latest l
        ON l.crowd_record_id = e.record_id
     WHERE e.record_class = 'observation' AND e.actor_key_id = ${keyId}
       AND e.details->>'localId' = ${localId}
     LIMIT 1`;
  if (row === undefined) return undefined;
  return {
    record: { class: "observation", id: row.record_id },
    evidenceState: row.evidence_state,
    inserted: false,
    confirmed: false,
    kinematicFlagged: false,
  };
}

/**
 * The crowd reading already held under an id — the current reading of its
 * series, or one of its history — with the keys that reported or confirmed
 * it.
 */
async function heldReading(
  tx: Tx,
  id: string,
): Promise<
  { result: unknown; evidenceState: EvidenceState | null; reporters: string[] } | undefined
> {
  const [current] = await tx<{ result: unknown; evidence_state: EvidenceState | null }[]>`
    SELECT reading->'result' AS result, evidence_state FROM conditions.observation_latest
     WHERE crowd_record_id = ${id}`;
  const reporters = await tx<{ actor_key_id: string }[]>`
    SELECT DISTINCT actor_key_id FROM conditions.report_evidence
     WHERE record_class = 'observation' AND record_id = ${id}
       AND evidence_kind IN ('report', 'confirm') AND actor_key_id IS NOT NULL`;
  if (current === undefined && reporters.length === 0) return undefined;
  if (current === undefined) {
    // A reading its series has since moved past: its result is in the series' history.
    const [stored] = await tx<{ result: unknown }[]>`
      SELECT e.details->'result' AS result FROM conditions.report_evidence e
       WHERE e.record_class = 'observation' AND e.record_id = ${id} AND e.evidence_kind = 'report'
       LIMIT 1`;
    return {
      result: stored?.result ?? null,
      evidenceState: null,
      reporters: reporters.map((r) => r.actor_key_id),
    };
  }
  return {
    result: current.result,
    evidenceState: current.evidence_state,
    reporters: reporters.map((r) => r.actor_key_id),
  };
}

/**
 * Where a claim lands. A feature claim resolves through the canonical view: a
 * per-source or canonical feature id, a component through the canonical
 * components. Its location is a public member's (its source held
 * unrestricted, its record's licences public, as fusion judges a member):
 * the survivor's, else the first public member's in member order, else the
 * centre of the reporter's area cell at low resolution, with its reach
 * measured from a live member's location. A place claim is placed on the
 * feed series of its property already published for that place, a public
 * series first, whose location it takes; when only restricted sources
 * publish one, it keeps the place the reporter named (one keyed by its
 * geocode placed at the centre of its centroid's area cell, at low
 * resolution), with its reach measured from the series' location. With no
 * series it names nothing this
 * instance holds.
 */
async function resolveSubject(
  tx: Tx,
  claim: ObservationClaim,
): Promise<{
  claim: ObservationClaim;
  resolveFeature?: LandingContext["resolveFeature"];
  placeReachFrom?: LocationRef;
}> {
  if ("location" in claim.subject) {
    let key: string;
    try {
      key = subjectKey({
        subject: { kind: "location" },
        location: claim.subject.location as never,
      });
    } catch {
      throw refused(["subject"], "unknown_subject", "the place names no location");
    }
    const [series] = await tx<{ location: LocationRef; restricted: boolean }[]>`
      SELECT l.template->'location' AS location, COALESCE(s.restricted, false) AS restricted
        FROM conditions.observation_latest l
        LEFT JOIN conditions.source s ON s.id = l.source_id
       WHERE l.subject_key = ${key} AND l.property = ${claim.property}
         AND l.qualifier_key = ${qualifierKey(claim.qualifiers)}
         AND l.source_id NOT IN ('crowd', '@fused', '@fused-public')
         AND l.template #>> '{provenance,origin}' = 'feed'
       ORDER BY COALESCE(s.restricted, false), l.effective_from DESC LIMIT 1`;
    if (series === undefined) {
      throw refused(
        ["subject"],
        "unknown_subject",
        `no feed publishes ${claim.property} for this place`,
      );
    }
    // Only restricted feeds publish it: the reporter's own place, reached
    // from the series'. A place keyed by its geocode is keyed apart from its
    // geometry, which may then be the device's point: it is kept only as the
    // centre of the area cell its centroid falls in, at low resolution.
    if (series.restricted) {
      const named = claim.subject.location;
      if (named.admin?.geocodes?.[0] === undefined || named.geometry === null) {
        return { claim, placeReachFrom: series.location };
      }
      const coarse: LocationRef = {
        ...named,
        geometry: { type: "Point", coordinates: coarseCellCentre(...centroid(named.geometry)) },
        fuzziness: "low_res",
      };
      return {
        claim: { ...claim, subject: { location: coarse } },
        placeReachFrom: series.location,
      };
    }
    return { claim: { ...claim, subject: { location: series.location } } };
  }
  const [canonical] = await loadCanonical(tx, [claim.subject.featureId]);
  if (canonical === undefined) return { claim, resolveFeature: () => undefined };
  const members = await tx<
    {
      id: string;
      location: LocationRef;
      source_id: string;
      restricted: boolean | null;
      record: Rec;
    }[]
  >`
    SELECT f.id, f.record->'location' AS location, f.source_id, s.restricted,
           jsonb_build_object('provenance', f.record->'provenance') AS record
      FROM conditions.feature f
      LEFT JOIN conditions.source s ON s.id = f.source_id
     WHERE f.id = ANY(${canonical.memberIds}::text[]) AND f.tombstoned_at IS NULL`;
  const live = new Map(members.map((m) => [m.id, m]));
  const survivor = live.get(canonical.survivorId);
  const ordered = [canonical.survivorId, ...canonical.memberIds].map((id) => live.get(id));
  // The survivor's location when it is public, else the first public
  // member's in member order, else the reporter's area cell. The reach is
  // measured from where the feature stands, whoever holds it.
  const publicMember = ordered.find(
    (m) =>
      m !== undefined &&
      isPublicCandidate({ restricted: m.restricted, record: m.record, sourceId: m.source_id }),
  );
  const placed = ordered.find((m) => m?.location.geometry != null);
  const [lon, lat] = claim.geometry.coordinates;
  const location: LocationRef = publicMember?.location ?? {
    geometry: { type: "Point", coordinates: coarseCellCentre(lon, lat) },
    extent: "point",
    geometryOrigin: "crowd_device",
    fuzziness: "low_res",
  };
  const reachFrom =
    publicMember === undefined ? (placed?.location ?? survivor?.location) : undefined;
  const resolveFeature = (
    featureId: string,
    componentKey?: string,
  ): ResolvedFeature | undefined => {
    if (survivor === undefined) return undefined;
    let key: string | undefined;
    if (componentKey !== undefined) {
      key =
        featureId === canonical.canonicalFeatureId
          ? canonical.components.find((c) => c.key === componentKey)?.key
          : canonicalKeyOf(canonical, featureId, componentKey);
      if (key === undefined) return undefined;
    }
    return {
      featureId: canonical.canonicalFeatureId,
      ...(key === undefined ? {} : { componentKey: key }),
      location,
      ...(reachFrom === undefined ? {} : { reachFrom }),
    };
  };
  return { claim, resolveFeature };
}

/**
 * Whether reaching where this report was made from where the key's previous
 * report stood implies an impossible speed. The previous report stood at its
 * situation, or at the subject its reading was about (within the property's
 * reach of the reporter); both instants are the server's.
 */
async function implausibleFromLast(
  tx: Tx,
  keyId: string,
  geometry: GeoJsonGeometry | ObservationClaim["geometry"],
  now: string,
): Promise<boolean> {
  const [previous] = await tx<{ geometry: string | null; occurred_at: Date }[]>`
    SELECT COALESCE(
             (SELECT ST_AsGeoJSON(s.geom) FROM conditions.situation s
               WHERE e.record_class = 'situation' AND s.id = e.record_id),
             (SELECT ST_AsGeoJSON(l.geom) FROM conditions.observation_latest l
               WHERE e.record_class = 'observation' AND l.source_id = 'crowd'
                 AND l.crowd_record_id = e.record_id)) AS geometry,
           e.occurred_at
      FROM conditions.report_evidence e
     WHERE e.actor_key_id = ${keyId} AND e.evidence_kind = 'report'
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT 1`;
  if (previous?.geometry == null) return false;
  const prior: PriorReport = {
    geometry: JSON.parse(previous.geometry),
    reportedAt: new Date(previous.occurred_at).toISOString(),
  };
  return !isKinematicallyPlausible(prior, {
    geometry: geometry as GeoJsonGeometry,
    reportedAt: now,
  });
}
