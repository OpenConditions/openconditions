/**
 * RFC 9421 HTTP Message Signatures for federation transport.
 *
 * Every federated request AND response carries an Ed25519 signature. The
 * RFC 9421 signature base / component canonicalization is delegated to the
 * pinned `http-message-signatures` library (its RFC 9421 `httpbis` module
 * only — never the obsolete pre-RFC draft scheme), conformance-gated against the official
 * RFC 9421 Appendix B.2.6 Ed25519 test vector. The Ed25519 primitive itself
 * is native WebCrypto, reusing the {@link InstanceKey} handles from keys.ts.
 * Bodies are bound via an RFC 9530 Content-Digest (sha-256) covered by the
 * signature and verified against the RECEIVED bytes.
 *
 * The replay policy here is TRANSPORT protection, independent of any event
 * TTL: short created/expires windows, bounded clock skew, and a mandatory
 * per-peer single-use nonce.
 */
import { httpbis } from "http-message-signatures";
import {
  type InnerList,
  isInnerList,
  parseDictionary,
  serializeDictionary,
} from "structured-headers";

/** The RFC 9421 `tag` parameter every OpenConditions federation signature carries. */
export const FEDERATION_TAG = "openconditions-federation";

/** Response header naming why a federated message was rejected (sent with the 401). */
export const FEDERATION_REASON_HEADER = "Federation-Reason";

/** Default signature lifetime: `expires` = `created` + this window, in seconds. */
export const EXPIRES_WINDOW_SEC = 60;

/** Tolerated clock skew between peers when checking created/expires, in seconds. */
export const CLOCK_SKEW_SEC = 30;

/** Nonce replay-cache TTL: the expiry window plus the skew tolerance, in seconds. */
export const NONCE_TTL_SEC = EXPIRES_WINDOW_SEC + CLOCK_SKEW_SEC;

/** Why {@link verifyMessage} rejected a message; doubles as the Federation-Reason value. */
export type FederationFailureReason =
  | "expired"
  | "replayed"
  | "bad-signature"
  | "bad-digest"
  | "unknown-key"
  | "missing-nonce"
  | "tag-mismatch"
  | "ambiguous-signature"
  | "insufficient-coverage";

/** Builds the headers a caller attaches to its HTTP 401 for a rejected message. */
export function federationFailureHeaders(reason: FederationFailureReason): Record<string, string> {
  return { [FEDERATION_REASON_HEADER]: reason };
}

/** Per-peer single-use nonce cache guarding against replayed signatures. */
export interface NonceStore {
  /** Whether `nonce` was already used by `peerId` within the TTL. */
  seen(peerId: string, nonce: string): Promise<boolean>;
  /** Records `nonce` for `peerId` for `ttlSec` seconds. */
  remember(peerId: string, nonce: string, ttlSec: number): Promise<void>;
  /**
   * Atomic check-and-insert: reserves `nonce` for `peerId`, returning true iff
   * it was NOT already reserved (i.e. this caller won the nonce). The check and
   * the insert MUST be a single indivisible operation — two concurrent
   * reservations of the same nonce must yield exactly one true. A Redis-backed
   * store implements this as `SET key val NX PX ttl`. Optional for backward
   * compatibility; {@link verifyMessage} falls back to seen()+remember() (which
   * is NOT atomic) when absent.
   */
  reserve?(peerId: string, nonce: string, ttlSec: number): Promise<boolean>;
}

/**
 * Atomically claims `nonce`, using the store's atomic {@link NonceStore.reserve}
 * when available and otherwise a best-effort (non-atomic) seen()+remember().
 */
async function reserveNonce(
  store: NonceStore,
  peerId: string,
  nonce: string,
  ttlSec: number,
): Promise<boolean> {
  if (store.reserve) return store.reserve(peerId, nonce, ttlSec);
  if (await store.seen(peerId, nonce)) return false;
  await store.remember(peerId, nonce, ttlSec);
  return true;
}

