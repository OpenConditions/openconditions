import { validateClaim } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { describe, expect, it } from "vitest";
import { canonicalClaimBytes, keyIdFromJwk, type ReportClaim } from "../index.js";

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

// A FIXED situation claim exercising a subtype, a severity level, an effect,
// non-ASCII text and nested objects and arrays.
const FIXED_CLAIM: ReportClaim = {
  claimClass: "situation",
  kind: "incident",
  type: "obstruction",
  subtype: "spill",
  geometry: { type: "Point", coordinates: [7.0982, 50.7374] },
  fuzziness: "exact",
  severityLevel: 3,
  effects: [
    {
      id: "lanes",
      kind: "lane_restriction",
      v: 1,
      vehicleImpact: "some_lanes_closed",
      lanesTotal: 2,
      lanesClosed: 1,
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
    },
  ],
  text: [{ lang: "de", text: "Fahrbahn verschmutzt — Öl" }],
  reportedAt: "2026-07-11T12:34:56.789Z",
  nonce: "conformance-nonce-0001",
};

// Pinned hex of canonicalClaimBytes(FIXED_CLAIM).
const PINNED_CLAIM_HEX =
  "7b22636c61696d436c617373223a22736974756174696f6e222c2265666665637473223a5b7b226170706c69636162696c697479223a7b226b696e64223a22616c6c227d2c22636f6d706c69616e6365223a226d616e6461746f7279222c226964223a226c616e6573222c226b696e64223a226c616e655f7265737472696374696f6e222c226c616e6573436c6f736564223a312c226c616e6573546f74616c223a322c226e6f726d616c697a6174696f6e223a22636f6d706c657465222c2276223a312c2276656869636c65496d70616374223a22736f6d655f6c616e65735f636c6f736564227d5d2c2266757a7a696e657373223a226578616374222c2267656f6d65747279223a7b22636f6f7264696e61746573223a5b372e303938322c35302e373337345d2c2274797065223a22506f696e74227d2c226b696e64223a22696e636964656e74222c226e6f6e6365223a22636f6e666f726d616e63652d6e6f6e63652d30303031222c227265706f727465644174223a22323032362d30372d31315431323a33343a35362e3738395a222c2273657665726974794c6576656c223a332c2273756274797065223a227370696c6c222c2274657874223a5b7b226c616e67223a226465222c2274657874223a22466168726261686e207665727363686d75747a7420e2809420c3966c227d5d2c2274797065223a226f62737472756374696f6e227d";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("cross-repo conformance with @openmapx/openconditions-contrib-client", () => {
  it("keyIdFromJwk matches the pinned RFC 7638 thumbprint", async () => {
    expect(await keyIdFromJwk(FIXED_PUBLIC_JWK)).toBe(PINNED_KEY_ID);
  });

  it("pins a claim the production registry accepts", () => {
    expect(validateClaim(productionRegistry(), FIXED_CLAIM)).toMatchObject({ ok: true });
  });

  it("canonicalClaimBytes matches the pinned RFC 8785 hex", () => {
    expect(toHex(canonicalClaimBytes(FIXED_CLAIM))).toBe(PINNED_CLAIM_HEX);
  });
});
