import { observationId } from "../classes/observation.js";
import type { Effect } from "../kernel/effect-type.js";
import { formatRecordId, jcs, sha256Hex } from "../kernel/identity.js";
import type { Attribution } from "../kernel/provenance.js";
import type { LocationRef } from "../kernel/types.js";
import type { Registry, ValidationIssue } from "../registry/build.js";
import { majorOf } from "../registry/define.js";
import { distanceToGeometryMetres } from "./agree.js";
import {
  type ObservationClaim,
  type ReportClaim,
  type SituationClaim,
  validateClaim,
} from "./claim.js";
import { crowdRulesFor } from "./rules.js";

/** The trusted side of a landing, which the claim never supplies. */
export interface LandingContext {
  instanceId: string;
  /** The server clock. */
  now: string;
  /** How this instance credits its crowd. */
  attribution: Attribution;
  /**
   * The canonical feature (and canonical component key) a feature named by a
   * claim belongs to, with the location the observation copies; undefined
   * when no such feature or component exists.
   */
  resolveFeature?: (featureId: string, componentKey?: string) => ResolvedFeature | undefined;
  /**
   * Where a place claim's reach is measured from when that is not the place
   * it names: the series it lands on.
   */
  placeReachFrom?: LocationRef;
}

export interface ResolvedFeature {
  featureId: string;
  componentKey?: string;
  location: LocationRef;
  /** Where the feature stands, when that is not the `location` the observation copies. */
  reachFrom?: LocationRef;
}

export type Landing =
  | { ok: true; draft: Record<string, unknown>; expiresAt: string }
  | { ok: false; issues: ValidationIssue[] };

/** How far a reporter's clock may run ahead of the server's. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/**
 * How late a report may arrive, whatever its kind's lifetime: a device that
 * was offline uploads within the day, and an older report would place works or
 * a closure at a time nobody can check any more.
 */
const MAX_REPORT_AGE_MS = 24 * 3600 * 1000;

/**
 * A crowd record's local id: the hash of the reporter's key and the claim's
 * nonce. Replaying a claim lands the same id, and the id never reveals the key.
 */
export function crowdLocalId(keyId: string, nonce: string): string {
  return sha256Hex(jcs([keyId, nonce]));
}

/** DATEX's five severity steps, lowest to highest, as the kernel's labels. */
const LABEL_OF_LEVEL = ["minor", "minor", "moderate", "major", "critical"] as const;

function extentOf(geometry: SituationClaim["geometry"]): LocationRef["extent"] {
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return "point";
    case "LineString":
    case "MultiLineString":
      return "linear";
    default:
      return "area";
  }
}

const addSeconds = (at: string, sec: number) => new Date(Date.parse(at) + sec * 1000).toISOString();

function provenance(ctx: LandingContext, keyId: string, localId: string) {
  return {
    origin: "crowd",
    sourceId: "crowd",
    sourceFormat: "crowd",
    accessMode: "bulk",
    recordId: localId,
    attribution: ctx.attribution,
    reporter: { keyId },
    privacy: { class: "crowd_pseudonym" },
  };
}

function situationDraft(
  registry: Registry,
  claim: SituationClaim,
  keyId: string,
  ctx: LandingContext,
  expiresAt: string,
) {
  const entry = registry.kind("situation", claim.kind)!;
  const localId = crowdLocalId(keyId, claim.nonce);
  const effects: Effect[] = claim.effects ?? [];
  const derived =
    claim.severityLevel === undefined
      ? entry.deriveSeverity?.({ type: claim.type, subtype: claim.subtype, effects })
      : undefined;
  const severity =
    claim.severityLevel !== undefined
      ? {
          label: LABEL_OF_LEVEL[claim.severityLevel - 1],
          level: claim.severityLevel,
          source: "declared",
        }
      : derived !== undefined
        ? { label: derived, source: "derived" }
        : { label: "unknown" };
  return {
    id: formatRecordId({ class: "situation", namespace: ctx.instanceId, localId }),
    class: "situation",
    kind: claim.kind,
    type: claim.type,
    ...(claim.subtype === undefined ? {} : { subtype: claim.subtype }),
    temporality: "live",
    location: {
      geometry: claim.geometry,
      extent: extentOf(claim.geometry),
      geometryOrigin: "crowd_device",
      fuzziness: claim.fuzziness,
    },
    provenance: provenance(ctx, keyId, localId),
    freshness: { fetchedAt: ctx.now, expiresAt },
    planned: false,
    certainty: "observed",
    severity,
    ...(claim.text === undefined ? {} : { description: claim.text }),
    validity: { status: "active", start: claim.reportedAt },
    effects,
    details: claim.details ?? { kind: claim.kind, v: majorOf(entry.version) },
  };
}

