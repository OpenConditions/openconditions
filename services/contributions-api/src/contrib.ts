/**
 * Narrow public subpath for the Privacy Pass contribution-admission layer
 * (enrollment, per-epoch quota, blind-signed token issuance, single-use
 * redemption with domain-separated context binding).
 *
 * It re-exports ONLY the token layer — never the Fastify server or the
 * evidence/reviewer surface — so a consumer can reuse the shipped admission
 * crypto without pulling the whole service in. The probe feasibility spike
 * imports these to bind an admitted token to a VDAF report without rebuilding
 * the Privacy Pass exchange.
 */

export { enrollReporter } from "./attester/enroll.js";
export {
  createReportingGrant,
  type GrantVerification,
  resolveGrantSecret,
  verifyReportingGrant,
} from "./attester/grant.js";
export {
  ATTESTER_POLICY,
  type AttesterCtx,
  assessEntitlement,
  type DeviceProof,
  type Entitlement,
  type ReporterRow,
} from "./attester/policy.js";
export {
  type AttestationClaim,
  type AttestationVerificationResult,
  type AttestationVerifier,
  type AttestationVerifierCtx,
  type OsmAuthVerificationResult,
  type OsmAuthVerifier,
  type OsmAuthVerifierCtx,
  UNVERIFIED_ATTESTATION,
  UNVERIFIED_OSM_AUTH,
} from "./attester/verifier.js";
export {
  isValidContextPart,
  type PublicContext,
  publicContextString,
  redemptionContext,
  reportEpoch,
} from "./issuer/context.js";
export { type IssueLogger, type IssueResult, issueToken } from "./issuer/issue.js";
export {
  type ActiveIssuerKey,
  DEFAULT_ISSUER_NAME,
  ensureIssuerKeys,
  generateIssuerKey,
  loadActiveIssuerKeys,
} from "./issuer/keys.js";
export { TokenVerifier, type TokenVerifierOptions } from "./issuer/verify.js";
