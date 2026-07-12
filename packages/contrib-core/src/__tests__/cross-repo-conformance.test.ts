import { describe, expect, it } from "vitest";
import { canonicalClaimBytes, keyIdFromJwk } from "../index.js";
import type { ReportClaim } from "../types.js";

// Cross-repo parity anchor. These EXACT pins are also asserted by the OpenMapX
// client mirror @openmapx/openconditions-contrib-client in
// packages/openconditions-contrib-client/src/conformance.test.ts. The two
// implementations are independent; if either side's canonicalization or RFC 7638
// thumbprint drifts, one of the two suites fails. Keep the pins identical.

// A FIXED P-256 public JWK (thumbprint members only).
const FIXED_PUBLIC_JWK: JsonWebKey = {
  crv: "P-256",
  kty: "EC",
  x: "BFxqp9dVKtDIkpHcFM5eHXlrV0Q1UJUGGOdUvsXQYLQ",
  y: "LB2daYNRhrfJ41l6-JVcUBiXFH5V4n9yU-LzHvHMkns",
};

// Pinned RFC 7638 base64url thumbprint of FIXED_PUBLIC_JWK.
const PINNED_KEY_ID = "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY";

// A FIXED ReportClaim exercising every optional field, non-ASCII text, and a
// nested attributes object.
const FIXED_CLAIM: ReportClaim = {
  domain: "roads",
  type: "hazard_object",
  geometry: { type: "Point", coordinates: [7.0982, 50.7374] },
  fuzziness: "exact",
  subject: [{ type: "osm", id: "way/23368509" }],
  severityLevel: 3,
  attributes: { note: "Fahrbahn verschmutzt — Öl", laneCount: 2 },
  reportedAt: "2026-07-11T12:34:56.789Z",
  nonce: "conformance-nonce-0001",
};

// Pinned hex of canonicalClaimBytes(FIXED_CLAIM).
const PINNED_CLAIM_HEX =
  "7b2261747472696275746573223a7b226c616e65436f756e74223a322c226e6f7465223a22466168726261686e207665727363686d75747a7420e2809420c3966c227d2c22646f6d61696e223a22726f616473222c2266757a7a696e657373223a226578616374222c2267656f6d65747279223a7b22636f6f7264696e61746573223a5b372e303938322c35302e373337345d2c2274797065223a22506f696e74227d2c226e6f6e6365223a22636f6e666f726d616e63652d6e6f6e63652d30303031222c227265706f727465644174223a22323032362d30372d31315431323a33343a35362e3738395a222c2273657665726974794c6576656c223a332c227375626a656374223a5b7b226964223a227761792f3233333638353039222c2274797065223a226f736d227d5d2c2274797065223a2268617a6172645f6f626a656374227d";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("cross-repo conformance with @openmapx/openconditions-contrib-client", () => {
  it("keyIdFromJwk matches the pinned RFC 7638 thumbprint", async () => {
    expect(await keyIdFromJwk(FIXED_PUBLIC_JWK)).toBe(PINNED_KEY_ID);
  });

  it("canonicalClaimBytes matches the pinned RFC 8785 hex", () => {
    expect(toHex(canonicalClaimBytes(FIXED_CLAIM))).toBe(PINNED_CLAIM_HEX);
  });
});
