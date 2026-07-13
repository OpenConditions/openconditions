import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpbis } from "http-message-signatures";
import { parseDictionary, serializeDictionary } from "structured-headers";
import { generateInstanceKey, type InstanceKey } from "../keys.js";
import {
  CLOCK_SKEW_SEC,
  EXPIRES_WINDOW_SEC,
  FEDERATION_REASON_HEADER,
  FEDERATION_TAG,
  InMemoryNonceStore,
  NONCE_TTL_SEC,
  federationFailureHeaders,
  signMessage,
  verifyMessage,
  type NonceStore,
} from "../http-signature.js";

const ED25519 = { name: "Ed25519" } as const;

const BODY = new TextEncoder().encode('{"hello": "world"}');
const URL_ = "https://peer.example/api/federation/inbox";

async function makeKey(): Promise<InstanceKey> {
  return generateInstanceKey(new Date().toISOString());
}

function resolverFor(key: InstanceKey) {
  return async (keyId: string): Promise<CryptoKey | null> =>
    keyId === key.keyId ? key.publicKey : null;
}

async function signedRequest(key: InstanceKey, overrides: Record<string, unknown> = {}) {
  return signMessage({
    method: "POST",
    url: URL_,
    headers: { "Content-Type": "application/json" },
    body: BODY,
    keyId: key.keyId,
    privateKey: key.privateKey,
    ...overrides,
  });
}

function verifyInput(key: InstanceKey, headers: Record<string, string>) {
  return {
    method: "POST",
    url: URL_,
    headers,
    body: BODY,
    resolvePublicKey: resolverFor(key),
    nonceStore: new InMemoryNonceStore(),
  };
}

describe("signMessage", () => {
  it("adds Content-Digest, Signature-Input, and Signature for a bodied request", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    expect(headers["Content-Digest"]).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
    expect(headers["Signature-Input"]).toContain('"@method"');
    expect(headers["Signature-Input"]).toContain('"@target-uri"');
    expect(headers["Signature-Input"]).toContain('"content-type"');
    expect(headers["Signature-Input"]).toContain('"content-digest"');
    expect(headers["Signature-Input"]).toContain(`;keyid="${key.keyId}"`);
    expect(headers["Signature-Input"]).toContain(`;tag="${FEDERATION_TAG}"`);
    expect(headers["Signature-Input"]).toMatch(/;created=\d+/);
    expect(headers["Signature-Input"]).toMatch(/;expires=\d+/);
    expect(headers["Signature-Input"]).toMatch(/;nonce="[^"]+"/);
    expect(headers["Signature"]).toMatch(/^oc=:[A-Za-z0-9+/]+=*:$/);
  });

  it("defaults expires to created + the 60s window", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key, { created: 1_700_000_000 });
    expect(headers["Signature-Input"]).toContain(";created=1700000000");
    expect(headers["Signature-Input"]).toContain(`;expires=${1_700_000_000 + EXPIRES_WINDOW_SEC}`);
  });

  it("generates a fresh nonce per signature", async () => {
    const key = await makeKey();
    const a = await signedRequest(key);
    const b = await signedRequest(key);
    const nonce = (h: Record<string, string>) => /;nonce="([^"]+)"/.exec(h["Signature-Input"])?.[1];
    expect(nonce(a.headers)).toBeTruthy();
    expect(nonce(a.headers)).not.toBe(nonce(b.headers));
  });

  it("requires a status when signing a response", async () => {
    const key = await makeKey();
    await expect(
      signMessage({
        method: "POST",
        url: URL_,
        headers: {},
        keyId: key.keyId,
        privateKey: key.privateKey,
        isResponse: true,
      })
    ).rejects.toThrow(/status/);
  });
});

