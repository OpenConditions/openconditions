/**
 * Issuer keypair lifecycle for the publicly verifiable Blind-RSA token type
 * (RFC 9578, token type 0x0002) via @cloudflare/privacypass-ts.
 *
 * Keys live in conditions.issuer_key (an operator-secret table): the private
 * key as PKCS#8, the public key as WebCrypto SPKI. Clients receive the
 * RSASSA-PSS-OID form of the public key (what `Client.createTokenRequest`
 * expects); its SHA-256 is the RFC 9578 token key id. Rotation = a new row
 * with an overlapping [not_before, not_after) window — redemption accepts any
 * key valid at redemption time. Key MATERIAL is never logged.
 */
import type postgres from "postgres";
import { publicVerif } from "@cloudflare/privacypass-ts";

const { BLIND_RSA, BlindRSAMode, Issuer, getPublicKeyBytes } = publicVerif;

/** TokenChallenge issuer name; override per instance via OPENCONDITIONS_ISSUER_NAME. */
export const DEFAULT_ISSUER_NAME = "contributions.openconditions.org";

/** Issuer key validity window written at generation time. */
export const ISSUER_KEY_VALIDITY_DAYS = 90;

export interface ActiveIssuerKey {
  /** SHA-256 hex of the published (RSASSA-PSS SPKI) public key bytes. */
  keyId: string;
  issuer: InstanceType<typeof Issuer>;
  publicKey: CryptoKey;
  /** Public key bytes in the form clients blind against. */
  publicKeyBytes: Uint8Array;
  /** 32-byte RFC 9578 token key id (SHA-256 of publicKeyBytes). */
  tokenKeyId: Uint8Array;
  /** Last byte of tokenKeyId, as carried in a TokenRequest. */
  truncatedTokenKeyId: number;
  notBefore: Date;
  notAfter: Date;
}

interface IssuerKeyRow {
  key_id: string;
  public_key: Buffer;
  private_key: Buffer;
  not_before: Date;
  not_after: Date;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Default bound on keypair regenerations when avoiding a truncated-id clash. */
export const DEFAULT_MAX_KEY_GEN_ATTEMPTS = 64;

/**
 * Fixed application-defined key for the transaction-scoped Postgres advisory
 * lock that serializes issuer-key generation across connections AND process
 * instances. `generateIssuerKey` reads the reserved truncated-byte set, then
 * inserts; without a lock two concurrent generations (most realistically two
 * API instances both bootstrapping via `ensureIssuerKeys` on first boot, or a
 * future concurrent rotation) can each read the reserved set BEFORE the other
 * inserts and independently pick the same free byte, persisting two
 * overlapping-window keys that share a truncated token key id — the exact
 * issuance ambiguity the regenerate loop exists to prevent. Taking this lock as
 * the first statement of the generation transaction makes read-check-insert
 * atomic cluster-wide; `pg_advisory_xact_lock` releases automatically at
 * transaction end (commit or rollback). The constant is chosen once and must
 * never change (it is the ASCII bytes of "OCIK" — OpenConditions Issuer Key).
 */
export const ISSUER_KEY_GEN_ADVISORY_LOCK = 0x4f43494b;

export interface GenerateIssuerKeyOptions {
  notBefore?: string;
  notAfter?: string;
  /**
   * Test seam: source of keypairs, defaulting to a fresh 2048-bit Blind-RSA
   * (PSS) pair. Production never sets this.
   */
  generateKeyPair?: () => Promise<CryptoKeyPair>;
  /** Bound on regenerations before failing closed. */
  maxKeyGenAttempts?: number;
}

/**
 * Truncated token key ids (the single byte a TokenRequest carries) of every
 * stored key whose validity window overlaps `[notBefore, notAfter)`.
 *
 * The truncated id is the last byte of the 32-byte token key id, which is
 * `sha256(publicKeyBytes)`; `key_id` is the hex of that same digest, so its
 * last hex byte IS the truncated id — no key import needed.
 */
export async function overlappingTruncatedKeyIds(
  sql: postgres.Sql | postgres.TransactionSql,
  notBefore: Date,
  notAfter: Date
): Promise<Set<number>> {
  const rows = await sql<{ key_id: string }[]>`
    SELECT key_id FROM conditions.issuer_key
    WHERE not_before < ${notAfter} AND not_after > ${notBefore}
  `;
  return new Set(rows.map((row) => parseInt(row.key_id.slice(-2), 16)));
}

async function generatePair(): Promise<CryptoKeyPair> {
  return Issuer.generateKey(BlindRSAMode.PSS, {
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  });
}

/**
 * Generates a fresh 2048-bit Blind-RSA (PSS) issuer keypair and persists it.
 * Returns the key id only — private material stays in the database row.
 *
 * A TokenRequest names its issuer key by only the LAST byte of the token key
 * id (RFC 9578 is lossy by design), so two simultaneously-active keys sharing
 * that byte would make key selection at issuance ambiguous. This regenerates
 * the keypair until its truncated byte is free among all keys whose validity
 * window overlaps the new one, and fails closed rather than persist a clash.
 */
export async function generateIssuerKey(
  sql: postgres.Sql,
  nowIso: string,
  options: GenerateIssuerKeyOptions = {}
): Promise<{ keyId: string }> {
  const notBefore = new Date(options.notBefore ?? nowIso);
  const notAfter =
    options.notAfter !== undefined
      ? new Date(options.notAfter)
      : new Date(notBefore.getTime() + ISSUER_KEY_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  const generate = options.generateKeyPair ?? generatePair;
  const maxAttempts = options.maxKeyGenAttempts ?? DEFAULT_MAX_KEY_GEN_ATTEMPTS;

  // Serialize the whole read-reserved → regenerate-loop → insert sequence with a
  // transaction-scoped advisory lock so it is atomic across connections and API
  // instances: no two concurrent generations can each observe a stale reserved
  // set and persist overlapping-window keys sharing a truncated token key id.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${ISSUER_KEY_GEN_ADVISORY_LOCK})`;

    const reserved = await overlappingTruncatedKeyIds(tx, notBefore, notAfter);

    let pair: CryptoKeyPair | undefined;
    let keyId: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = await generate();
      const candidatePublished = await getPublicKeyBytes(candidate.publicKey);
      const candidateDigest = await sha256(candidatePublished);
      const truncated = candidateDigest[candidateDigest.length - 1]!;
      if (!reserved.has(truncated)) {
        pair = candidate;
        keyId = toHex(candidateDigest);
        break;
      }
    }
    if (pair === undefined || keyId === undefined) {
      throw new Error(
        `unable to generate an issuer key with a non-colliding truncated token key id after ${maxAttempts} attempts`
      );
    }

    const privatePkcs8 = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey)
    );
    const publicSpki = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("spki", pair.publicKey)
    );

    await tx`
      INSERT INTO conditions.issuer_key (key_id, public_key, private_key, not_before, not_after)
      VALUES (${keyId}, ${Buffer.from(publicSpki)}, ${Buffer.from(privatePkcs8)},
              ${notBefore}, ${notAfter})
      ON CONFLICT (key_id) DO NOTHING
    `;
    return { keyId };
  });
}