/**
 * Map-backed {@link NonceStore} for tests and single-instance deployments.
 * Entries expire lazily on lookup, plus a size-triggered sweep on write so an
 * idle key set cannot grow without bound. Multi-instance deployments need a
 * shared (Redis-backed) store instead — a later wiring concern.
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, number>();

  constructor(private readonly sweepAt = 4096) {}

  private static key(peerId: string, nonce: string): string {
    return `${peerId}\u0000${nonce}`;
  }

  async seen(peerId: string, nonce: string): Promise<boolean> {
    const key = InMemoryNonceStore.key(peerId, nonce);
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  async remember(peerId: string, nonce: string, ttlSec: number): Promise<void> {
    this.sweep();
    this.entries.set(InMemoryNonceStore.key(peerId, nonce), Date.now() + ttlSec * 1000);
  }

  /**
   * Atomic within the single-threaded event loop: there is no `await` between
   * reading the existing entry and writing the new one, so two concurrent
   * reservations of the same nonce cannot both observe it absent.
   */
  async reserve(peerId: string, nonce: string, ttlSec: number): Promise<boolean> {
    const key = InMemoryNonceStore.key(peerId, nonce);
    const now = Date.now();
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.sweep();
    this.entries.set(key, now + ttlSec * 1000);
    return true;
  }

  private sweep(): void {
    if (this.entries.size < this.sweepAt) return;
    const now = Date.now();
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
}

export interface SignParams {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  /** RFC 9421 `keyid` — the instance's publicKeyMultibase ({@link InstanceKey}.keyId). */
  keyId: string;
  /** Ed25519 sign handle (WebCrypto). */
  privateKey: CryptoKey;
  /** Unix seconds; defaults to now. */
  created?: number;
  /** Unix seconds; defaults to created + {@link EXPIRES_WINDOW_SEC}. */
  expires?: number;
  /** Defaults to a fresh random UUID per signature. */
  nonce?: string;
  /** Defaults to {@link FEDERATION_TAG}. */
  tag?: string;
  isResponse?: boolean;
  /** Required when `isResponse` — covered as `@status`. */
  status?: number;
  /**
   * Extra response header names to add to the covered components — for a
   * bodyless response (e.g. a 304) whose only meaningful field beyond `@status`
   * is a header like `etag`, so that header is bound by the signature and a
   * MITM cannot tamper it. Each name must already be present in `headers`.
   */
  coverHeaders?: string[];
}

export interface VerifyResult {
  ok: boolean;
  keyId?: string;
  reason?: FederationFailureReason;
}

export interface VerifyParams {
  method: string;
  url: string;
  status?: number;
  headers: Record<string, string>;
  body?: Uint8Array;
  isResponse?: boolean;
  /** Resolves an RFC 9421 `keyid` to an Ed25519 verify handle, or null if unknown. */
  resolvePublicKey: (keyId: string) => Promise<CryptoKey | null>;
  /** Per-peer replay cache; the peer is keyed by `keyid`. */
  nonceStore: NonceStore;
  /** Verification clock in Unix seconds; defaults to now. */
  now?: number;
}

const ED25519 = { name: "Ed25519" } as const;
const SIGNATURE_NAME = "oc";

/**
 * Neutralizes the library's own wall-clock created/expires checks so this
 * module's replay policy (which honours the injectable `now`) is the single
 * time authority. 100 years, in seconds.
 */
const LIB_TIME_CHECKS_OFF_SEC = 100 * 365 * 24 * 60 * 60;

const SUPPORTED_DIGESTS: Record<string, string> = {
  "sha-256": "SHA-256",
  "sha-512": "SHA-512",
};

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

async function contentDigestValue(body: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", body as BufferSource);
  return `sha-256=:${Buffer.from(digest).toString("base64")}:`;
}

/**
 * Signs a federated HTTP message per RFC 9421 with Ed25519, returning the full
 * header set to send: the input headers plus Content-Digest (when a body is
 * present), Signature-Input, and Signature.
 *
 * Covered components — requests: `@method`, `@target-uri`, plus `content-type`
 * (when present alongside a body) and `content-digest` (when a body is
 * present); responses: `@status` plus the same content components, plus any
 * `coverHeaders` (e.g. `etag` on a bodyless 304). Signature parameters:
 * `created`, `expires`, `keyid`, `nonce`, `tag`.
 */
