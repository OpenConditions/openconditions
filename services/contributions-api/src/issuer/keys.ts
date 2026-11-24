/**
 * Issuer keypair lifecycle for the publicly verifiable Blind-RSA token type
 * (RFC 9578, token type 0x0002) via @cloudflare/privacypass-ts.
 *
 * Keys live in conditions.issuer_key (an operator-secret table): the private
 * key as PKCS#8, sealed with the instance's secrets key, the public key as
 * WebCrypto SPKI. Clients receive the RSASSA-PSS-OID form of the public key
 * (what `Client.createTokenRequest` expects); its SHA-256 is the RFC 9578
 * token key id. Rotation = a new row with an overlapping [not_before,
 * not_after) window — redemption accepts any key valid at redemption time.
 * Key MATERIAL is never logged.
 */

import { publicVerif } from "@cloudflare/privacypass-ts";
import {
  assertStoredSecretsOpen,
  type SecretPlace,
  type SecretsKey,
  type SecretTable,
  storedSecret,
} from "@openconditions/core/server";
import type postgres from "postgres";

const { BLIND_RSA, BlindRSAMode, Issuer, getPublicKeyBytes } = publicVerif;

/** TokenChallenge issuer name; override per instance via OPENCONDITIONS_ISSUER_NAME. */
export const DEFAULT_ISSUER_NAME = "contributions.openconditions.org";

/** Issuer key validity window written at generation time. */
export const ISSUER_KEY_VALIDITY_DAYS = 90;

/** The issuer keys' table and the secret it stores sealed. */
export const ISSUER_KEY_SECRETS: SecretTable = {
  table: "issuer_key",
  rowKey: "key_id",
  columns: ["private_key"],
};

const privateKeyPlace = (keyId: string): SecretPlace => ({
  table: ISSUER_KEY_SECRETS.table,
  column: "private_key",
  row: keyId,
});

/** An issuer key's public half, which redemption and the published key list need. */
export interface IssuerPublicKey {
  /** SHA-256 hex of the published (RSASSA-PSS SPKI) public key bytes. */
  keyId: string;
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

/** An issuer key that signs: its public half and the Issuer holding its private key. */
export interface ActiveIssuerKey extends IssuerPublicKey {
  issuer: InstanceType<typeof Issuer>;
}

interface IssuerKeyRow {
  key_id: string;
  public_key: Buffer;
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
  notAfter: Date,
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
  secrets: SecretsKey,
  nowIso: string,
  options: GenerateIssuerKeyOptions = {},
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
        `unable to generate an issuer key with a non-colliding truncated token key id after ${maxAttempts} attempts`,
      );
    }

    const privatePkcs8 = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey),
    );
    const publicSpki = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("spki", pair.publicKey),
    );

    const sealed = secrets.seal(privatePkcs8, privateKeyPlace(keyId));
    privatePkcs8.fill(0);
    await tx`
      INSERT INTO conditions.issuer_key
        (key_id, public_key, private_key_ciphertext, private_key_iv, private_key_tag,
         not_before, not_after)
      VALUES (${keyId}, ${Buffer.from(publicSpki)}, ${Buffer.from(sealed.ciphertext)},
              ${Buffer.from(sealed.iv)}, ${Buffer.from(sealed.tag)}, ${notBefore}, ${notAfter})
      ON CONFLICT (key_id) DO NOTHING
    `;
    return { keyId };
  });
}

async function publicKeyOf(row: IssuerKeyRow): Promise<IssuerPublicKey> {
  const publicKey = await globalThis.crypto.subtle.importKey(
    "spki",
    new Uint8Array(row.public_key),
    BLIND_RSA.rsaParams,
    true,
    ["verify"],
  );
  const publicKeyBytes = await getPublicKeyBytes(publicKey);
  const tokenKeyId = await sha256(publicKeyBytes);
  return {
    keyId: row.key_id,
    publicKey,
    publicKeyBytes,
    tokenKeyId,
    truncatedTokenKeyId: tokenKeyId[tokenKeyId.length - 1]!,
    notBefore: row.not_before,
    notAfter: row.not_after,
  };
}

/**
 * The public half of every issuer key valid at `nowIso` (newest first): what
 * redemption verifies against and the published key list serves. Reads no
 * private key.
 */
export async function loadIssuerPublicKeys(
  sql: postgres.Sql,
  nowIso: string,
): Promise<IssuerPublicKey[]> {
  const now = new Date(nowIso);
  const rows = await sql<IssuerKeyRow[]>`
    SELECT key_id, public_key, not_before, not_after
    FROM conditions.issuer_key
    WHERE not_before <= ${now} AND not_after > ${now}
    ORDER BY not_before DESC
  `;
  return Promise.all(rows.map(publicKeyOf));
}

/**
 * Loads every issuer key valid at `nowIso` (newest first), opens its private
 * key with `secrets` and rehydrates the WebCrypto handles + privacypass-ts
 * Issuer for each.
 */
export async function loadActiveIssuerKeys(
  sql: postgres.Sql | postgres.TransactionSql,
  secrets: SecretsKey,
  nowIso: string,
  issuerName: string,
): Promise<ActiveIssuerKey[]> {
  const now = new Date(nowIso);
  const rows = await sql<(IssuerKeyRow & postgres.Row)[]>`
    SELECT key_id, public_key, private_key_ciphertext, private_key_iv, private_key_tag,
           not_before, not_after
    FROM conditions.issuer_key
    WHERE not_before <= ${now} AND not_after > ${now}
    ORDER BY not_before DESC
  `;
  return Promise.all(
    rows.map(async (row) => {
      const place = privateKeyPlace(row.key_id);
      const sealed = storedSecret(row, place);
      if (sealed === null)
        throw new Error(`conditions.issuer_key ${row.key_id} has no private key`);
      const pkcs8 = secrets.open(sealed, place);
      const privateKey = await globalThis.crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(pkcs8),
        BLIND_RSA.rsaParams,
        true,
        ["sign"],
      );
      pkcs8.fill(0);
      const key = await publicKeyOf(row);
      return {
        ...key,
        issuer: new Issuer(BlindRSAMode.PSS, issuerName, privateKey, key.publicKey),
      };
    }),
  );
}

/**
 * Opens every stored issuer private key under `secrets`, expired ones too,
 * so a key that is not the one they were sealed with stops the start with a
 * "wrong key" error naming the key id.
 */
export function assertIssuerKeysOpen(sql: postgres.Sql, secrets: SecretsKey): Promise<void> {
  return assertStoredSecretsOpen(sql, secrets, ISSUER_KEY_SECRETS);
}

/**
 * First-boot bootstrap: loads the currently valid keys and generates one when
 * none exists yet.
 */
export async function ensureIssuerKeys(
  sql: postgres.Sql,
  secrets: SecretsKey,
  nowIso: string,
  issuerName: string,
): Promise<ActiveIssuerKey[]> {
  const existing = await loadActiveIssuerKeys(sql, secrets, nowIso, issuerName);
  if (existing.length > 0) return existing;
  await generateIssuerKey(sql, secrets, nowIso);
  return loadActiveIssuerKeys(sql, secrets, nowIso, issuerName);
}
