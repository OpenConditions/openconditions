# @openconditions/contrib-core

The signed, portable crowd report and sub-claim format for OpenConditions:
detached ES256 signatures over RFC 8785 (JCS) canonical bytes, with reporter
identities named by RFC 7638 JWK thumbprints. The claims are the model's
(`@openconditions/model`): a reporter signs a situation it sees or a reading it
takes, and reacts to any stored record.

The package is pure and isomorphic: platform WebCrypto
(`globalThis.crypto.subtle`) plus the pinned `canonicalize` JCS reference
implementation, no I/O, no `node:` imports — the same code runs in browsers
and Node 24+.

## Wire contract

- `ReportClaim` — the signable report content, a `SituationClaim`
  (`claimClass: "situation"`, `kind`, `type`, `subtype?`, `geometry`,
  `fuzziness`, `severityLevel?`, `effects?`, `details?`, `text?`, `reportedAt`,
  `nonce`) or an `ObservationClaim` (`claimClass: "observation"`, the subject,
  `property`, `qualifiers?`, `result`, the reporter's position, `reportedAt`,
  `nonce`). The ES256 signature covers exactly `canonicalize(claim)` (RFC 8785)
  encoded as UTF-8.
- `SignedReport` — claim + detached envelope (`alg: "ES256"`, `keyId`,
  optional `pubJwk`, `signature` as base64url raw 64-byte `r||s`). `pubJwk`
  is embedded on first submission; servers cache it and verify subsequent
  envelopes against the cached key (`knownJwk` takes precedence and must
  match any embedded key).
- `SubClaimBody` / `SignedSubClaim` — confirm/negate/flag reactions to a
  stored record, named by its `RecordRef` (`{class, id, componentKey?}`). The
  signature covers only the body, never the envelope fields; the `keyId` is
  bound instead by the RFC 7638 thumbprint check at verification.

`signReport(registry, claim, key)` and `verifyReport(registry, report,
knownJwk?)` validate the claim against the registry the caller runs
(`validateClaim`): a kind the crowd may report, a registered type and subtype,
the kernel's effects and the kind's details. Sub-claims need no registry. On
top of the schema, hard rules enforced at signing and verification: I-JSON
claims only (finite numbers, well-formed Unicode, nesting capped at 64 levels)
and a 64 KiB cap on canonical bytes.

The package also carries the crowd evidence policy (`EVIDENCE_POLICY_DEFAULTS`,
`crowdEvidencePolicy(rules)`: presentation scores and the asymmetric
peer-confirmation constants, with lifetimes and quorums from the registry's
crowd rules), the evidence ledger projection (`evidenceRowsToLedger`), the
geometry screen (`checkGeometryPlausibility`) and the kinematic check
(`isKinematicallyPlausible`).

## Signature canonicality (low-S)

ECDSA is malleable: for any valid signature `(r, s)`, the twin `(r, n − s)`
verifies too, so an observer could mint a second, equally valid signature for
the same claim. This package therefore enforces the canonical low-S form
(COSE/BIP-62 style): signing normalizes `s` to `min(s, n − s)`, and
verification rejects any signature with `s = 0`, `s > n/2`, `r = 0`, or
`r ≥ n` with a "non-canonical signature" error — third-party variant-minting
is impossible. ECDSA signing is still randomized: RE-SIGNING the same claim
with the same key yields a different (equally valid) signature, so record
identity keys on the claim (the hash of the key and the nonce), never on the
signature.

## Key loss is by design

`generateReporterKey()` creates the P-256 private key **non-extractable**:
it can be used to sign but can never be exported, backed up, or synced. A
reporter identity therefore lives and dies with the device keystore that
holds it — losing the device (or clearing browser storage) loses the
identity, and there is deliberately no recovery path. This is the privacy
posture for pseudonymous crowd reporting: nothing exists that could link or
restore a reporter identity after the key is gone.

`generateReporterKey({ extractable: true })` is the opt-in seam for a future
encrypted-backup/export flow; the backup implementation itself is not part of
this package yet.