export async function signMessage(p: SignParams): Promise<{ headers: Record<string, string> }> {
  if (p.isResponse && typeof p.status !== "number") {
    throw new TypeError("signMessage: a response signature requires a status");
  }
  const created = p.created ?? Math.floor(Date.now() / 1000);
  const expires = p.expires ?? created + EXPIRES_WINDOW_SEC;
  const nonce = p.nonce ?? globalThis.crypto.randomUUID();
  const tag = p.tag ?? FEDERATION_TAG;

  const headers: Record<string, string> = { ...p.headers };
  const hasBody = p.body !== undefined && p.body.byteLength > 0;
  if (hasBody) headers["Content-Digest"] = await contentDigestValue(p.body as Uint8Array);

  const fields = p.isResponse ? ["@status"] : ["@method", "@target-uri"];
  if (hasBody) {
    if (findHeader(headers, "content-type") !== undefined) fields.push("content-type");
    fields.push("content-digest");
  }
  for (const name of p.coverHeaders ?? []) {
    const lower = name.toLowerCase();
    if (findHeader(headers, lower) === undefined) {
      throw new TypeError(`signMessage: coverHeaders["${name}"] is not present in headers`);
    }
    if (!fields.includes(lower)) fields.push(lower);
  }

  const config = {
    key: {
      id: p.keyId,
      alg: "ed25519",
      sign: async (data: Buffer) =>
        Buffer.from(
          await globalThis.crypto.subtle.sign(ED25519, p.privateKey, new Uint8Array(data)),
        ),
    },
    name: SIGNATURE_NAME,
    fields,
    params: ["created", "expires", "keyid", "nonce", "tag"],
    paramValues: {
      created: new Date(created * 1000),
      expires: new Date(expires * 1000),
      nonce,
      tag,
    },
  };

  const signed = p.isResponse
    ? await httpbis.signMessage(config, { status: p.status as number, headers })
    : await httpbis.signMessage(config, { method: p.method, url: p.url, headers });

  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(signed.headers)) {
    flattened[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return { headers: flattened };
}

async function digestMatchesBody(headerValue: string, body: Uint8Array): Promise<boolean> {
  let dictionary: ReturnType<typeof parseDictionary>;
  try {
    dictionary = parseDictionary(headerValue);
  } catch {
    return false;
  }
  let checked = 0;
  for (const [algorithm, member] of dictionary) {
    const webCryptoName = SUPPORTED_DIGESTS[algorithm];
    if (!webCryptoName) continue;
    const value = member[0];
    if (!(value instanceof ArrayBuffer)) return false;
    const expected = await globalThis.crypto.subtle.digest(webCryptoName, body as BufferSource);
    if (!Buffer.from(expected).equals(Buffer.from(value))) return false;
    checked += 1;
  }
  return checked > 0;
}

interface ParsedSignatureInput {
  /** The signature's label in the Signature/Signature-Input dictionaries. */
  label: string;
  fields: string[];
  created?: number;
  expires?: number;
  keyId?: string;
  nonce?: string;
  tag?: string;
}

function parseSignatureInputs(headerValue: string): ParsedSignatureInput[] | null {
  let dictionary: ReturnType<typeof parseDictionary>;
  try {
    dictionary = parseDictionary(headerValue);
  } catch {
    return null;
  }
  const inputs: ParsedSignatureInput[] = [];
  for (const [label, member] of dictionary) {
    if (!isInnerList(member)) continue;
    const [items, params] = member as InnerList;
    const str = (name: string): string | undefined => {
      const value = params.get(name);
      return typeof value === "string" ? value : undefined;
    };
    const num = (name: string): number | undefined => {
      const value = params.get(name);
      return typeof value === "number" ? value : undefined;
    };
    inputs.push({
      label,
      fields: items.map(([bare]) => String(bare)),
      created: num("created"),
      expires: num("expires"),
      keyId: str("keyid"),
      nonce: str("nonce"),
      tag: str("tag"),
    });
  }
  return inputs;
}

/**
 * Whether the covered-component set is strong enough to bind the message.
 * Requests must cover `@method` plus either `@target-uri` (which subsumes
 * scheme/authority/path/query) or, if signing pseudo-headers individually,
 * `@authority` + `@path` + `@query` together — covering `@authority` + `@path`
 * alone would leave the query string unsigned, which a MITM could tamper with.
 * Responses must cover `@status`.
 */
function coversRequiredComponents(input: ParsedSignatureInput, p: VerifyParams): boolean {
  if (p.isResponse) return input.fields.includes("@status");
  const f = input.fields;
  if (!f.includes("@method")) return false;
  if (f.includes("@target-uri")) return true;
  return f.includes("@authority") && f.includes("@path") && f.includes("@query");
}

/**
 * Rewrites the Signature and Signature-Input dictionaries down to the single
 * `label`, so the library can only verify the one signature whose parameters
 * this module already policy-checked — binding the verified signature to the
 * policy-checked one. Returns null if either header is missing/unparseable or
 * does not carry that label.
 */
function restrictToLabel(
  headers: Record<string, string>,
  label: string,
): Record<string, string> | null {
  const inputName = Object.keys(headers).find((k) => k.toLowerCase() === "signature-input");
  const sigName = Object.keys(headers).find((k) => k.toLowerCase() === "signature");
  if (inputName === undefined || sigName === undefined) return null;
  let inputDict: ReturnType<typeof parseDictionary>;
  let sigDict: ReturnType<typeof parseDictionary>;
  try {
    inputDict = parseDictionary(headers[inputName]);
    sigDict = parseDictionary(headers[sigName]);
  } catch {
    return null;
  }
  const inputEntry = inputDict.get(label);
  const sigEntry = sigDict.get(label);
  if (inputEntry === undefined || sigEntry === undefined) return null;
  return {
    ...headers,
    [inputName]: serializeDictionary(new Map([[label, inputEntry]])),
    [sigName]: serializeDictionary(new Map([[label, sigEntry]])),
  };
}

/**
 * Verifies a federated HTTP message: RFC 9421 Ed25519 signature over the
 * reconstructed base, Content-Digest against the RECEIVED body bytes,
 * created/expires within the window (±{@link CLOCK_SKEW_SEC}), a mandatory
 * unreplayed nonce, the federation tag, and a resolvable keyid. On failure the
 * caller responds 401 with {@link federationFailureHeaders}(reason).
 */
export async function verifyMessage(p: VerifyParams): Promise<VerifyResult> {
  const fail = (reason: FederationFailureReason): VerifyResult => ({ ok: false, reason });
  const now = p.now ?? Math.floor(Date.now() / 1000);
  const hasBody = p.body !== undefined && p.body.byteLength > 0;

  if (hasBody) {
    const digestHeader = findHeader(p.headers, "content-digest");
    if (digestHeader === undefined) return fail("bad-digest");
    if (!(await digestMatchesBody(digestHeader, p.body as Uint8Array))) return fail("bad-digest");
  }

  const signatureInputHeader = findHeader(p.headers, "signature-input");
  const signatureHeader = findHeader(p.headers, "signature");
  if (signatureInputHeader === undefined || signatureHeader === undefined) {
    return fail("bad-signature");
  }
  const inputs = parseSignatureInputs(signatureInputHeader);
  if (inputs === null || inputs.length === 0) return fail("bad-signature");

  const federationInputs = inputs.filter((candidate) => candidate.tag === FEDERATION_TAG);
  // A federation message carries EXACTLY ONE federation-tagged signature. More
  // than one is a policy/verify split: the library returns the last resolvable
  // signature's result while we would policy-check a different (decoy) one.
  if (federationInputs.length > 1) return fail("ambiguous-signature");
  if (federationInputs.length === 0) return fail("tag-mismatch");
  const input = federationInputs[0];

  if (input.created === undefined || input.expires === undefined) return fail("expired");
  if (input.created > now + CLOCK_SKEW_SEC) return fail("expired");
  if (input.expires < now - CLOCK_SKEW_SEC) return fail("expired");

  if (!input.nonce) return fail("missing-nonce");
  if (!input.keyId) return fail("unknown-key");
  const keyId = input.keyId;
  const nonce = input.nonce;

  if (!coversRequiredComponents(input, p)) return fail("insufficient-coverage");
  if (hasBody && !input.fields.includes("content-digest")) return fail("bad-digest");

  const publicKey = await p.resolvePublicKey(keyId);
  if (publicKey === null) return fail("unknown-key");

  if (await p.nonceStore.seen(keyId, nonce)) return fail("replayed");

  // Bind verification to the single policy-checked label: restrict the message
  // to that label's signature so the library cannot verify a different one.
  const restrictedHeaders = restrictToLabel(p.headers, input.label);
  if (restrictedHeaders === null) return fail("bad-signature");

  const verifyConfig = {
    keyLookup: async (params: { keyid?: string; tag?: string }) =>
      params.keyid === keyId && params.tag === FEDERATION_TAG
        ? {
            id: keyId,
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
    tolerance: LIB_TIME_CHECKS_OFF_SEC,
    notAfter: now + LIB_TIME_CHECKS_OFF_SEC,
    all: true,
  };

  let verified: boolean | null;
  try {
    verified = p.isResponse
      ? await httpbis.verifyMessage(verifyConfig, {
          status: p.status as number,
          headers: restrictedHeaders,
        })
      : await httpbis.verifyMessage(verifyConfig, {
          method: p.method,
          url: p.url,
          headers: restrictedHeaders,
        });
  } catch {
    verified = false;
  }
  if (verified !== true) return fail("bad-signature");

  // Atomically claim the nonce only AFTER the signature verifies, so invalid
  // traffic cannot burn a nonce, while closing the check-then-insert race.
  if (!(await reserveNonce(p.nonceStore, keyId, nonce, NONCE_TTL_SEC))) {
    return fail("replayed");
  }
  return { ok: true, keyId };
}
