import { createPrivateKey, sign as edSign } from "node:crypto";
import { httpbis } from "http-message-signatures";
import { describe, expect, it } from "vitest";
import { InMemoryNonceStore, signMessage, verifyMessage } from "../http-signature.js";

/**
 * Conformance gate against the official RFC 9421 test vectors.
 *
 * Everything pinned below is transcribed byte-for-byte from the RFC text
 * (https://www.rfc-editor.org/rfc/rfc9421.txt, RFC 8792 line-wrapping
 * unfolded): the §B.1 test keys, the §B.2 test-request and test-response
 * messages, the §B.2.1–B.2.6 test cases (exact signature bases, Signature-Input
 * and Signature field values) and the §2.2.2 and §2.3 serialization examples.
 * Ed25519 and HMAC are deterministic, so those signatures must match exactly;
 * the randomized RSA-PSS and ECDSA signatures are verified. If the
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
    ["sign"],
  );
}

async function importTestPublicKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "spki",
    Uint8Array.from(Buffer.from(TEST_KEY_ED25519_SPKI_B64, "base64")) as BufferSource,
    ED25519,
    false,
    ["verify"],
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
            await globalThis.crypto.subtle.sign(ED25519, privateKey, new Uint8Array(data)),
          );
        },
      },
      name: "sig-b26",
      fields: [...B26_FIELDS],
      params: ["created", "keyid"],
      paramValues: { created: new Date(B26_CREATED * 1000) },
    },
    { ...TEST_REQUEST, headers: { ...TEST_REQUEST.headers } },
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
                    new Uint8Array(data),
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
      },
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
              new Uint8Array(data),
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
      },
    );
    expect(result).toBe(false);
  });
});

/** RFC 9421 §B.2 — the test-response message. */
const TEST_RESPONSE = {
  status: 200,
  headers: {
    Date: "Tue, 20 Apr 2021 02:07:56 GMT",
    "Content-Type": "application/json",
    "Content-Digest":
      "sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:",
    "Content-Length": "23",
  },
} as const;

/** RFC 9421 §B.1.2 — test-key-rsa-pss public key (SPKI PEM body). */
const TEST_KEY_RSA_PSS_SPKI_B64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr4tmm3r20Wd/PbqvP1s2" +
  "+QEtvpuRaV8Yq40gjUR8y2Rjxa6dpG2GXHbPfvMs8ct+Lh1GH45x28Rw3Ry53mm+" +
  "oAXjyQ86OnDkZ5N8lYbggD4O3w6M6pAvLkhk95AndTrifbIFPNU8PPMO7OyrFAHq" +
  "gDsznjPFmTOtCEcN2Z1FpWgchwuYLPL+Wokqltd11nqqzi+bJ9cvSKADYdUAAN5W" +
  "Utzdpiy6LbTgSxP7ociU4Tn0g5I6aDZJ7A8Lzo0KSyZYoA485mqcO0GVAdVw9lq4" +
  "aOT9v6d+nb4bnNkQVklLQ3fVAvJm+xdDOp9LCNCN48V2pnDOkFV6+U9nV5oyc6XI" +
  "2wIDAQAB";

/** RFC 9421 §B.1.3 — test-key-ecc-p256 (JWK). */
const TEST_KEY_ECC_P256 = {
  kty: "EC",
  crv: "P-256",
  d: "UpuF81l-kOxbjf7T4mNSv0r5tN67Gim7rnf6EFpcYDs",
  x: "qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA",
  y: "Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0",
};

/** RFC 9421 §B.1.5 — test-shared-secret. */
const TEST_SHARED_SECRET_B64 =
  "uzvJfB4u3N0Jy4T7NZ75MDVcr8zSTInedJtkgcu46YW4XByzNJjxBdtjUkdJPBtbmHhIDi6pcl8jsasjlTMtDQ==";

const B2_CREATED = new Date(1618884473 * 1000);

