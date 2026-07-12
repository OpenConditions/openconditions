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

export interface GenerateIssuerKeyOptions {
  notBefore?: string;
  notAfter?: string;
}

/**
 * Generates a fresh 2048-bit Blind-RSA (PSS) issuer keypair and persists it.
 * Returns the key id only — private material stays in the database row.
 */
export async function generateIssuerKey(
  sql: postgres.Sql,
  nowIso: string,
  options: GenerateIssuerKeyOptions = {}
): Promise<{ keyId: string }> {
  const pair = await Issuer.generateKey(BlindRSAMode.PSS, {
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  });
  const privatePkcs8 = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey)
  );
  const publicSpki = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("spki", pair.publicKey)
  );
  const published = await getPublicKeyBytes(pair.publicKey);
  const keyId = toHex(await sha256(published));

  const notBefore = new Date(options.notBefore ?? nowIso);
  const notAfter =
    options.notAfter !== undefined
      ? new Date(options.notAfter)
      : new Date(notBefore.getTime() + ISSUER_KEY_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  await sql`
    INSERT INTO conditions.issuer_key (key_id, public_key, private_key, not_before, not_after)
    VALUES (${keyId}, ${Buffer.from(publicSpki)}, ${Buffer.from(privatePkcs8)},
            ${notBefore}, ${notAfter})
    ON CONFLICT (key_id) DO NOTHING
  `;
  return { keyId };
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
