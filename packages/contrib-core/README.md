# @openconditions/contrib-core

The signed, portable crowd report and sub-claim format for OpenConditions:
detached ES256 signatures over RFC 8785 (JCS) canonical bytes, with reporter
identities named by RFC 7638 JWK thumbprints.

The package is pure and isomorphic: platform WebCrypto
(`globalThis.crypto.subtle`) plus the pinned `canonicalize` JCS reference
implementation, no I/O, no `node:` imports — the same code runs in browsers
(the OpenMapX SDK) and Node 24+.

## Wire contract

- `ReportClaim` — the signable report content. The ES256 signature covers
  exactly `canonicalize(claim)` (RFC 8785) encoded as UTF-8.
- `SignedReport` — claim + detached envelope (`alg: "ES256"`, `keyId`,
  optional `pubJwk`, `signature` as base64url raw 64-byte `r||s`). `pubJwk`
  is embedded on first submission; servers cache it and verify subsequent
  envelopes against the cached key (`knownJwk` takes precedence and must
  match any embedded key).
- `SubClaimBody` / `SignedSubClaim` — confirm/negate/flag reactions. The
  signature covers only the body, never the envelope fields; the `keyId` is
  bound instead by the RFC 7638 thumbprint check at verification.
- `maresiUri(report)` — `urn:openconditions:report:<signature>`, the subject
  a sub-claim references.

Hard rules enforced at signing and verification: I-JSON claims only (finite
numbers, well-formed Unicode, nesting capped at 64 levels), `nonce` of 16..64
`[A-Za-z0-9_-]` chars, `reportedAt` as an ISO-8601 instant with a zone
designator and a real (non-rolled) calendar date, and a 64 KiB cap on
canonical bytes.

## Signature canonicality (low-S)

ECDSA is malleable: for any valid signature `(r, s)`, the twin `(r, n − s)`
verifies too. Because `maresiUri` identifies a signed **artifact** by its
signature bytes, an observer could otherwise mint a second, equally valid URI
for the same report. This package therefore enforces the canonical low-S form
(COSE/BIP-62 style): signing normalizes `s` to `min(s, n − s)`, and
verification rejects any signature with `s = 0`, `s > n/2`, `r = 0`, or
`r ≥ n` with a "non-canonical signature" error — third-party variant-minting
is impossible. Note that ECDSA signing is still randomized: RE-SIGNING the
same claim with the same key yields a different (equally valid) artifact, so
record-level dedup must key on the claim's identity (e.g. its canonical
bytes/nonce), never on the signature.

## Boundary: authenticity, not semantics

This package is an **authenticity layer**: it proves who signed what and that
the bytes were not altered. Claim geometry is only type-checked as a GeoJSON
geometry shape — coordinates are not range-checked, wound, deduped, or
otherwise validated. Consumers must validate GeoJSON coordinates and domain
semantics (WGS84 bounds, taxonomy fit, plausibility) before acting on a
verified claim.

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
