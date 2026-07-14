/**
 * TUF signing keys bridged from the T1 Ed25519 WebCrypto material.
 *
 * TUF metadata carries keys as hex-encoded raw Ed25519 public keys and
 * signatures as hex over the canonical-JSON form of the signed portion — all
 * of that is @tufjs/models' job. This module only adapts a WebCrypto keypair
 * into what the library expects: a `Key` model for authorization lists and a
 * synchronous `sign` callback for `Metadata.sign`. The key id is the standard
 * TUF derivation (SHA-256 over the canonical JSON of the public key object),
 * matching python-tuf and go-tuf repository tooling.
 */
import { canonicalize } from "@tufjs/canonical-json";
import { Key, Signature } from "@tufjs/models";
import { KeyObject, createHash, sign as signWithNodeCrypto } from "node:crypto";

const ED25519 = { name: "Ed25519" } as const;
const KEY_TYPE = "ed25519";
const SCHEME = "ed25519";

/** A TUF signing identity: the public `Key` model plus a sign callback. */
export interface TufSigner {
  /** TUF key id — SHA-256 over the canonical JSON of the public key object. */
  keyId: string;
  /** Hex-encoded raw 32-byte Ed25519 public key (the TUF keyval). */
  publicKeyHex: string;
  /** The @tufjs/models Key to place in root's key/role authorization lists. */
  key: Key;
  /** Signs canonical-JSON bytes for {@link Metadata.sign}. */
  sign: (data: Buffer) => Signature;
}

/** Derives the standard TUF key id for a raw Ed25519 public key. */
export function tufKeyIdFromPublicKeyHex(publicKeyHex: string): string {
  const keyJson = { keytype: KEY_TYPE, scheme: SCHEME, keyval: { public: publicKeyHex } };
  return createHash("sha256").update(canonicalize(keyJson)).digest("hex");
}

/**
 * Builds a TUF signer from existing Ed25519 WebCrypto material — the shape
 * matches the T1 {@link InstanceKey} (`publicKeyRaw` + `privateKey`), so an
 * instance key can double as a TUF role key without re-exporting secrets. The
 * private key handle may be non-extractable; signing goes through node:crypto
 * via `KeyObject.from`, which never needs the raw private bytes.
 */
export function tufSignerFromKeyPair(pair: {
  publicKeyRaw: Uint8Array;
  privateKey: CryptoKey;
}): TufSigner {
  const publicKeyHex = Buffer.from(pair.publicKeyRaw).toString("hex");
  const keyId = tufKeyIdFromPublicKeyHex(publicKeyHex);
  const key = new Key({
    keyID: keyId,
    keyType: KEY_TYPE,
    scheme: SCHEME,
    keyVal: { public: publicKeyHex },
  });
  const privateKeyObject = KeyObject.from(pair.privateKey);
  return {
    keyId,
    publicKeyHex,
    key,
    sign: (data: Buffer) =>
      new Signature({
        keyID: keyId,
        sig: signWithNodeCrypto(null, data, privateKeyObject).toString("hex"),
      }),
  };
}

/** Generates a fresh Ed25519 TUF signing key (TEST/CI keys — see tuf/repo.ts). */
export async function generateTufSigner(): Promise<TufSigner> {
  const pair = (await globalThis.crypto.subtle.generateKey(ED25519, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", pair.publicKey)
  );
  return tufSignerFromKeyPair({ publicKeyRaw, privateKey: pair.privateKey });
}