/** RFC 9421 §3.3 test-case algorithms over WebCrypto, keyed by the RFC's key ids. */
async function rfcKeys() {
  const rsaPss = await globalThis.crypto.subtle.importKey(
    "spki",
    Uint8Array.from(Buffer.from(TEST_KEY_RSA_PSS_SPKI_B64, "base64")) as BufferSource,
    { name: "RSA-PSS", hash: "SHA-512" },
    false,
    ["verify"],
  );
  const { d: _d, ...eccPublic } = TEST_KEY_ECC_P256;
  const eccVerify = await globalThis.crypto.subtle.importKey(
    "jwk",
    eccPublic,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const eccSign = await globalThis.crypto.subtle.importKey(
    "jwk",
    TEST_KEY_ECC_P256,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const hmac = await globalThis.crypto.subtle.importKey(
    "raw",
    Uint8Array.from(Buffer.from(TEST_SHARED_SECRET_B64, "base64")) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const verifiers: Record<string, (data: Buffer, signature: Buffer) => Promise<boolean>> = {
    "test-key-rsa-pss": (data, signature) =>
      globalThis.crypto.subtle.verify(
        { name: "RSA-PSS", saltLength: 64 },
        rsaPss,
        new Uint8Array(signature),
        new Uint8Array(data),
      ),
    // RFC 9421 §3.3.4: the signature is r || s, which is WebCrypto's ECDSA format.
    "test-key-ecc-p256": (data, signature) =>
      globalThis.crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        eccVerify,
        new Uint8Array(signature),
        new Uint8Array(data),
      ),
    "test-shared-secret": (data, signature) =>
      globalThis.crypto.subtle.verify(
        "HMAC",
        hmac,
        new Uint8Array(signature),
        new Uint8Array(data),
      ),
  };
  return {
    eccSign: async (data: Buffer) =>
      Buffer.from(
        await globalThis.crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          eccSign,
          new Uint8Array(data),
        ),
      ),
    hmacSign: async (data: Buffer) =>
      Buffer.from(await globalThis.crypto.subtle.sign("HMAC", hmac, new Uint8Array(data))),
    keyLookup: async (params: { keyid?: string }) => {
      const verify = params.keyid === undefined ? undefined : verifiers[params.keyid];
      return verify ? { id: params.keyid, verify } : null;
    },
  };
}

/** Builds the signature base for `message` by signing it and capturing what the signer saw. */
async function baseOf(
  message: { method: string; url: string } | { status: number },
  headers: Record<string, string>,
  fields: string[],
  params: string[],
  paramValues: Record<string, Date | string | undefined>,
): Promise<string> {
  let base: Buffer | null = null;
  const config = {
    key: {
      sign: async (data: Buffer) => {
        base = data;
        return Buffer.alloc(0);
      },
    },
    name: "sig",
    fields,
    params,
    paramValues,
  };
  await ("status" in message
    ? httpbis.signMessage(config, { status: message.status, headers: { ...headers } })
    : httpbis.signMessage(config, { ...message, headers: { ...headers } }));
  if (base === null) throw new Error("signer was never invoked");
  return (base as Buffer).toString("utf8");
}

/**
 * The published RSA-PSS and ECDSA test cases are randomized, so their exact
 * signature values can only be verified; their signature bases are fixed and
 * must match byte for byte. Together they cover every component and parameter
 * federation signs except `@target-uri`, `expires` and `etag`, which follow.
 */
describe("RFC 9421 §B.2 test cases for the components and parameters federation uses", () => {
  const cases = [
    {
      name: "§B.2.1 minimal signature with a nonce",
      message: TEST_REQUEST,
      fields: [] as string[],
      params: ["created", "keyid", "nonce"],
      paramValues: {
        created: B2_CREATED,
        keyid: "test-key-rsa-pss",
        nonce: "b3k2pp5k7z-50gnwp.yemd",
      },
      base: '"@signature-params": ();created=1618884473;keyid="test-key-rsa-pss";nonce="b3k2pp5k7z-50gnwp.yemd"',
      input:
        'sig-b21=();created=1618884473;keyid="test-key-rsa-pss";nonce="b3k2pp5k7z-50gnwp.yemd"',
      signature:
        "sig-b21=:d2pmTvmbncD3xQm8E9ZV2828BjQWGgiwAaw5bAkgibUopemLJcWDy/lkbbHAve4cRAtx31Iq786U7it++wgGxbtRxf8Udx7zFZsckzXaJMkA7ChG52eSkFxykJeNqsrWH5S+oxNFlD4dzVuwe8DhTSja8xxbR/Z2cOGdCbzR72rgFWhzx2VjBqJzsPLMIQKhO4DGezXehhWwE56YCE+O6c0mKZsfxVrogUvA4HELjVKWmAvtl6UnCh8jYzuVG5WSb/QEVPnP5TmcAnLH1g+s++v6d4s8m0gCw1fV5/SITLq9mhho8K3+7EPYTU8IU1bLhdxO5Nyt8C8ssinQ98Xw9Q==:",
    },
    {
      name: "§B.2.2 selective components with a tag",
      message: TEST_REQUEST,
      fields: ["@authority", "content-digest", '"@query-param";name="Pet"'],
      params: ["created", "keyid", "tag"],
      paramValues: { created: B2_CREATED, keyid: "test-key-rsa-pss", tag: "header-example" },
      base: [
        '"@authority": example.com',
        '"content-digest": sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
        '"@query-param";name="Pet": dog',
        '"@signature-params": ("@authority" "content-digest" "@query-param";name="Pet");created=1618884473;keyid="test-key-rsa-pss";tag="header-example"',
      ].join("\n"),
      input:
        'sig-b22=("@authority" "content-digest" "@query-param";name="Pet");created=1618884473;keyid="test-key-rsa-pss";tag="header-example"',
      signature:
        "sig-b22=:LjbtqUbfmvjj5C5kr1Ugj4PmLYvx9wVjZvD9GsTT4F7GrcQEdJzgI9qHxICagShLRiLMlAJjtq6N4CDfKtjvuJyE5qH7KT8UCMkSowOB4+ECxCmT8rtAmj/0PIXxi0A0nxKyB09RNrCQibbUjsLS/2YyFYXEu4TRJQzRw1rLEuEfY17SARYhpTlaqwZVtR8NV7+4UKkjqpcAoFqWFQh62s7Cl+H2fjBSpqfZUJcsIk4N6wiKYd4je2U/lankenQ99PZfB4jY3I5rSV2DSBVkSFsURIjYErOs0tFTQosMTAoxk//0RoKUqiYY8Bh0aaUEb0rQl3/XaVe4bXTugEjHSw==:",
    },
    {
      name: "§B.2.3 full coverage including content-type and content-digest",
      message: TEST_REQUEST,
      fields: [
        "date",
        "@method",
        "@path",
        "@query",
        "@authority",
        "content-type",
        "content-digest",
        "content-length",
      ],
      params: ["created", "keyid"],
      paramValues: { created: B2_CREATED, keyid: "test-key-rsa-pss" },
      base: [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@query": ?param=Value&Pet=dog',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-digest": sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@query" "@authority" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-rsa-pss"',
      ].join("\n"),
      input:
        'sig-b23=("date" "@method" "@path" "@query" "@authority" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-rsa-pss"',
      signature:
        "sig-b23=:bbN8oArOxYoyylQQUU6QYwrTuaxLwjAC9fbY2F6SVWvh0yBiMIRGOnMYwZ/5MR6fb0Kh1rIRASVxFkeGt683+qRpRRU5p2voTp768ZrCUb38K0fUxN0O0iC59DzYx8DFll5GmydPxSmme9v6ULbMFkl+V5B1TP/yPViV7KsLNmvKiLJH1pFkh/aYA2HXXZzNBXmIkoQoLd7YfW91kE9o/CCoC1xMy7JA1ipwvKvfrs65ldmlu9bpG6A9BmzhuzF8Eim5f8ui9eH8LZH896+QIF61ka39VBrohr9iyMUJpvRX2Zbhl5ZJzSRxpJyoEZAFL2FUo5fTIztsDZKEgM4cUA==:",
    },
    {
      name: "§B.2.4 response with @status, content-type and content-digest",
      message: TEST_RESPONSE,
      fields: ["@status", "content-type", "content-digest", "content-length"],
      params: ["created", "keyid"],
      paramValues: { created: B2_CREATED, keyid: "test-key-ecc-p256" },
      base: [
        '"@status": 200',
        '"content-type": application/json',
        '"content-digest": sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:',
        '"content-length": 23',
        '"@signature-params": ("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
      ].join("\n"),
      input:
        'sig-b24=("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
      signature:
        "sig-b24=:wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==:",
    },
    {
      name: "§B.2.5 HMAC over date, authority and content-type",
      message: TEST_REQUEST,
      fields: ["date", "@authority", "content-type"],
      params: ["created", "keyid"],
      paramValues: { created: B2_CREATED, keyid: "test-shared-secret" },
      base: [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@authority": example.com',
        '"content-type": application/json',
        '"@signature-params": ("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret"',
      ].join("\n"),
      input:
        'sig-b25=("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret"',
      signature: "sig-b25=:pxcQw6G3AjtMBQjwo8XzkZf/bws5LelbaMk5rGIGtE8=:",
    },
  ];

  it.each(cases)("$name: builds the published signature base", async (c) => {
    const message = "status" in c.message ? { status: c.message.status } : c.message;
    const base = await baseOf(message, { ...c.message.headers }, c.fields, c.params, c.paramValues);
    expect(base).toBe(c.base);
  });

  it.each(cases)("$name: verifies the published signature, not a tampered one", async (c) => {
    const { keyLookup } = await rfcKeys();
    const verify = (headers: Record<string, string>) =>
      "status" in c.message
        ? httpbis.verifyMessage({ keyLookup }, { status: c.message.status, headers })
        : httpbis.verifyMessage({ keyLookup }, { ...c.message, headers });
    const signed = { "Signature-Input": c.input, Signature: c.signature };
    expect(await verify({ ...c.message.headers, ...signed })).toBe(true);
    const tampered = c.signature.replace(/:(.)/, (_, ch: string) => `:${ch === "A" ? "B" : "A"}`);
    expect(await verify({ ...c.message.headers, ...signed, Signature: tampered })).toBe(false);
  });

  it("§B.2.5: reproduces the deterministic HMAC signature exactly", async () => {
    const { hmacSign } = await rfcKeys();
    const signed = await httpbis.signMessage(
      {
        key: { id: "test-shared-secret", sign: hmacSign },
        name: "sig-b25",
        fields: ["date", "@authority", "content-type"],
        params: ["created", "keyid"],
        paramValues: { created: B2_CREATED },
      },
      { ...TEST_REQUEST, headers: { ...TEST_REQUEST.headers } },
    );
    expect((signed.headers as Record<string, string>)["Signature"]).toBe(cases[4]!.signature);
  });

  it("§B.2.4: a fresh ECDSA signature over the response verifies with the published key", async () => {
    const { eccSign, keyLookup } = await rfcKeys();
    const signed = await httpbis.signMessage(
      {
        key: { id: "test-key-ecc-p256", sign: eccSign },
        name: "sig-b24",
        fields: ["@status", "content-type", "content-digest", "content-length"],
        params: ["created", "keyid"],
        paramValues: { created: B2_CREATED },
      },
      { status: 200, headers: { ...TEST_RESPONSE.headers } },
    );
    expect((signed.headers as Record<string, string>)["Signature-Input"]).toBe(cases[3]!.input);
    expect(
      await httpbis.verifyMessage(
        { keyLookup },
        { status: 200, headers: signed.headers as Record<string, string> },
      ),
    ).toBe(true);
  });

  it("§2.2.2: serializes @target-uri as the full target URI", async () => {
    const base = await baseOf(
      { method: "POST", url: "https://www.example.com/path?param=value" },
      { Host: "www.example.com" },
      ["@target-uri"],
      [],
      {},
    );
    expect(base.split("\n")[0]).toBe('"@target-uri": https://www.example.com/path?param=value');
  });

  it("§2.3: serializes the signature parameters, expires included, in the given order", async () => {
    const base = await baseOf(
      { method: "GET", url: "https://www.example.com/path?param=value" },
      {
        Host: "www.example.com",
        Date: "Tue, 20 Apr 2021 02:07:55 GMT",
        "Cache-Control": "max-age=60",
      },
      ["@target-uri", "@authority", "date", "cache-control"],
      ["keyid", "alg", "created", "expires"],
      {
        keyid: "test-key-rsa-pss",
        alg: "rsa-pss-sha512",
        created: new Date(1618884475 * 1000),
        expires: new Date(1618884775 * 1000),
      },
    );
    expect(base.split("\n").at(-1)).toBe(
      '"@signature-params": ("@target-uri" "@authority" "date" "cache-control");keyid="test-key-rsa-pss";alg="rsa-pss-sha512";created=1618884475;expires=1618884775',
    );
  });
});

/**
 * Federation's own signer and verifier on the RFC's test-request and
 * test-response, signed with the RFC's Ed25519 test key. The expected
 * signature base is written out by hand from RFC 9421 §2.5, and the expected
 * signature computed over it by node:crypto, independently of the library
 * federation delegates to; Ed25519 is deterministic, so both must match exactly.
 */
describe("federation signMessage/verifyMessage on the RFC test messages", () => {
  const created = 1618884473;
  const expires = created + 60;
  const nonce = "b3k2pp5k7z-50gnwp.yemd";
  const body = new TextEncoder().encode('{"hello": "world"}');
  const params = `;created=${created};expires=${expires};keyid="${B26_KEYID}";nonce="${nonce}";tag="openconditions-federation"`;

  const independentSignature = (base: string) =>
    edSign(
      null,
      Buffer.from(base, "utf8"),
      createPrivateKey({
        key: Buffer.from(TEST_KEY_ED25519_PKCS8_B64, "base64"),
        format: "der",
        type: "pkcs8",
      }),
    ).toString("base64");

  const verifyAt = async (
    message: { method: string; url: string; status?: number; isResponse?: true },
    headers: Record<string, string>,
    receivedBody: Uint8Array | undefined,
  ) => {
    const publicKey = await importTestPublicKey();
    return verifyMessage({
      ...message,
      headers,
      ...(receivedBody !== undefined ? { body: receivedBody } : {}),
      resolvePublicKey: async (keyId) => (keyId === B26_KEYID ? publicKey : null),
      nonceStore: new InMemoryNonceStore(),
      now: created + 1,
    });
  };

  it("signs a request with the RFC 9530 digest, covered components and parameters it documents", async () => {
    const { headers } = await signMessage({
      method: "POST",
      url: TEST_REQUEST.url,
      headers: { Host: "example.com", "Content-Type": "application/json" },
      body,
      keyId: B26_KEYID,
      privateKey: await importTestPrivateKey(),
      created,
      expires,
      nonce,
    });
    // RFC 9530 Appendix D: sha-256 of {"hello": "world"}.
    expect(headers["Content-Digest"]).toBe(
      "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:",
    );
    const components = '("@method" "@target-uri" "content-type" "content-digest")';
    const base = [
      '"@method": POST',
      '"@target-uri": https://example.com/foo?param=Value&Pet=dog',
      '"content-type": application/json',
      '"content-digest": sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
      `"@signature-params": ${components}${params}`,
    ].join("\n");
    expect(headers["Signature-Input"]).toBe(`oc=${components}${params}`);
    expect(headers["Signature"]).toBe(`oc=:${independentSignature(base)}:`);
    expect((await verifyAt({ method: "POST", url: TEST_REQUEST.url }, headers, body)).ok).toBe(
      true,
    );
  });

  it("signs a bodyless response over @status and a covered etag", async () => {
    const { headers } = await signMessage({
      method: "GET",
      url: "https://example.com/foo",
      headers: { ETag: '"v1"' },
      isResponse: true,
      status: 304,
      coverHeaders: ["ETag"],
      keyId: B26_KEYID,
      privateKey: await importTestPrivateKey(),
      created,
      expires,
      nonce,
    });
    const components = '("@status" "etag")';
    const base = [
      '"@status": 304',
      '"etag": "v1"',
      `"@signature-params": ${components}${params}`,
    ].join("\n");
    expect(headers["Content-Digest"]).toBeUndefined();
    expect(headers["Signature"]).toBe(`oc=:${independentSignature(base)}:`);
    const response = {
      method: "GET",
      url: "https://example.com/foo",
      status: 304,
      isResponse: true,
    } as const;
    expect((await verifyAt(response, headers, undefined)).ok).toBe(true);
  });

  it("rejects a signed request whose body was stripped in transit", async () => {
    const { headers } = await signMessage({
      method: "POST",
      url: TEST_REQUEST.url,
      headers: { "Content-Type": "application/json" },
      body,
      keyId: B26_KEYID,
      privateKey: await importTestPrivateKey(),
      created,
      expires,
      nonce,
    });
    const url = { method: "POST", url: TEST_REQUEST.url };
    expect(await verifyAt(url, headers, new Uint8Array())).toEqual({
      ok: false,
      reason: "bad-digest",
    });
    expect(await verifyAt(url, headers, undefined)).toEqual({ ok: false, reason: "bad-digest" });
  });
});