describe("verifyMessage round-trip", () => {
  it("accepts a signed request with a body", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    const result = await verifyMessage(verifyInput(key, headers));
    expect(result).toEqual({ ok: true, keyId: key.keyId });
  });

  it("accepts a signed request without a body", async () => {
    const key = await makeKey();
    const { headers } = await signMessage({
      method: "GET",
      url: URL_,
      headers: {},
      keyId: key.keyId,
      privateKey: key.privateKey,
    });
    const result = await verifyMessage({
      method: "GET",
      url: URL_,
      headers,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: true, keyId: key.keyId });
  });

  it("rejects a tampered body as bad-digest", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    const result = await verifyMessage({
      ...verifyInput(key, headers),
      body: new TextEncoder().encode('{"hello": "tampered"}'),
    });
    expect(result).toEqual({ ok: false, reason: "bad-digest" });
  });

  it("rejects a tampered covered header as bad-signature", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    const result = await verifyMessage(
      verifyInput(key, { ...headers, "Content-Type": "text/plain" })
    );
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered target URI as bad-signature", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    const result = await verifyMessage({
      ...verifyInput(key, headers),
      url: "https://peer.example/api/federation/other",
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("signs and verifies a response over @status and content-digest", async () => {
    const key = await makeKey();
    const { headers } = await signMessage({
      method: "POST",
      url: URL_,
      headers: { "Content-Type": "application/json" },
      body: BODY,
      keyId: key.keyId,
      privateKey: key.privateKey,
      isResponse: true,
      status: 200,
    });
    expect(headers["Signature-Input"]).toContain('"@status"');
    const result = await verifyMessage({
      method: "POST",
      url: URL_,
      status: 200,
      headers,
      body: BODY,
      isResponse: true,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: true, keyId: key.keyId });
  });

  it("covers an extra response header (etag on a bodyless 304) and rejects a tampered ETag", async () => {
    const key = await makeKey();
    const { headers } = await signMessage({
      method: "GET",
      url: URL_,
      headers: { etag: '"42-abc123"' },
      coverHeaders: ["etag"],
      keyId: key.keyId,
      privateKey: key.privateKey,
      isResponse: true,
      status: 304,
    });
    expect(headers["Signature-Input"]).toContain('"etag"');

    const ok = await verifyMessage({
      method: "GET",
      url: URL_,
      status: 304,
      headers,
      isResponse: true,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(ok).toEqual({ ok: true, keyId: key.keyId });

    const tampered = await verifyMessage({
      method: "GET",
      url: URL_,
      status: 304,
      headers: { ...headers, etag: '"999-deadbeef"' },
      isResponse: true,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(tampered).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("throws when a coverHeaders entry is absent from headers", async () => {
    const key = await makeKey();
    await expect(
      signMessage({
        method: "GET",
        url: URL_,
        headers: {},
        coverHeaders: ["etag"],
        keyId: key.keyId,
        privateKey: key.privateKey,
        isResponse: true,
        status: 304,
      })
    ).rejects.toThrow(/etag/);
  });

  it("rejects a response whose status was tampered with", async () => {
    const key = await makeKey();
    const { headers } = await signMessage({
      method: "POST",
      url: URL_,
      headers: { "Content-Type": "application/json" },
      body: BODY,
      keyId: key.keyId,
      privateKey: key.privateKey,
      isResponse: true,
      status: 200,
    });
    const result = await verifyMessage({
      method: "POST",
      url: URL_,
      status: 403,
      headers,
      body: BODY,
      isResponse: true,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("verifyMessage replay and expiry policy", () => {
  it("rejects a replayed nonce on the second verification", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    const nonceStore = new InMemoryNonceStore();
    const input = { ...verifyInput(key, headers), nonceStore };
    expect(await verifyMessage(input)).toEqual({ ok: true, keyId: key.keyId });
    expect(await verifyMessage(input)).toEqual({ ok: false, reason: "replayed" });
  });

  it("does not burn the nonce when the signature is invalid", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    const nonceStore = new InMemoryNonceStore();
    const tampered = await verifyMessage({
      ...verifyInput(key, { ...headers, "Content-Type": "text/plain" }),
      nonceStore,
    });
    expect(tampered).toEqual({ ok: false, reason: "bad-signature" });
    const genuine = await verifyMessage({ ...verifyInput(key, headers), nonceStore });
    expect(genuine).toEqual({ ok: true, keyId: key.keyId });
  });

  it("rejects an expired message (created 200s ago) as expired", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const { headers } = await signedRequest(key, { created: now - 200 });
    const result = await verifyMessage({ ...verifyInput(key, headers), now });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a future-dated message (created now+120s) as expired", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const { headers } = await signedRequest(key, { created: now + 120 });
    const result = await verifyMessage({ ...verifyInput(key, headers), now });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a message created slightly in the future, within the ±30s skew", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const { headers } = await signedRequest(key, { created: now + 20 });
    const result = await verifyMessage({ ...verifyInput(key, headers), now });
    expect(result).toEqual({ ok: true, keyId: key.keyId });
  });

  it("accepts a message that expired within the 30s skew", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const { headers } = await signedRequest(key, { created: now - 80 });
    const result = await verifyMessage({ ...verifyInput(key, headers), now });
    expect(result).toEqual({ ok: true, keyId: key.keyId });
  });

  it("honours an injected verification clock", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key, { created: 1_000_000 });
    const at = (now: number) => verifyMessage({ ...verifyInput(key, headers), now });
    expect(await at(1_000_030)).toEqual({ ok: true, keyId: key.keyId });
    expect(await at(1_000_200)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a message signed without created/expires as expired", async () => {
    const key = await makeKey();
    const signed = await httpbis.signMessage(
      {
        key: {
          id: key.keyId,
          alg: "ed25519",
          sign: async (data: Buffer) =>
            Buffer.from(
              await globalThis.crypto.subtle.sign(ED25519, key.privateKey, new Uint8Array(data))
            ),
        },
        name: "oc",
        fields: ["@method", "@target-uri"],
        params: ["keyid", "nonce", "tag"],
        paramValues: { created: null, nonce: "n-1", tag: FEDERATION_TAG },
      },
      { method: "GET", url: URL_, headers: {} }
    );
    const result = await verifyMessage({
      method: "GET",
      url: URL_,
      headers: signed.headers as Record<string, string>,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a message signed without a nonce as missing-nonce", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const signed = await httpbis.signMessage(
      {
        key: {
          id: key.keyId,
          alg: "ed25519",
          sign: async (data: Buffer) =>
            Buffer.from(
              await globalThis.crypto.subtle.sign(ED25519, key.privateKey, new Uint8Array(data))
            ),
        },
        name: "oc",
        fields: ["@method", "@target-uri"],
        params: ["created", "expires", "keyid", "tag"],
        paramValues: {
          created: new Date(now * 1000),
          expires: new Date((now + 60) * 1000),
          tag: FEDERATION_TAG,
        },
      },
      { method: "GET", url: URL_, headers: {} }
    );
    const result = await verifyMessage({
      method: "GET",
      url: URL_,
      headers: signed.headers as Record<string, string>,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: "missing-nonce" });
  });
});

describe("verifyMessage digest, key, and tag policy", () => {
  it("rejects a Content-Digest that does not match the received bytes", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    const otherDigest = Buffer.from(
      await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode("other"))
    ).toString("base64");
    const result = await verifyMessage(
      verifyInput(key, { ...headers, "Content-Digest": `sha-256=:${otherDigest}:` })
    );
    expect(result).toEqual({ ok: false, reason: "bad-digest" });
  });

  it("rejects a body without any Content-Digest header", async () => {
    const key = await makeKey();
    const { headers } = await signMessage({
      method: "POST",
      url: URL_,
      headers: {},
      keyId: key.keyId,
      privateKey: key.privateKey,
    });
    const result = await verifyMessage({ ...verifyInput(key, headers), body: BODY });
    expect(result).toEqual({ ok: false, reason: "bad-digest" });
  });

  it("rejects a body whose content-digest is not a covered component", async () => {
    const key = await makeKey();
    const digest = Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", BODY)).toString(
      "base64"
    );
    const now = Math.floor(Date.now() / 1000);
    const signed = await httpbis.signMessage(
      {
        key: {
          id: key.keyId,
          alg: "ed25519",
          sign: async (data: Buffer) =>
            Buffer.from(
              await globalThis.crypto.subtle.sign(ED25519, key.privateKey, new Uint8Array(data))
            ),
        },
        name: "oc",
        fields: ["@method", "@target-uri"],
        params: ["created", "expires", "keyid", "nonce", "tag"],
        paramValues: {
          created: new Date(now * 1000),
          expires: new Date((now + 60) * 1000),
          nonce: "n-uncovered",
          tag: FEDERATION_TAG,
        },
      },
      { method: "POST", url: URL_, headers: { "Content-Digest": `sha-256=:${digest}:` } }
    );
    const result = await verifyMessage({
      method: "POST",
      url: URL_,
      headers: signed.headers as Record<string, string>,
      body: BODY,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: "bad-digest" });
  });

  it("rejects an unknown keyid as unknown-key", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    const result = await verifyMessage({
      ...verifyInput(key, headers),
      resolvePublicKey: async () => null,
    });
    expect(result).toEqual({ ok: false, reason: "unknown-key" });
  });

  it("rejects a signature verified with the wrong public key as bad-signature", async () => {
    const key = await makeKey();
    const other = await makeKey();
    const { headers } = await signedRequest(key);
    const result = await verifyMessage({
      ...verifyInput(key, headers),
      resolvePublicKey: async () => other.publicKey,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a foreign tag as tag-mismatch", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key, { tag: "some-other-protocol" });
    const result = await verifyMessage(verifyInput(key, headers));
    expect(result).toEqual({ ok: false, reason: "tag-mismatch" });
  });

  it("rejects a message without signature headers as bad-signature", async () => {
    const key = await makeKey();
    const result = await verifyMessage({
      method: "GET",
      url: URL_,
      headers: {},
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("federationFailureHeaders", () => {
  it("maps a failure reason onto the Federation-Reason header", () => {
    expect(federationFailureHeaders("expired")).toEqual({ [FEDERATION_REASON_HEADER]: "expired" });
    expect(federationFailureHeaders("bad-digest")).toEqual({
      "Federation-Reason": "bad-digest",
    });
  });
});

describe("InMemoryNonceStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("remembers a nonce for its TTL and evicts it afterwards", async () => {
    vi.useFakeTimers();
    const store: NonceStore = new InMemoryNonceStore();
    expect(await store.seen("peer-a", "n1")).toBe(false);
    await store.remember("peer-a", "n1", NONCE_TTL_SEC);
    expect(await store.seen("peer-a", "n1")).toBe(true);
    vi.advanceTimersByTime((NONCE_TTL_SEC + 1) * 1000);
    expect(await store.seen("peer-a", "n1")).toBe(false);
  });

  it("keys nonces per peer", async () => {
    const store = new InMemoryNonceStore();
    await store.remember("peer-a", "n1", NONCE_TTL_SEC);
    expect(await store.seen("peer-b", "n1")).toBe(false);
    expect(await store.seen("peer-a", "n1")).toBe(true);
  });

  it("derives the nonce TTL from the expiry window plus skew", () => {
    expect(NONCE_TTL_SEC).toBe(EXPIRES_WINDOW_SEC + CLOCK_SKEW_SEC);
  });

  it("reserves a nonce atomically — concurrent reservations yield exactly one winner", async () => {
    const store = new InMemoryNonceStore();
    const outcomes = await Promise.all(
      Array.from({ length: 32 }, () => store.reserve("peer-a", "n-race", NONCE_TTL_SEC))
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await store.seen("peer-a", "n-race")).toBe(true);
  });

  it("reserve refuses a second claim of the same nonce", async () => {
    const store = new InMemoryNonceStore();
    expect(await store.reserve("peer-a", "n1", NONCE_TTL_SEC)).toBe(true);
    expect(await store.reserve("peer-a", "n1", NONCE_TTL_SEC)).toBe(false);
    expect(await store.reserve("peer-b", "n1", NONCE_TTL_SEC)).toBe(true);
  });
});

function flattenHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) flat[k] = Array.isArray(v) ? v.join(", ") : v;
  return flat;
}

function ed25519Signer(privateKey: CryptoKey) {
  return async (data: Buffer) =>
    Buffer.from(await globalThis.crypto.subtle.sign(ED25519, privateKey, new Uint8Array(data)));
}

const garbageSigner = async () => Buffer.from(new Uint8Array(64));

/** Appends a second signature entry (own label) to already-signed headers. */
async function appendSignature(
  headers: Record<string, string>,
  opts: {
    method: string;
    url: string;
    keyId: string;
    name: string;
    nonce: string;
    created: number;
    tag: string;
    sign: (data: Buffer) => Promise<Buffer>;
    fields?: string[];
  }
): Promise<Record<string, string>> {
  const signed = await httpbis.signMessage(
    {
      key: { id: opts.keyId, alg: "ed25519", sign: opts.sign },
      name: opts.name,
      fields: opts.fields ?? ["@method", "@target-uri"],
      params: ["created", "expires", "keyid", "nonce", "tag"],
      paramValues: {
        created: new Date(opts.created * 1000),
        expires: new Date((opts.created + 60) * 1000),
        nonce: opts.nonce,
        tag: opts.tag,
      },
    },
    { method: opts.method, url: opts.url, headers }
  );
  return flattenHeaders(signed.headers);
}

/** Reverses the entry order of the Signature and Signature-Input dictionaries. */
function reverseSignatureOrder(headers: Record<string, string>): Record<string, string> {
  const reverse = (value: string): string =>
    serializeDictionary(new Map([...parseDictionary(value)].reverse()));
  const out = { ...headers };
  for (const name of Object.keys(out)) {
    if (name.toLowerCase() === "signature" || name.toLowerCase() === "signature-input") {
      out[name] = reverse(out[name]);
    }
  }
  return out;
}

describe("verify bypass hardening — multi-signature and coverage", () => {
  it("ATTACK A: replays a captured signature behind a fresh-nonce decoy → ambiguous", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const store = new InMemoryNonceStore();
    // The genuine message is used once, burning its nonce.
    const { headers } = await signedRequest(key, { created: now, nonce: "genuine-nonce" });
    expect(await verifyMessage({ ...verifyInput(key, headers), nonceStore: store, now })).toEqual({
      ok: true,
      keyId: key.keyId,
    });
    // The attacker prepends a federation-tagged decoy carrying a FRESH nonce
    // (to dodge replay) while keeping the captured, still-valid signature last.
    const withDecoy = await appendSignature(headers, {
      method: "POST",
      url: URL_,
      keyId: key.keyId,
      name: "decoy",
      nonce: "fresh-decoy-nonce",
      created: now,
      tag: FEDERATION_TAG,
      sign: garbageSigner,
      fields: ["@method", "@target-uri", "content-type", "content-digest"],
    });
    const forged = reverseSignatureOrder(withDecoy);
    const result = await verifyMessage({
      ...verifyInput(key, forged),
      nonceStore: store,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "ambiguous-signature" });
  });

  it("ATTACK B: pairs an expired valid signature with a fresh-nonce decoy → ambiguous", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    // A genuine signature that is now expired (created 200s ago).
    const { headers } = await signedRequest(key, { created: now - 200, nonce: "old-nonce" });
    const withDecoy = await appendSignature(headers, {
      method: "POST",
      url: URL_,
      keyId: key.keyId,
      name: "decoy",
      nonce: "fresh-decoy-nonce",
      created: now,
      tag: FEDERATION_TAG,
      sign: garbageSigner,
    });
    const forged = reverseSignatureOrder(withDecoy);
    const result = await verifyMessage({ ...verifyInput(key, forged), now });
    expect(result).toEqual({ ok: false, reason: "ambiguous-signature" });
  });

  it("CONTROL: the single-signature legitimate message still verifies", async () => {
    const key = await makeKey();
    const { headers } = await signedRequest(key);
    expect(await verifyMessage(verifyInput(key, headers))).toEqual({ ok: true, keyId: key.keyId });
  });

  it("a co-present valid signature under a different label and tag cannot rescue a federation-tagged decoy", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    // A genuinely valid signature, but under a NON-federation tag and label.
    const valid = await httpbis.signMessage(
      {
        key: { id: key.keyId, alg: "ed25519", sign: ed25519Signer(key.privateKey) },
        name: "good",
        fields: ["@method", "@target-uri"],
        params: ["created", "expires", "keyid", "nonce", "tag"],
        paramValues: {
          created: new Date(now * 1000),
          expires: new Date((now + 60) * 1000),
          nonce: "valid-nonce",
          tag: "some-other-protocol",
        },
      },
      { method: "GET", url: URL_, headers: {} }
    );
    // The lone federation-tagged signature is a garbage-signed decoy.
    const forged = await appendSignature(flattenHeaders(valid.headers), {
      method: "GET",
      url: URL_,
      keyId: key.keyId,
      name: "oc",
      nonce: "fresh-decoy-nonce",
      created: now,
      tag: FEDERATION_TAG,
      sign: garbageSigner,
    });
    const result = await verifyMessage({
      method: "GET",
      url: URL_,
      headers: forged,
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
      now,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a peer signature covering only @authority+@path (query unsigned) as insufficient-coverage", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const signed = await httpbis.signMessage(
      {
        key: { id: key.keyId, alg: "ed25519", sign: ed25519Signer(key.privateKey) },
        name: "oc",
        fields: ["@method", "@authority", "@path"],
        params: ["created", "expires", "keyid", "nonce", "tag"],
        paramValues: {
          created: new Date(now * 1000),
          expires: new Date((now + 60) * 1000),
          nonce: "n-cov",
          tag: FEDERATION_TAG,
        },
      },
      { method: "GET", url: URL_, headers: {} }
    );
    const result = await verifyMessage({
      method: "GET",
      url: URL_,
      headers: flattenHeaders(signed.headers),
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
      now,
    });
    expect(result).toEqual({ ok: false, reason: "insufficient-coverage" });
  });

  it("accepts a peer signature covering @authority+@path+@query together", async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const url = "https://peer.example/api/federation/inbox?param=Value";
    const signed = await httpbis.signMessage(
      {
        key: { id: key.keyId, alg: "ed25519", sign: ed25519Signer(key.privateKey) },
        name: "oc",
        fields: ["@method", "@authority", "@path", "@query"],
        params: ["created", "expires", "keyid", "nonce", "tag"],
        paramValues: {
          created: new Date(now * 1000),
          expires: new Date((now + 60) * 1000),
          nonce: "n-cov-ok",
          tag: FEDERATION_TAG,
        },
      },
      { method: "GET", url, headers: {} }
    );
    const result = await verifyMessage({
      method: "GET",
      url,
      headers: flattenHeaders(signed.headers),
      resolvePublicKey: resolverFor(key),
      nonceStore: new InMemoryNonceStore(),
      now,
    });
    expect(result).toEqual({ ok: true, keyId: key.keyId });
  });

  it("maps the new failure reasons onto the Federation-Reason header", () => {
    expect(federationFailureHeaders("ambiguous-signature")).toEqual({
      [FEDERATION_REASON_HEADER]: "ambiguous-signature",
    });
    expect(federationFailureHeaders("insufficient-coverage")).toEqual({
      [FEDERATION_REASON_HEADER]: "insufficient-coverage",
    });
  });
});

describe("RFC 9421 only (no Cavage draft path)", () => {
  it("never touches the library's cavage module", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../http-signature.ts", import.meta.url)),
      "utf8"
    );
    expect(source).not.toMatch(/cavage/i);
    expect(source).toMatch(/httpbis/);
  });
});
