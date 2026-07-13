/**
 * Ed25519 INSTANCE key lifecycle for federation (instances, not users).
 *
 * Keys live in conditions.federation_instance_key: the raw 32-byte public key,
 * the private key as PKCS#8, and the publicKeyMultibase served in the Actor
 * document. The private key is an operator secret — persisted to the operator
 * database only, never served, never logged, never federated. Unlike
 * contrib-core's device-bound reporter keys, instance private keys are
 * generated extractable BY DESIGN: they must round-trip through the database
 * across restarts.
 *
 * Rotation = a new row whose [not_before, not_after) window overlaps the old
 * key's by at least {@link ROTATION_OVERLAP_DAYS}, so verifiers that pinned or
 * cached the old key keep verifying while the new one propagates; the Actor
 * document serves every key valid "now". The signed key-rotation EVENT
 * (chaining a new key to the previous one) is the federation wire protocol's
 * concern — this module only guarantees the storage overlap window.
 */
import type postgres from "postgres";
import { multibaseFromRawEd25519 } from "./multibase.js";

/** Default instance key validity, in calendar months. */
export const INSTANCE_KEY_VALIDITY_MONTHS = 6;

/** Minimum old-key overlap after a rotation, in days. */
export const ROTATION_OVERLAP_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A federated instance signing identity. */
export interface InstanceKey {
  /** Stable id — the publicKeyMultibase itself (self-describing multikey). */
  keyId: string;
  /** Multikey/did:key form ("z6Mk…") served in the Actor document. */
  publicKeyMultibase: string;
  /** Raw 32-byte Ed25519 public key. */
  publicKeyRaw: Uint8Array;
  /** Ed25519 verify handle. */
  publicKey: CryptoKey;
  /** Ed25519 sign handle. NEVER served, logged, or federated. */
  privateKey: CryptoKey;
  notBefore: Date;
  notAfter: Date;
}

interface InstanceKeyRow {
  key_id: string;
  public_key: Buffer;
  private_key: Buffer;
  multibase: string;
  not_before: Date;
  not_after: Date;
}

/** Calendar-month addition in UTC (JS Date end-of-month overflow semantics). */
function addMonths(base: Date, months: number): Date {
  const result = new Date(base.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

const ED25519 = { name: "Ed25519" } as const;

/**
 * Generates a fresh Ed25519 instance keypair via WebCrypto, valid from `now`
 * for `validityMonths`. Pure — persistence is {@link ensureInstanceKey} /
 * {@link rotateInstanceKey}'s job.
 */
export async function generateInstanceKey(
  now: string,
  validityMonths = INSTANCE_KEY_VALIDITY_MONTHS
): Promise<InstanceKey> {
  if (Number.isNaN(new Date(now).getTime())) {
    throw new TypeError(`now must be a valid ISO 8601 timestamp, got ${JSON.stringify(now)}`);
  }
  if (!Number.isFinite(validityMonths) || validityMonths <= 0) {
    throw new TypeError("validityMonths must be a positive number (a key must be valid at all)");
  }
  const pair = (await globalThis.crypto.subtle.generateKey(ED25519, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", pair.publicKey)
  );
  const publicKeyMultibase = multibaseFromRawEd25519(publicKeyRaw);
  const notBefore = new Date(now);
  return {
    keyId: publicKeyMultibase,
    publicKeyMultibase,
    publicKeyRaw,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    notBefore,
    notAfter: addMonths(notBefore, validityMonths),
  };
}

async function insertInstanceKey(
  sql: postgres.Sql,
  key: InstanceKey,
  createdAt: string
): Promise<void> {
  const privatePkcs8 = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("pkcs8", key.privateKey)
  );
  await sql`
    INSERT INTO conditions.federation_instance_key
      (key_id, public_key, private_key, multibase, not_before, not_after, created_at)
    VALUES (${key.keyId}, ${Buffer.from(key.publicKeyRaw)}, ${Buffer.from(privatePkcs8)},
            ${key.publicKeyMultibase}, ${key.notBefore}, ${key.notAfter}, ${new Date(createdAt)})
    ON CONFLICT (key_id) DO NOTHING
  `;
}

/**
 * Loads every instance key valid at `now` (newest first) and rehydrates the
 * WebCrypto handles. During a rotation overlap this returns BOTH keys. The
 * stored multibase is recomputed from the raw public key and must match — a
 * mismatch means the row was tampered with or corrupted, and is refused.
 */
export async function loadActiveKeys(sql: postgres.Sql, now: string): Promise<InstanceKey[]> {
  const at = new Date(now);
  const rows = await sql<InstanceKeyRow[]>`
    SELECT key_id, public_key, private_key, multibase, not_before, not_after
    FROM conditions.federation_instance_key
    WHERE not_before <= ${at} AND not_after > ${at}
    ORDER BY not_before DESC
  `;
  return Promise.all(
    rows.map(async (row) => {
      const publicKeyRaw = new Uint8Array(row.public_key);
      const recomputed = multibaseFromRawEd25519(publicKeyRaw);
      if (recomputed !== row.multibase || row.key_id !== row.multibase) {
        throw new Error(
          `federation_instance_key row ${row.key_id} is inconsistent with its public key bytes`
        );
      }
      const publicKey = await globalThis.crypto.subtle.importKey(
        "raw",
        publicKeyRaw as BufferSource,
        ED25519,
        true,
        ["verify"]
      );
      const privateKey = await globalThis.crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(row.private_key) as BufferSource,
        ED25519,
        false,
        ["sign"]
      );
      return {
        keyId: row.key_id,
        publicKeyMultibase: row.multibase,
        publicKeyRaw,
        publicKey,
        privateKey,
        notBefore: row.not_before,
        notAfter: row.not_after,
      };
    })
  );
}

/**
 * First-boot bootstrap: generates and persists one instance key when none is
 * valid at `now`. Idempotent — a second call with an active key is a no-op.
 */
export async function ensureInstanceKey(sql: postgres.Sql, now: string): Promise<void> {
  const active = await loadActiveKeys(sql, now);
  if (active.length > 0) return;
  await insertInstanceKey(sql, await generateInstanceKey(now), now);
}

/**
 * Rotates the instance key: persists a fresh key valid [now, now + 6 months)
 * and extends every currently active old key's not_after to at least
 * now + {@link ROTATION_OVERLAP_DAYS} days, so old and new stay co-valid (and
 * co-served in the Actor document) through the overlap window. An old key
 * already valid past that point keeps its later expiry. Returns the new key.
 */
export async function rotateInstanceKey(
  sql: postgres.Sql,
  now: string,
  validityMonths = INSTANCE_KEY_VALIDITY_MONTHS
): Promise<InstanceKey> {
  const key = await generateInstanceKey(now, validityMonths);
  await insertInstanceKey(sql, key, now);
  const at = new Date(now);
  const overlapEnd = new Date(at.getTime() + ROTATION_OVERLAP_DAYS * DAY_MS);
  await sql`
    UPDATE conditions.federation_instance_key
    SET not_after = ${overlapEnd}
    WHERE key_id <> ${key.keyId}
      AND not_before <= ${at} AND not_after > ${at}
      AND not_after < ${overlapEnd}
  `;
  return key;
}
