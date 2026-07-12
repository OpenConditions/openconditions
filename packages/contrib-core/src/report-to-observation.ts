import type { Observation } from "@openconditions/core";
import { toBase64Url } from "./base64url.js";
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
 * Model-owned keys a reporter must never be able to set through the free-form
 * `attributes` bag. `readObservations` spreads `attributes` LAST over the
 * reconstructed row, so an un-scrubbed bag would let a crowd claim forge trusted
 * provenance/identity/privacy fields (origin, privacyClass, sourceLicense, id,
 * …). These are stripped at the trust boundary so the bag can only carry genuine
 * extras; the dedicated claim fields (severityLevel, fuzziness) remain the only
 * path for those values.
 */
const RESERVED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "canonicalId",
  "phenomenonFingerprint",
  "origin",
  "privacyClass",
  "instanceId",
  "sourceLicense",
  "sourceUri",
  "evidenceState",
  "routingEligible",
  "confidenceScore",
  "kAnonymity",
  "dpEpsilon",
  "dpDelta",
  "severityLevel",
  "fuzziness",
]);

function stripReservedAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!RESERVED_ATTRIBUTE_KEYS.has(key)) clean[key] = value;
  }
  return clean;
}

/**
 * The de-identified observation id for a crowd report: `crowd:` + the base64url
 * SHA-256 of `keyId:nonce`. Deterministic (idempotent replay of the same
 * key+nonce yields the same id, preserving `ON CONFLICT (id) DO NOTHING`),
 * unique per (key, nonce), collision-resistant, and — crucially — NOT reversible
 * to the reporter's `keyId`. The raw `keyId` never appears in the id, so it can
 * no longer leak through the public `id` column of any projection. The
 * key→observation linkage is preserved server-side in `origin.reporter` and the
 * `report_evidence` ledger for corroboration/reputation. The `crowd:` prefix is
 * retained so downstream crowd-origin detection is unaffected.
 */
export async function crowdObservationId(keyId: string, nonce: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${keyId}:${nonce}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `crowd:${toBase64Url(new Uint8Array(digest))}`;
}

/**
 * Map a verified signed report to a landing Observation. Deterministic and free
 * of I/O — the server clock and instance identity arrive via
 * {@link LandingContext}; the only async is the SHA-256 that de-identifies the
 * id (see {@link crowdObservationId}).
 *
 * This is a TRUST-BOUNDARY mapping. The report's claim supplies only the
 * content axis (domain/type/geometry/subject/severityLevel/fuzziness), plus a
 * scrubbed `attributes` bag with every model-owned key removed; everything
 * provenance- or privacy-bearing is derived here from the trusted context or
 * left for the central `normalizeObservation` seam to stamp. The `origin` is
 * kept minimal: it names the reporter's key but carries NO signature or
 * reputation — the authoritative signature lives in the `report_evidence`
 * ledger and reputation in the `reporter` table.
 */
export async function reportToObservation(
  report: SignedReport,
  ctx: LandingContext
): Promise<CrowdLandingObservation> {
  const { claim } = report;
  const obs: CrowdLandingObservation = {
    id: await crowdObservationId(report.keyId, claim.nonce),
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
  if (claim.attributes !== undefined) obs.attributes = stripReservedAttributes(claim.attributes);
  return obs;
}
