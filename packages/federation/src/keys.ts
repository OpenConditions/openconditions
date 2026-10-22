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
 * A key is valid for {@link INSTANCE_KEY_VALIDITY_MONTHS}; once the newest
 * has less than {@link KEY_ROTATION_LEAD_DAYS} left, {@link maintainInstanceKey}
 * rotates it. The new key is ENDORSED by the key before it, which signs the new
 * key's id ({@link verifyEndorsement}), so a peer that pinned only the old key
 * learns the new one from the Actor document, which serves every key valid
 * now with its endorsement. The new key is served for
 * {@link KEY_PUBLICATION_LEAD_DAYS} before it signs ({@link signingKeyOf}), so
 * every peer has read it by then, and the old key stays valid through a
 * {@link ROTATION_OVERLAP_DAYS} overlap. A key minted after every key expired
 * is endorsed by the last one all the same: no key but the first is one a
 * peer has no way to trust.
 */
import type postgres from "postgres";
import { multibaseFromRawEd25519, rawEd25519FromMultibase } from "./multibase.js";

/** Default instance key validity, in calendar months. */
export const INSTANCE_KEY_VALIDITY_MONTHS = 6;

/** Minimum old-key overlap after a rotation, in days. */
export const ROTATION_OVERLAP_DAYS = 30;

/** A key is rotated once the newest has less than this many days left. */
export const KEY_ROTATION_LEAD_DAYS = 30;

/** How long a new key is served before it signs, in days. */
export const KEY_PUBLICATION_LEAD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The previous key's signature over a key's id. */
export interface KeyEndorsement {
  /** The endorsing key's id (its publicKeyMultibase). */
  by: string;
  /** Its Ed25519 signature over {@link endorsementMessage}, base64url. */
  signature: string;
}

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
  /** Absent only for an instance's first key. */
  endorsement?: KeyEndorsement;
}

interface InstanceKeyRow {
  key_id: string;
  public_key: Buffer;
  private_key: Buffer;
  multibase: string;
  not_before: Date;
  not_after: Date;
  endorsed_by: string | null;
  endorsement: Buffer | null;
}

