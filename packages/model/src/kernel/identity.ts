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

/**
 * A publisher's own id as the local part of a record id. A line break, which
 * a record id cannot hold, is written percent-encoded; every other character
 * is kept.
 */
export const recordLocalId = (id: string): string =>
  id.replace(/[\n\r\p{Zl}\p{Zp}]/gu, encodeURIComponent);

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

/** A UTF-16 surrogate without its pair: with the `u` flag a paired one is a single code point. */
const LONE_SURROGATE = /\p{Surrogate}/u;
const LONE_SURROGATES = /\p{Surrogate}/gu;

/**
 * A JSON value with every unpaired surrogate in its strings and keys
 * replaced by U+FFFD, as `String.prototype.toWellFormed` replaces it. Source
 * text carries them now and then (a truncated emoji, a `\udc00` escape); JCS
 * and PostgreSQL refuse them, so one such string would otherwise fail the
 * hash of its record and with it the write of a whole poll. A value without
 * any is returned as it is, so the common case copies nothing.
 */
export function wellFormed<T>(value: T): T {
  if (typeof value === "string") {
    return (LONE_SURROGATE.test(value) ? value.replace(LONE_SURROGATES, "�") : value) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item = wellFormed(value[i]);
      if (item === value[i]) continue;
      out ??= [...value];
      out[i] = item;
    }
    return (out ?? value) as T;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }
  let out: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const fixedKey = wellFormed(key);
    const fixed = wellFormed(item);
    if (fixedKey === key && fixed === item) continue;
    const copy: Record<string, unknown> = out ?? { ...(value as Record<string, unknown>) };
    out = copy;
    if (fixedKey !== key) delete copy[key];
    // Defined, not assigned: a source key `__proto__` stays an own member.
    Object.defineProperty(copy, fixedKey, {
      value: fixed,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return (out ?? value) as T;
}

/** RFC 8785 (JCS) canonical JSON text, of the value's well-formed text ({@link wellFormed}). */
export function jcs(value: unknown): string {
  const text = canonicalize(wellFormed(value));
  if (text === undefined) throw new TypeError("value is not JSON-serializable");
  return text;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
