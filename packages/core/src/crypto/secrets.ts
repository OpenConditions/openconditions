import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { type CredentialEnv, readCredential } from "../credentials.js";

/**
 * The variable that holds the key every OpenConditions service encrypts its
 * stored secrets with (OAuth grant tokens and private keys). Under OpenMapX it
 * is a vault secret, mounted as a file named by `OPENCONDITIONS_SECRETS_KEY_FILE`.
 */
export const SECRETS_KEY_VARIABLE = "OPENCONDITIONS_SECRETS_KEY";

/** The AES-256-GCM IV length, in bytes. */
export const SECRET_IV_BYTES = 12;

/** The AES-256-GCM authentication tag length, in bytes. */
export const SECRET_TAG_BYTES = 16;

const KEY_FORMAT = `${SECRETS_KEY_VARIABLE} must be 64 hexadecimal characters (a 32-byte key; generate one with \`openssl rand -hex 32\`)`;

/** A secret as it is stored: its AES-256-GCM ciphertext, IV and authentication tag. */
export interface SealedSecret {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/**
 * Where a secret is stored: the table, the secret's column (without the
 * `_ciphertext` suffix) and the row's primary key. It is bound to the
 * ciphertext as additional authenticated data, so a value copied to another
 * row or column does not open.
 */
export interface SecretPlace {
  table: string;
  column: string;
  row: string;
}

/** The secrets key is missing or not a key. */
export class SecretsKeyError extends Error {
  override name = "SecretsKeyError";
}

/**
 * A stored secret does not open under the configured key: the key is not
 * the one that sealed it, or the stored value was altered.
 */
export class WrongSecretsKeyError extends Error {
  override name = "WrongSecretsKeyError";
}

const where = (place: SecretPlace) =>
  `conditions.${place.table}.${place.column} of the row ${place.row}`;

const additionalData = (place: SecretPlace) =>
  Buffer.from(JSON.stringify(["conditions", place.table, place.column, place.row]), "utf8");

/**
 * The key OpenConditions encrypts its stored secrets with (AES-256-GCM). The
 * key bytes live in a private field and are never printed or serialized.
 */
export class SecretsKey {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  /** The key written as 64 hexadecimal characters; surrounding whitespace is ignored. */
  static parse(text: string): SecretsKey {
    const hex = text.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new SecretsKeyError(KEY_FORMAT);
    return new SecretsKey(Buffer.from(hex, "hex"));
  }

  /** Encrypts `plaintext` for storage at `place`, under a fresh random IV. */
  seal(plaintext: Uint8Array | string, place: SecretPlace): SealedSecret {
    const iv = randomBytes(SECRET_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv, {
      authTagLength: SECRET_TAG_BYTES,
    });
    cipher.setAAD(additionalData(place));
    const bytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  /**
   * Decrypts a secret stored at `place`. Throws a {@link WrongSecretsKeyError}
   * naming the place, never a value, when it does not open.
   */
  open(sealed: SealedSecret, place: SecretPlace): Buffer {
    if (sealed.iv.length !== SECRET_IV_BYTES) {
      throw new Error(
        `${where(place)} is malformed: its IV is ${sealed.iv.length} bytes, not ${SECRET_IV_BYTES}`,
      );
    }
    if (sealed.tag.length !== SECRET_TAG_BYTES) {
      throw new Error(
        `${where(place)} is malformed: its tag is ${sealed.tag.length} bytes, not ${SECRET_TAG_BYTES}`,
      );
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, sealed.iv, {
      authTagLength: SECRET_TAG_BYTES,
    });
    decipher.setAAD(additionalData(place));
    decipher.setAuthTag(sealed.tag);
    try {
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    } catch {
      throw new WrongSecretsKeyError(
        `wrong key: ${SECRETS_KEY_VARIABLE} cannot decrypt ${where(place)}; it is not the key that encrypted it, or the stored value was altered`,
      );
    }
  }

  /** {@link open}, as UTF-8 text. */
  openText(sealed: SealedSecret, place: SecretPlace): string {
    return this.open(sealed, place).toString("utf8");
  }

  toJSON(): string {
    return "[SecretsKey]";
  }

  toString(): string {
    return "[SecretsKey]";
  }
}

/**
 * The secrets key from `OPENCONDITIONS_SECRETS_KEY`, else from the file
 * `OPENCONDITIONS_SECRETS_KEY_FILE` names (how OpenMapX mounts a vault
 * secret), trimmed. Throws a {@link SecretsKeyError} when neither is set, the
 * file yields nothing, or the value is not a key, so a service that stores
 * secrets refuses to start without one.
 */
export function secretsKeyFromEnv(env: CredentialEnv): SecretsKey {
  const read = readCredential(env, SECRETS_KEY_VARIABLE);
  if ("failure" in read) throw new SecretsKeyError(read.failure);
  if ("unset" in read) {
    throw new SecretsKeyError(
      `${SECRETS_KEY_VARIABLE} is required: set ${SECRETS_KEY_VARIABLE}_FILE to a file holding it (64 hexadecimal characters). Every OpenConditions service of an instance uses the key the ingest service holds; only the ingest service's is generated, with \`openssl rand -hex 32\`.`,
    );
  }
  return SecretsKey.parse(read.value);
}
