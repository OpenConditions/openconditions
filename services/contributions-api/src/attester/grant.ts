/**
 * Reporting grant — a compact HMAC-signed capability the attester hands to an
 * enrolled reporter, later exchanged (not the key itself) at the token
 * endpoint. Format: `base64url(payloadJson) + "." + base64url(mac)` with
 * payload `{ keyId, iat, exp }` (ISO 8601 instants, exp = iat + 24h) and
 * `mac = HMAC-SHA256(utf8(base64url(payloadJson)), GRANT_SECRET)`.
 *
 * The HMAC is deliberately SYMMETRIC: this service is the only party that
 * ever verifies a grant — grants never leave the instance and federation
 * never sees them. All MAC checks go through `crypto.subtle.verify`, which is
 * a constant-time comparison; grant strings are never compared with `===`.
 */
import { ATTESTER_POLICY } from "./policy.js";

const encoder = new TextEncoder();

const HMAC_PARAMS: HmacImportParams = { name: "HMAC", hash: "SHA-256" };

interface GrantPayload {
  keyId: string;
  iat: string;
  exp: string;
}

export type GrantRefusal = "malformed" | "bad-mac" | "wrong-key" | "expired";

export interface GrantVerification {
  valid: boolean;
  /** Present only on a valid grant: the keyId asserted BY THE GRANT. */
  keyId?: string;
  reason?: GrantRefusal;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function importHmacKey(secret: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", secret as BufferSource, HMAC_PARAMS, false, [
    usage,
  ]);
}

/** Mints a reporting grant for `keyId`, valid from `nowIso` for 24 hours. */
export async function createReportingGrant(
  keyId: string,
  nowIso: string,
  secret: Uint8Array
): Promise<string> {
  const iat = new Date(nowIso);
  const exp = new Date(iat.getTime() + ATTESTER_POLICY.grantTtlMs);
  const payload: GrantPayload = {
    keyId,
    iat: iat.toISOString(),
    exp: exp.toISOString(),
  };
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret, "sign");
  const mac = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload));
  return `${encodedPayload}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * Verifies a reporting grant. The MAC is checked FIRST (constant-time via
 * WebCrypto), then expiry, then — when `expectedKeyId` is given — the key
 * binding. On success the payload's `keyId` is returned so callers derive the
 * key FROM THE GRANT, never from a client-supplied field.
 */
export async function verifyReportingGrant(
  grant: string,
  secret: Uint8Array,
  nowIso: string,
  expectedKeyId?: string
): Promise<GrantVerification> {
  const parts = grant.split(".");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    return { valid: false, reason: "malformed" };
  }
  const [encodedPayload, encodedMac] = parts as [string, string];

  let macBytes: Buffer;
  let payload: GrantPayload;
  try {
    macBytes = Buffer.from(encodedMac, "base64url");
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as GrantPayload;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  const key = await importHmacKey(secret, "verify");
  const macValid = await globalThis.crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(macBytes),
    encoder.encode(encodedPayload)
  );
  if (!macValid) {
    return { valid: false, reason: "bad-mac" };
  }

  if (
    typeof payload.keyId !== "string" ||
    typeof payload.iat !== "string" ||
    typeof payload.exp !== "string"
  ) {
    return { valid: false, reason: "malformed" };
  }
  if (new Date(nowIso).getTime() > new Date(payload.exp).getTime()) {
    return { valid: false, reason: "expired" };
  }
  if (expectedKeyId !== undefined && payload.keyId !== expectedKeyId) {
    return { valid: false, reason: "wrong-key" };
  }
  return { valid: true, keyId: payload.keyId };
}

/**
 * Resolves the grant secret from the environment.
 *
 * - `OPENCONDITIONS_GRANT_SECRET` set (non-empty): its UTF-8 bytes.
 * - Unset in production (`NODE_ENV=production`): THROWS — fail closed, the
 *   service must not start with restart-scoped grants in production.
 * - Unset elsewhere: a random ephemeral secret is generated and `warn` is
 *   called loudly — every outstanding grant dies on restart, which is an
 *   acceptable dev default. The secret VALUE is never logged.
 */
export function resolveGrantSecret(
  env: Record<string, string | undefined>,
  warn: (msg: string) => void
): Uint8Array {
  const configured = env["OPENCONDITIONS_GRANT_SECRET"];
  if (configured !== undefined && configured !== "") {
    return encoder.encode(configured);
  }
  if (env["NODE_ENV"] === "production") {
    throw new Error(
      "OPENCONDITIONS_GRANT_SECRET is required in production: refusing to start with an ephemeral grant secret (fail closed)"
    );
  }
  warn(
    "OPENCONDITIONS_GRANT_SECRET is not set; generated an EPHEMERAL grant secret — every reporting grant dies on restart. Set the env var for anything beyond local development."
  );
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}
