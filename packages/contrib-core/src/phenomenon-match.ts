import {
  centroid,
  haversineMeters,
  isoUtcEpochMs,
  type GeoJsonGeometry,
} from "@openconditions/core";

/**
 * A phenomenon-match candidate: a projection of a stored EVENT observation into
 * the fields the pure matcher decides on. Crowd candidates carry their
 * reporter's `keyId`; feed candidates carry only their `source` id. `direction`
 * is read from `attributes.direction` when present.
 */
export interface PhenomenonCandidate {
  id: string;
  domain: string;
  type: string;
  geometry: GeoJsonGeometry;
  validFrom?: string;
  attributes?: Record<string, unknown>;
  actor: { keyId?: string; source: string };
  status: string;
}

export interface MatchOptions {
  /** Maximum centroid-to-centroid great-circle distance in metres (default 250). */
  maxCentroidMeters?: number;
  /** Maximum absolute `validFrom` delta in seconds (default 900). */
  maxValidFromDeltaSec?: number;
}

export interface MatchDecision {
  candidateId: string;
  /** True only when every compatibility check passed (`reasons` is empty). */
  compatible: boolean;
  /** Every FAILED check, named; empty when compatible. */
  reasons: string[];
}

const DEFAULT_MAX_CENTROID_METERS = 250;
const DEFAULT_MAX_VALID_FROM_DELTA_SEC = 900;

function readDirection(attributes: Record<string, unknown> | undefined): string | undefined {
  const direction = attributes?.direction;
  return typeof direction === "string" ? direction : undefined;
}

/**
 * Decide, for each candidate, whether it is TYPE-COMPATIBLE with `target` — i.e.
 * whether the two may describe the same real-world phenomenon and so belong in
 * one candidate set. This is the pure, deterministic decision layer over the
 * fingerprint neighborhood: a fingerprint match only opens the candidate set, it
 * never merges. Every check is evaluated (no short-circuit) so `reasons` names
 * every failed check.
 *
 * All of the following must hold for `compatible`:
 * - same `domain` AND same `type` (canonical depth-2 type; subtype irrelevant);
 * - centroid distance ≤ `maxCentroidMeters` (haversine over vertex-mean centroids);
 * - both carry `validFrom` and the absolute delta ≤ `maxValidFromDeltaSec`;
 * - direction agrees, or is absent on at least one side;
 * - the two are independent actors — not the same crowd `keyId`, not the same
 *   feed `source`;
 * - the candidate's `status` is `"active"`;
 * - the candidate is not the target itself.
 */
export function matchPhenomenonCandidates(
  target: PhenomenonCandidate,
  candidates: PhenomenonCandidate[],
  opts: MatchOptions = {}
): MatchDecision[] {
  const maxCentroidMeters = opts.maxCentroidMeters ?? DEFAULT_MAX_CENTROID_METERS;
  const maxValidFromDeltaSec = opts.maxValidFromDeltaSec ?? DEFAULT_MAX_VALID_FROM_DELTA_SEC;
  const targetCentroid = centroid(target.geometry);
  const targetDirection = readDirection(target.attributes);
  // Same ISO-shape + UTC-pinning rule as core's timeBucket (shared helper, not
  // duplicated): a legacy/locale-shaped or unparseable validFrom is a named
  // incompatibility, never a host-timezone-dependent Date.parse fallback.
  const targetValidFromMs =
    target.validFrom === undefined ? undefined : isoUtcEpochMs(target.validFrom);

  return candidates.map((candidate) => {
    const reasons: string[] = [];

    if (candidate.id === target.id) {
      reasons.push("self-match");
    }
    if (candidate.domain !== target.domain) {
      reasons.push("domain-mismatch");
    }
    if (candidate.type !== target.type) {
      reasons.push("type-mismatch");
    }
    if (candidate.status !== "active") {
      reasons.push("candidate-inactive");
    }

    const distance = haversineMeters(targetCentroid, centroid(candidate.geometry));
    if (!(distance <= maxCentroidMeters)) {
      reasons.push("centroid-distance-exceeds-max");
    }

    if (targetValidFromMs === undefined || candidate.validFrom === undefined) {
      reasons.push("valid-from-missing");
    } else {
      const candidateValidFromMs = isoUtcEpochMs(candidate.validFrom);
      if (!Number.isFinite(targetValidFromMs) || !Number.isFinite(candidateValidFromMs)) {
        reasons.push("valid-from-invalid");
      } else if (Math.abs(targetValidFromMs - candidateValidFromMs) / 1000 > maxValidFromDeltaSec) {
        reasons.push("valid-from-delta-exceeds-max");
      }
    }

    const candidateDirection = readDirection(candidate.attributes);
    if (
      targetDirection !== undefined &&
      candidateDirection !== undefined &&
      targetDirection !== candidateDirection
    ) {
      reasons.push("direction-mismatch");
    }

    // Independence: two crowd reports from the same device key, or two feed rows
    // from the same source, are NOT independent witnesses. A crowd/feed pair is
    // always independent even when their source strings coincide.
    const bothCrowd = target.actor.keyId !== undefined && candidate.actor.keyId !== undefined;
    const bothFeed = target.actor.keyId === undefined && candidate.actor.keyId === undefined;
    if (bothCrowd && target.actor.keyId === candidate.actor.keyId) {
      reasons.push("same-reporter-key");
    } else if (bothFeed && target.actor.source === candidate.actor.source) {
      reasons.push("same-source");
    }

    return { candidateId: candidate.id, compatible: reasons.length === 0, reasons };
  });
}
