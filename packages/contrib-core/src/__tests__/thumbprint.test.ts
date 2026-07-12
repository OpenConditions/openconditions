import { describe, expect, it } from "vitest";
import { keyIdFromJwk } from "../index.js";

// RFC 7638 section 3.1 published example (RSA). Cast because the example
// carries "kid", which Node's JsonWebKey type does not declare.
const RFC7638_RSA_JWK = {
  kty: "RSA",
  n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  e: "AQAB",
  alg: "RS256",
  kid: "2011-04-29",
} as JsonWebKey;
const RFC7638_RSA_THUMBPRINT = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";

// P-256 vector: the public half of the RFC 7515 appendix A.3 EC key; the
// thumbprint was computed once from {crv,kty,x,y} JCS bytes and hard-coded.
const P256_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};
const P256_THUMBPRINT = "oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U";

describe("keyIdFromJwk (RFC 7638)", () => {
  it("reproduces the RFC 7638 section 3.1 RSA thumbprint", async () => {
    await expect(keyIdFromJwk(RFC7638_RSA_JWK)).resolves.toBe(RFC7638_RSA_THUMBPRINT);
  });

  it("reproduces the pinned P-256 thumbprint", async () => {
    await expect(keyIdFromJwk(P256_JWK)).resolves.toBe(P256_THUMBPRINT);
  });

  it("hashes the required members only: extra JWK members leave the thumbprint unchanged", async () => {
    const decorated: JsonWebKey = {
      ...P256_JWK,
      alg: "ES256",
      ext: true,
      key_ops: ["verify"],
      use: "sig",
    };
    await expect(keyIdFromJwk(decorated)).resolves.toBe(P256_THUMBPRINT);
  });

  it("is insensitive to JWK member order", async () => {
    const reordered = JSON.parse(
      `{"y":"${P256_JWK.y}","x":"${P256_JWK.x}","crv":"P-256","kty":"EC"}`
    ) as JsonWebKey;
    await expect(keyIdFromJwk(reordered)).resolves.toBe(P256_THUMBPRINT);
  });

  it("rejects a JWK missing a required member", async () => {
    const { y: _y, ...missingY } = P256_JWK;
    await expect(keyIdFromJwk(missingY)).rejects.toThrow(TypeError);
    await expect(keyIdFromJwk({} as JsonWebKey)).rejects.toThrow(TypeError);
  });

  it("rejects an unknown kty", async () => {
    await expect(keyIdFromJwk({ kty: "XYZ" } as JsonWebKey)).rejects.toThrow(TypeError);
  });
});
