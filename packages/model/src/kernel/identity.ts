import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { INSTANCE_ID_PATTERN, SOURCE_ID_PATTERN } from "./provenance.js";
import { RECORD_CLASSES, type RecordClass } from "./scalars.js";

/** `oc:<class>:<namespace>:<localId>`; the namespace never contains ":", the local id may. */
export const RECORD_ID_PATTERN =
  /^oc:(feature|situation|observation|offer):([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(.+)$/;

export function isSourceId(value: string): boolean {
  return SOURCE_ID_PATTERN.test(value);
}

export function isInstanceId(value: string): boolean {
  return INSTANCE_ID_PATTERN.test(value);
}

export interface RecordIdParts {
  class: RecordClass;
  namespace: string;
  localId: string;
}

export function formatRecordId(parts: RecordIdParts): string {
  if (!RECORD_CLASSES.includes(parts.class)) throw new TypeError(`unknown class ${parts.class}`);
  if (!INSTANCE_ID_PATTERN.test(parts.namespace)) {
    throw new TypeError(`namespace "${parts.namespace}" is not [a-z0-9.-]+`);
  }
  if (parts.localId.length === 0) throw new TypeError("localId must not be empty");
  return `oc:${parts.class}:${parts.namespace}:${parts.localId}`;
}

/** Splits on the first three ":"; null when the id is not a record id. */
export function parseRecordId(id: string): RecordIdParts | null {
  const m = RECORD_ID_PATTERN.exec(id);
  if (!m) return null;
  return { class: m[1] as RecordClass, namespace: m[2]!, localId: m[3]! };
}

/**
 * Normalises a canonical-id namespace. The final NFC pass keeps the function
 * idempotent: lowercasing a decomposed sequence can produce a pair that
 * composes to a new precomposed character.
 */
export function normalizeNamespace(ns: string): string {
  const normalized = ns.trim().normalize("NFC").toLowerCase().normalize("NFC");
  if (normalized === "") {
    throw new TypeError("namespace must not be empty after normalization");
  }
  return normalized;
}

/**
 * `canonicalId = sha256([namespace, localId])`. JSON.stringify of an
 * array of strings is byte-deterministic and free of separator ambiguity
 * ("a:b"+"c" vs "a"+"b:c" must not collide).
 */
export function canonicalIdOf(namespace: string, localId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([normalizeNamespace(namespace), localId]), "utf8")
    .digest("hex");
}

/** RFC 8785 (JCS) canonical JSON text. */
export function jcs(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new TypeError("value is not JSON-serializable");
  return text;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
