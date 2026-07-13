import { describe, expect, it } from "vitest";
import { httpbis } from "http-message-signatures";

/**
 * Conformance gate against the official RFC 9421 test vectors.
 *
 * Everything pinned below is transcribed byte-for-byte from the RFC text
 * (https://www.rfc-editor.org/rfc/rfc9421.txt, RFC 8792 line-wrapping
 * unfolded): the §B.1.4 test-key-ed25519 keypair, the §B.2 test-request
 * message, and the §B.2.6 "Signing a Request Using ed25519" example — its
 * exact signature base, Signature-Input, and Signature field values. Ed25519
 * is deterministic (RFC 8032), so the signature must match exactly. If the
 * library's signature base for these inputs ever diverges, that is a real
 * canonicalization regression — fix the component configuration, never the
 * pinned vectors.
 */

const ED25519 = { name: "Ed25519" } as const;

/** RFC 9421 §B.1.4 — test-key-ed25519 private key (PKCS#8 PEM body). */
const TEST_KEY_ED25519_PKCS8_B64 =
  "MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF";

/** RFC 9421 §B.1.4 — test-key-ed25519 public key (SPKI PEM body). */
const TEST_KEY_ED25519_SPKI_B64 = "MCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=";

/** RFC 9421 §B.2 — the test-request message. */
const TEST_REQUEST = {
  method: "POST",
  url: "https://example.com/foo?param=Value&Pet=dog",
  headers: {
    Host: "example.com",
    Date: "Tue, 20 Apr 2021 02:07:55 GMT",
    "Content-Type": "application/json",
    "Content-Digest":
      "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
    "Content-Length": "18",
  },
} as const;

/** RFC 9421 §B.2.6 — covered components, in the RFC's order. */
const B26_FIELDS = ["date", "@method", "@path", "@authority", "content-type", "content-length"];

const B26_CREATED = 1618884473;
const B26_KEYID = "test-key-ed25519";

/** RFC 9421 §B.2.6 — the exact published signature base. */
const B26_SIGNATURE_BASE = [
  '"date": Tue, 20 Apr 2021 02:07:55 GMT',
  '"@method": POST',
  '"@path": /foo',
  '"@authority": example.com',
  '"content-type": application/json',
  '"content-length": 18',
  '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length")' +
    ';created=1618884473;keyid="test-key-ed25519"',
].join("\n");

/** RFC 9421 §B.2.6 — the exact published Signature-Input field value. */
const B26_SIGNATURE_INPUT =
  'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length")' +
  ';created=1618884473;keyid="test-key-ed25519"';

/** RFC 9421 §B.2.6 — the exact published Signature field value. */
const B26_SIGNATURE =
  "sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:";

async function importTestPrivateKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(Buffer.from(TEST_KEY_ED25519_PKCS8_B64, "base64")) as BufferSource,
    ED25519,
    false,
    ["sign"]
  );
}

async function importTestPublicKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "spki",
    Uint8Array.from(Buffer.from(TEST_KEY_ED25519_SPKI_B64, "base64")) as BufferSource,
    ED25519,
    false,
    ["verify"]
  );
}

/** Signs §B.2.6 with the RFC test key, capturing the exact base handed to the signer. */
async function signB26(): Promise<{ base: Buffer; headers: Record<string, string | string[]> }> {
  const privateKey = await importTestPrivateKey();
  let capturedBase: Buffer | null = null;
  const signed = await httpbis.signMessage(
    {
      key: {
        id: B26_KEYID,
        sign: async (data: Buffer) => {
          capturedBase = data;
          return Buffer.from(
            await globalThis.crypto.subtle.sign(ED25519, privateKey, new Uint8Array(data))
          );
        },
      },
      name: "sig-b26",
      fields: [...B26_FIELDS],
      params: ["created", "keyid"],
      paramValues: { created: new Date(B26_CREATED * 1000) },
    },
    { ...TEST_REQUEST, headers: { ...TEST_REQUEST.headers } }
  );
  if (capturedBase === null) throw new Error("signer was never invoked");
  return { base: capturedBase, headers: signed.headers };
}

describe("RFC 9421 §B.2.6 Ed25519 conformance", () => {
  it("constructs the RFC's signature base byte-for-byte", async () => {
    const { base } = await signB26();
    expect(base.equals(Buffer.from(B26_SIGNATURE_BASE, "utf8"))).toBe(true);
    expect(base.toString("utf8")).toBe(B26_SIGNATURE_BASE);
  });

  it("emits the RFC's exact Signature-Input and Signature headers (deterministic Ed25519)", async () => {
    const { headers } = await signB26();
    expect(headers["Signature-Input"]).toBe(B26_SIGNATURE_INPUT);
    expect(headers["Signature"]).toBe(B26_SIGNATURE);
  });

  it("verifies the RFC's published signature with the RFC's public key", async () => {
    const publicKey = await importTestPublicKey();
    const result = await httpbis.verifyMessage(
      {
        keyLookup: async (params) =>
          params.keyid === B26_KEYID
            ? {
                id: B26_KEYID,
                algs: ["ed25519"],
                verify: async (data: Buffer, signature: Buffer) =>
                  globalThis.crypto.subtle.verify(
                    ED25519,
                    publicKey,
                    new Uint8Array(signature),
                    new Uint8Array(data)
                  ),
              }
            : null,
      },
      {
        ...TEST_REQUEST,
        headers: {
          ...TEST_REQUEST.headers,
          "Signature-Input": B26_SIGNATURE_INPUT,
          Signature: B26_SIGNATURE,
        },
      }
    );
    expect(result).toBe(true);
  });

  it("rejects the published signature when a covered component is tampered with", async () => {
    const publicKey = await importTestPublicKey();
    const result = await httpbis.verifyMessage(
      {
        keyLookup: async () => ({
          id: B26_KEYID,
          algs: ["ed25519"],
          verify: async (data: Buffer, signature: Buffer) =>
            globalThis.crypto.subtle.verify(
              ED25519,
              publicKey,
              new Uint8Array(signature),
              new Uint8Array(data)
            ),
        }),
      },
      {
        ...TEST_REQUEST,
        headers: {
          ...TEST_REQUEST.headers,
          Date: "Tue, 20 Apr 2021 02:07:56 GMT",
          "Signature-Input": B26_SIGNATURE_INPUT,
          Signature: B26_SIGNATURE,
        },
      }
    );
    expect(result).toBe(false);
  });
});
