import type { Observation } from "@openconditions/core";
import type { SignedReport } from "./types.js";

/**
 * The trusted, server-side context a landing needs that the untrusted report
 * itself must never supply: this instance's id, the server clock, and the
 * commons attribution (source URI + license) this instance publishes under.
 */
export interface LandingContext {
  instanceId: string;
  now: string;
  sourceUri: string;
  sourceLicense: string;
}

/**
 * A crowd report mapped to an Observation, before the central normalize seam
 * stamps provenance. Extends {@link Observation} with the event-shaped fields a
 * report carries (`type`, `severityLevel`) and the free-form `attributes` blob;
 * everything the seam owns (privacyClass/canonicalId/phenomenonFingerprint/
 * instanceId/evidenceState/confidenceScore) is deliberately absent.
 */
export interface CrowdLandingObservation extends Observation {
  kind: "event";
  type: string;
  severityLevel?: 1 | 2 | 3 | 4 | 5;
  attributes?: Record<string, unknown>;
}

/**
 * Map a verified signed report to a landing Observation. PURE: no clocks, no
 * I/O — the server clock and instance identity arrive via {@link LandingContext}.
 *
 * This is a TRUST-BOUNDARY mapping. The report's claim supplies only the
 * content axis (domain/type/geometry/subject/severityLevel/attributes/
 * fuzziness); everything provenance- or privacy-bearing is derived here from the
 * trusted context or left for the central `normalizeObservation` seam to stamp.
 * The `origin` is kept minimal: it names the reporter's key but carries NO
 * signature or reputation — the authoritative signature lives in the
 * `report_evidence` ledger and reputation in the `reporter` table.
 */
export function reportToObservation(
  report: SignedReport,
  ctx: LandingContext
): CrowdLandingObservation {
  const { claim } = report;
  const obs: CrowdLandingObservation = {
    id: `crowd:${report.keyId}:${claim.nonce}`,
    source: "crowd",
    sourceFormat: "crowd",
    domain: claim.domain,
    kind: "event",
    type: claim.type,
    geometry: claim.geometry,
    status: "active",
    fuzziness: claim.fuzziness,
    validFrom: claim.reportedAt,
    origin: {
      kind: "crowd",
      attribution: {
        provider: ctx.instanceId,
        license: ctx.sourceLicense,
        url: ctx.sourceUri,
      },
      reporter: { keyId: report.keyId },
    },
    dataUpdatedAt: claim.reportedAt,
    fetchedAt: ctx.now,
    isStale: false,
    sourceUri: ctx.sourceUri,
    sourceLicense: ctx.sourceLicense,
  };
  if (claim.subject !== undefined) obs.subject = claim.subject;
  if (claim.severityLevel !== undefined) obs.severityLevel = claim.severityLevel;
  if (claim.attributes !== undefined) obs.attributes = claim.attributes;
  return obs;
}
