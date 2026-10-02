import type { ReportClaim, SubClaimBody } from "@openconditions/model";

export type {
  ObservationClaim,
  RecordRef,
  ReportClaim,
  SituationClaim,
  SubClaimBody,
} from "@openconditions/model";

/**
 * A report claim plus its detached signature envelope. The envelope fields
 * (`alg`, `keyId`, `pubJwk`, `signature`) are NOT covered by the signature;
 * `keyId` is bound instead by the RFC 7638 thumbprint check at verification.
 */
export interface SignedReport {
  alg: "ES256";
  /** base64url RFC 7638 JWK SHA-256 thumbprint of the P-256 public key. */
  keyId: string;
  /** Present on first submission; the server caches it thereafter. */
  pubJwk?: JsonWebKey;
  claim: ReportClaim;
  /** base64url raw r||s (64 bytes) ES256 over `canonicalize(claim)` bytes. */
  signature: string;
}

export type SubClaimType = SubClaimBody["claimType"];

/** A sub-claim body plus its envelope; the signature covers the body alone. */
export type SignedSubClaim = SubClaimBody & {
  alg: "ES256";
  keyId: string;
  pubJwk?: JsonWebKey;
  /** Over `canonicalize(SubClaimBody)` — the body WITHOUT alg/keyId/pubJwk/signature. */
  signature: string;
};

/** Result of a signature verification; `error` names the first failed check. */
export interface VerifyResult {
  ok: boolean;
  keyId?: string;
  error?: string;
}