/**
 * Loads every issuer key valid at `nowIso` (newest first) and rehydrates the
 * WebCrypto handles + privacypass-ts Issuer for each.
 */
export async function loadActiveIssuerKeys(
  sql: postgres.Sql,
  nowIso: string,
  issuerName: string
): Promise<ActiveIssuerKey[]> {
  const now = new Date(nowIso);
  const rows = await sql<IssuerKeyRow[]>`
    SELECT key_id, public_key, private_key, not_before, not_after
    FROM conditions.issuer_key
    WHERE not_before <= ${now} AND not_after > ${now}
    ORDER BY not_before DESC
  `;
  return Promise.all(
    rows.map(async (row) => {
      const privateKey = await globalThis.crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(row.private_key),
        BLIND_RSA.rsaParams,
        true,
        ["sign"]
      );
      const publicKey = await globalThis.crypto.subtle.importKey(
        "spki",
        new Uint8Array(row.public_key),
        BLIND_RSA.rsaParams,
        true,
        ["verify"]
      );
      const publicKeyBytes = await getPublicKeyBytes(publicKey);
      const tokenKeyId = await sha256(publicKeyBytes);
      return {
        keyId: row.key_id,
        issuer: new Issuer(BlindRSAMode.PSS, issuerName, privateKey, publicKey),
        publicKey,
        publicKeyBytes,
        tokenKeyId,
        truncatedTokenKeyId: tokenKeyId[tokenKeyId.length - 1]!,
        notBefore: row.not_before,
        notAfter: row.not_after,
      };
    })
  );
}

/**
 * First-boot bootstrap: loads the currently valid keys and generates one when
 * none exists yet.
 */
export async function ensureIssuerKeys(
  sql: postgres.Sql,
  nowIso: string,
  issuerName: string
): Promise<ActiveIssuerKey[]> {
  const existing = await loadActiveIssuerKeys(sql, nowIso, issuerName);
  if (existing.length > 0) return existing;
  await generateIssuerKey(sql, nowIso);
  return loadActiveIssuerKeys(sql, nowIso, issuerName);
}
