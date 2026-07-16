import {
  centroid,
  haversineMeters,
  isoUtcEpochMs,
  type GeoJsonGeometry,
} from "@openconditions/core";

/**
 * A phenomenon-match candidate: a projection of a stored EVENT observation into
 * the fields the pure matcher decides on. `kind` is the row's REAL
 * `origin.kind` — crowd or feed — and it, not the presence of a reporter
 * `keyId`, decides witness independence: a federated crowd row is keyId-less
 * (reporter stripped on export) yet is still `kind: "crowd"`. Crowd candidates
 * additionally carry their reporter's `keyId` when they have one (local crowd
 * rows do; federated crowd rows do not); feed candidates carry only their
 * `source` id. `direction` is read from `attributes.direction` when present.
 */
export interface PhenomenonCandidate {
  id: string;
  domain: string;
  type: string;
  geometry: GeoJsonGeometry;
  validFrom?: string;
  attributes?: Record<string, unknown>;
  actor: { kind: "crowd" | "feed"; keyId?: string; source: string };
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
 * - the two are independent actors (keyed on `actor.kind`) — not two crowd
 *   reports carrying the same defined reporter `keyId`, not two feeds of the same
 *   `source`; a crowd/feed pair, and two keyId-less crowd rows, are independent;
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

    // Independence keys on the REAL actor `kind` (origin.kind), never on whether
    // a reporter `keyId` is present. Two crowd reports from the SAME reporter key,
    // or two feed rows from the same source, are NOT independent witnesses. A
    // crowd/feed pair is always independent — even when their source strings
    // coincide (a federated crowd row can carry the same `source` as a local feed).
    // Two keyId-less crowd rows are DISTINCT reporters (federation strips the
    // reporter), so same-reporter-key requires a DEFINED, equal keyId on both.
    const bothCrowd = target.actor.kind === "crowd" && candidate.actor.kind === "crowd";
    const bothFeed = target.actor.kind === "feed" && candidate.actor.kind === "feed";
    if (
      bothCrowd &&
      target.actor.keyId !== undefined &&
      target.actor.keyId === candidate.actor.keyId
    ) {
      reasons.push("same-reporter-key");
    } else if (bothFeed && target.actor.source === candidate.actor.source) {
      reasons.push("same-source");
    }

    return { candidateId: candidate.id, compatible: reasons.length === 0, reasons };
  });
}