/** Calendar-month addition in UTC (JS Date end-of-month overflow semantics). */
function addMonths(base: Date, months: number): Date {
  const result = new Date(base.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

const ED25519 = { name: "Ed25519" } as const;

/** The bytes an endorsement signs: a fixed context and the endorsed key's id. */
export function endorsementMessage(keyId: string): Uint8Array {
  return new TextEncoder().encode(`openconditions-federation key endorsement\n${keyId}`);
}

/** Whether `endorsement` is its key's valid signature over `keyId`. */
export async function verifyEndorsement(
  keyId: string,
  endorsement: KeyEndorsement,
): Promise<boolean> {
  try {
    const endorser = await globalThis.crypto.subtle.importKey(
      "raw",
      rawEd25519FromMultibase(endorsement.by) as BufferSource,
      ED25519,
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      ED25519,
      endorser,
      Buffer.from(endorsement.signature, "base64url"),
      endorsementMessage(keyId) as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * Generates a fresh Ed25519 instance keypair via WebCrypto, valid from `now`
 * for `validityMonths`, endorsed by `endorser` when one is given. Pure —
 * persistence is {@link maintainInstanceKey} / {@link rotateInstanceKey}'s job.
 */
export async function generateInstanceKey(
  now: string,
  validityMonths = INSTANCE_KEY_VALIDITY_MONTHS,
  endorser?: Pick<InstanceKey, "keyId" | "privateKey">,
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
    await globalThis.crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const publicKeyMultibase = multibaseFromRawEd25519(publicKeyRaw);
  const notBefore = new Date(now);
  const key: InstanceKey = {
    keyId: publicKeyMultibase,
    publicKeyMultibase,
    publicKeyRaw,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    notBefore,
    notAfter: addMonths(notBefore, validityMonths),
  };
  if (endorser !== undefined) {
    const signature = await globalThis.crypto.subtle.sign(
      ED25519,
      endorser.privateKey,
      endorsementMessage(key.keyId) as BufferSource,
    );
    key.endorsement = {
      by: endorser.keyId,
      signature: Buffer.from(signature).toString("base64url"),
    };
  }
  return key;
}

async function insertInstanceKey(
  sql: postgres.Sql | postgres.TransactionSql,
  key: InstanceKey,
  createdAt: string,
): Promise<void> {
  const privatePkcs8 = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("pkcs8", key.privateKey),
  );
  const endorsement =
    key.endorsement === undefined ? null : Buffer.from(key.endorsement.signature, "base64url");
  await sql`
    INSERT INTO conditions.federation_instance_key
      (key_id, public_key, private_key, multibase, not_before, not_after, created_at,
       endorsed_by, endorsement)
    VALUES (${key.keyId}, ${Buffer.from(key.publicKeyRaw)}, ${Buffer.from(privatePkcs8)},
            ${key.publicKeyMultibase}, ${key.notBefore}, ${key.notAfter}, ${new Date(createdAt)},
            ${key.endorsement?.by ?? null}, ${endorsement})
    ON CONFLICT (key_id) DO NOTHING
  `;
}

/**
 * Rehydrates a key row's WebCrypto handles. The stored multibase is
 * recomputed from the raw public key and must match — a mismatch means the
 * row was tampered with or corrupted, and is refused.
 */
async function keyOfRow(row: InstanceKeyRow): Promise<InstanceKey> {
  const publicKeyRaw = new Uint8Array(row.public_key);
  const recomputed = multibaseFromRawEd25519(publicKeyRaw);
  if (recomputed !== row.multibase || row.key_id !== row.multibase) {
    throw new Error(
      `federation_instance_key row ${row.key_id} is inconsistent with its public key bytes`,
    );
  }
  const publicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    publicKeyRaw as BufferSource,
    ED25519,
    true,
    ["verify"],
  );
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(row.private_key) as BufferSource,
    ED25519,
    false,
    ["sign"],
  );
  return {
    keyId: row.key_id,
    publicKeyMultibase: row.multibase,
    publicKeyRaw,
    publicKey,
    privateKey,
    notBefore: row.not_before,
    notAfter: row.not_after,
    ...(row.endorsed_by !== null && row.endorsement !== null
      ? {
          endorsement: {
            by: row.endorsed_by,
            signature: Buffer.from(row.endorsement).toString("base64url"),
          },
        }
      : {}),
  };
}

const KEY_COLUMNS = `key_id, public_key, private_key, multibase, not_before, not_after,
  endorsed_by, endorsement`;

/**
 * Loads every instance key valid at `now` (newest first). During a rotation
 * overlap this returns BOTH keys.
 */
export async function loadActiveKeys(
  sql: postgres.Sql | postgres.TransactionSql,
  now: string,
): Promise<InstanceKey[]> {
  const rows = await sql.unsafe<InstanceKeyRow[]>(
    `SELECT ${KEY_COLUMNS} FROM conditions.federation_instance_key
      WHERE not_before <= $1 AND not_after > $1
      ORDER BY not_before DESC`,
    [new Date(now)],
  );
  return Promise.all(rows.map(keyOfRow));
}

/** The newest key ever stored, valid or not; undefined before the first. */
async function loadLatestKey(sql: postgres.TransactionSql): Promise<InstanceKey | undefined> {
  const [row] = await sql.unsafe<InstanceKeyRow[]>(
    `SELECT ${KEY_COLUMNS} FROM conditions.federation_instance_key
      ORDER BY not_before DESC LIMIT 1`,
  );
  return row === undefined ? undefined : keyOfRow(row);
}

/**
 * The key this instance signs with among `active` (newest first): the newest
 * served for at least {@link KEY_PUBLICATION_LEAD_DAYS}, so peers have read
 * it; else the oldest active one, which peers have known longest.
 */
export function signingKeyOf(active: readonly InstanceKey[], now: string): InstanceKey | undefined {
  const published = Date.parse(now) - KEY_PUBLICATION_LEAD_DAYS * DAY_MS;
  return active.find((key) => key.notBefore.getTime() <= published) ?? active.at(-1);
}

/** The key this instance signs with now; undefined when none is valid. */
export async function loadSigningKey(
  sql: postgres.Sql,
  now: string,
): Promise<InstanceKey | undefined> {
  return signingKeyOf(await loadActiveKeys(sql, now), now);
}

async function rotateIn(
  tx: postgres.TransactionSql,
  now: string,
  validityMonths: number,
): Promise<InstanceKey> {
  const endorser = await loadLatestKey(tx);
  const key = await generateInstanceKey(now, validityMonths, endorser);
  await insertInstanceKey(tx, key, now);
  const at = new Date(now);
  const overlapEnd = new Date(at.getTime() + ROTATION_OVERLAP_DAYS * DAY_MS);
  await tx`
    UPDATE conditions.federation_instance_key
    SET not_after = ${overlapEnd}
    WHERE key_id <> ${key.keyId}
      AND not_before <= ${at} AND not_after > ${at}
      AND not_after < ${overlapEnd}
  `;
  return key;
}

/** Serializes the key lifecycle across processes. */
const lockKeys = (tx: postgres.TransactionSql) =>
  tx`SELECT pg_advisory_xact_lock(hashtext('conditions.federation_instance_key'))`;

/**
 * Rotates the instance key: persists a fresh key valid [now, now + 6 months),
 * endorsed by the newest stored key, and extends every currently active old
 * key's not_after to at least now + {@link ROTATION_OVERLAP_DAYS} days, so old
 * and new stay co-valid (and co-served in the Actor document) through the
 * overlap window. An old key already valid past that point keeps its later
 * expiry. Returns the new key.
 */
export async function rotateInstanceKey(
  sql: postgres.Sql,
  now: string,
  validityMonths = INSTANCE_KEY_VALIDITY_MONTHS,
): Promise<InstanceKey> {
  return sql.begin(async (tx) => {
    await lockKeys(tx);
    return rotateIn(tx, now, validityMonths);
  }) as Promise<InstanceKey>;
}

export type KeyMaintenance =
  | { status: "current"; expiresAt: Date }
  | { status: "created" | "rotated"; key: InstanceKey };

/**
 * Keeps the instance's keys current: the first key on first boot, a rotation
 * once the newest key has less than {@link KEY_ROTATION_LEAD_DAYS} left or
 * none is valid, and nothing otherwise. Idempotent and safe to run from
 * several processes at once.
 */
export async function maintainInstanceKey(sql: postgres.Sql, now: string): Promise<KeyMaintenance> {
  return sql.begin(async (tx) => {
    await lockKeys(tx);
    const [newest] = await loadActiveKeys(tx, now);
    if (
      newest !== undefined &&
      newest.notAfter.getTime() - Date.parse(now) > KEY_ROTATION_LEAD_DAYS * DAY_MS
    ) {
      return { status: "current", expiresAt: newest.notAfter };
    }
    if ((await loadLatestKey(tx)) === undefined) {
      const key = await generateInstanceKey(now);
      await insertInstanceKey(tx, key, now);
      return { status: "created", key };
    }
    return { status: "rotated", key: await rotateIn(tx, now, INSTANCE_KEY_VALIDITY_MONTHS) };
  }) as Promise<KeyMaintenance>;
}