function observationDraft(
  claim: ObservationClaim,
  keyId: string,
  ctx: LandingContext,
  expiresAt: string,
  reachMetres: number,
): { draft: Record<string, unknown> } | { issue: ValidationIssue } {
  let subject: Record<string, unknown>;
  let location: LocationRef;
  let reachFrom: LocationRef;
  // Reach measured to a location the draft does not carry (a restricted
  // source's) is refused without the distance, which would locate it.
  let reachHidden: boolean;
  if ("featureId" in claim.subject) {
    const { featureId, componentKey } = claim.subject;
    const resolved = ctx.resolveFeature?.(featureId, componentKey);
    if (resolved === undefined) {
      const component = componentKey === undefined ? "" : ` with component ${componentKey}`;
      return {
        issue: {
          path: ["subject"],
          code: "unknown_subject",
          message: `no feature ${featureId}${component}`,
        },
      };
    }
    subject = {
      kind: "feature",
      featureId: resolved.featureId,
      ...(resolved.componentKey === undefined ? {} : { componentKey: resolved.componentKey }),
    };
    location = resolved.location;
    reachFrom = resolved.reachFrom ?? location;
    reachHidden = resolved.reachFrom !== undefined;
  } else {
    subject = { kind: "location" };
    location = claim.subject.location;
    reachFrom = ctx.placeReachFrom ?? location;
    reachHidden = ctx.placeReachFrom !== undefined;
  }
  const [lon, lat] = claim.geometry.coordinates;
  const away =
    reachFrom.geometry === null
      ? undefined
      : distanceToGeometryMetres([lon, lat], reachFrom.geometry);
  if (away === undefined || away > reachMetres) {
    return {
      issue: {
        path: ["geometry"],
        code: "out_of_reach",
        message:
          away === undefined
            ? "the subject has no position to observe it at"
            : reachHidden
              ? `further than ${reachMetres} m from the subject`
              : `reported ${Math.round(away)} m from the subject, further than ${reachMetres} m`,
      },
    };
  }
  const localId = crowdLocalId(keyId, claim.nonce);
  const draft: Record<string, unknown> = {
    id: "",
    class: "observation",
    kind: "observation",
    property: claim.property,
    subject,
    ...(claim.qualifiers === undefined ? {} : { qualifiers: claim.qualifiers }),
    result: claim.result,
    phenomenonTime: { instant: claim.reportedAt },
    aggregation: "instantaneous",
    temporality: "live",
    location,
    provenance: provenance(ctx, keyId, localId),
    freshness: { fetchedAt: ctx.now, expiresAt },
  };
  draft["id"] = observationId(ctx.instanceId, draft as never);
  return { draft };
}

/**
 * Lands a verified claim as a crowd draft: a situation or an observation
 * whose provenance names the crowd, the reporter's key (stripped at every
 * egress) and the `crowd_pseudonym` privacy class. It first expires after the
 * kind's or property's crowd lifetime (`freshness.expiresAt`, never a content
 * field: confirmations extend it and negations shorten it, so its evidence
 * decides when it ends, not a revision). A claim is refused when the crowd
 * cannot report its kind or property, when it was reported further ahead of
 * the server clock than clocks drift, more than a day ago, or so long ago that
 * it had expired before it arrived. An observation claim about a feature
 * lands on the canonical feature `resolveFeature` names, so crowd rows sit
 * beside the fused row of every source, and only from a reporter who stood
 * within the property's reach of where it stands (`reachFrom`, else the
 * location it copies). Where the reporter stood is not kept: a reading takes
 * the location its lander gives it, which for a feature no public source
 * holds is the reporter's point coarsened to its area cell.
 */
export function landClaim(
  registry: Registry,
  report: { claim: unknown; keyId: string },
  ctx: LandingContext,
): Landing {
  const checked = validateClaim(registry, report.claim);
  if (!checked.ok) return checked;
  const claim: ReportClaim = checked.value;
  const rules = crowdRulesFor(
    registry,
    claim.claimClass === "situation"
      ? { class: "situation", kind: claim.kind, type: claim.type }
      : { class: "observation", property: claim.property },
  )!;
  const reportedMs = Date.parse(claim.reportedAt);
  const nowMs = Date.parse(ctx.now);
  if (reportedMs > nowMs + MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      issues: [
        {
          path: ["reportedAt"],
          code: "reported_in_future",
          message: "reported ahead of the server clock",
        },
      ],
    };
  }
  if (nowMs - reportedMs > MAX_REPORT_AGE_MS) {
    return {
      ok: false,
      issues: [
        {
          path: ["reportedAt"],
          code: "reported_too_long_ago",
          message:
            "a report uploaded more than a day after it was made is no longer an observation",
        },
      ],
    };
  }
  const expiresAt = addSeconds(claim.reportedAt, rules.ttlSec);
  if (Date.parse(expiresAt) <= nowMs) {
    return {
      ok: false,
      issues: [
        {
          path: ["reportedAt"],
          code: "expired_on_arrival",
          message: "the report's lifetime had ended before it arrived",
        },
      ],
    };
  }
  const built =
    claim.claimClass === "situation"
      ? { draft: situationDraft(registry, claim, report.keyId, ctx, expiresAt) }
      : observationDraft(claim, report.keyId, ctx, expiresAt, rules.reachMetres!);
  if ("issue" in built) return { ok: false, issues: [built.issue] };
  const valid = registry.validateDraft(built.draft);
  return valid.ok ? { ok: true, draft: valid.value, expiresAt } : valid;
}
