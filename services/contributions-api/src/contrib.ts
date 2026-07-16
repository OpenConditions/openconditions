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
export {
  ATTESTER_POLICY,
  assessEntitlement,
  type AttesterCtx,
  type DeviceProof,
  type Entitlement,
  type ReporterRow,
} from "./attester/policy.js";
export {
  createReportingGrant,
  resolveGrantSecret,
  verifyReportingGrant,
  type GrantVerification,
} from "./attester/grant.js";
export { enrollReporter } from "./attester/enroll.js";
export {
  UNVERIFIED_ATTESTATION,
  UNVERIFIED_OSM_AUTH,
  type AttestationVerifier,
  type AttestationClaim,
  type AttestationVerifierCtx,
  type AttestationVerificationResult,
  type OsmAuthVerifier,
  type OsmAuthVerifierCtx,
  type OsmAuthVerificationResult,
} from "./attester/verifier.js";
export {
  isValidContextPart,
  publicContextString,
  redemptionContext,
  reportEpoch,
  type PublicContext,
} from "./issuer/context.js";
export {
  DEFAULT_ISSUER_NAME,
  ensureIssuerKeys,
  generateIssuerKey,
  loadActiveIssuerKeys,
  type ActiveIssuerKey,
} from "./issuer/keys.js";
export { issueToken, type IssueResult, type IssueLogger } from "./issuer/issue.js";
export { TokenVerifier, type TokenVerifierOptions } from "./issuer/verify.js";
