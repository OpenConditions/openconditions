import {
  type Registry,
  type ReportClaim,
  type SubClaimBody,
  type ValidationIssue,
  validateClaim,
  validateSubClaim,
} from "@openconditions/model";

/**
 * Wire validation for report claims and sub-claim bodies. Every rule here is a
 * signing-time AND verification-time hard rule: signing throws a TypeError,
 * verification surfaces the same message as `{ ok: false, error }`. The
 * claim's shape is the registry's (`validateClaim`, `validateSubClaim`); this
 * module adds what a schema cannot say about bytes that get signed: I-JSON.
 */

/** Signature-envelope fields a signable body must never carry itself. */
export const ENVELOPE_FIELDS = ["alg", "keyId", "pubJwk", "signature"] as const;

/** True when the string contains an unpaired UTF-16 surrogate (not I-JSON). */
function hasLoneSurrogate(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  }
  return false;
}

/** Maximum container nesting depth a claim tree may have. */
const MAX_TREE_DEPTH = 64;

/**
 * Walk a claim tree and enforce I-JSON: finite numbers and well-formed
 * Unicode everywhere (keys included). Values JCS would silently drop or
 * coerce (undefined/symbol array elements, bigint/function/symbol values)
 * are rejected so the signed bytes never diverge from the author's intent;
 * an `undefined` OBJECT member is allowed because JCS deterministically
 * omits it on both the signing and verifying side. Nesting is capped at
 * {@link MAX_TREE_DEPTH} levels so the walk itself can never overflow the
 * stack — a too-deep tree is a TypeError, not a RangeError.
 */
function assertIJsonTree(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_TREE_DEPTH) {
    throw new TypeError(`nesting depth at ${path} exceeds ${MAX_TREE_DEPTH} levels`);
  }
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`non-finite number at ${path}`);
      }
      return;
    case "string":
      if (hasLoneSurrogate(value)) {
        throw new TypeError(`string with a lone surrogate at ${path}`);
      }
      return;
    case "boolean":
    case "undefined":
      return;
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`${typeof value} value at ${path} is not JSON-serializable`);
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const element = value[i] as unknown;
      if (element === undefined || typeof element === "symbol") {
        throw new TypeError(
          `array element at ${path}[${i}] is not JSON-serializable (JCS would coerce it to null)`,
        );
      }
      assertIJsonTree(element, `${path}[${i}]`, depth + 1);
    }
    return;
  }
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (hasLoneSurrogate(key)) {
      throw new TypeError(`object key with a lone surrogate at ${path}`);
    }
    assertIJsonTree(member, `${path}.${key}`, depth + 1);
  }
}

function issuesMessage(label: string, issues: readonly ValidationIssue[]): string {
  const listed = issues.map((i) => `${[label, ...i.path].join(".")}: ${i.message}`);
  return listed.join("; ");
}

/**
 * Validate a report claim: I-JSON first, then the registry's claim schema.
 *
 * @throws TypeError naming every violated rule.
 */
export function assertReportClaim(registry: Registry, claim: unknown): ReportClaim {
  assertIJsonTree(claim, "claim");
  const checked = validateClaim(registry, claim);
  if (!checked.ok) throw new TypeError(issuesMessage("claim", checked.issues));
  return checked.value;
}

/**
 * Validate a sub-claim body. The body must not smuggle envelope fields: they
 * are added by signSubClaim and stripped before verification, so a body
 * carrying them would sign bytes the verifier never reconstructs.
 *
 * @throws TypeError naming every violated rule.
 */
export function assertSubClaimBody(body: unknown): SubClaimBody {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    for (const field of ENVELOPE_FIELDS) {
      if (field in body) {
        throw new TypeError(`subClaim body must not carry the envelope field "${field}"`);
      }
    }
  }
  assertIJsonTree(body, "subClaim");
  const checked = validateSubClaim(body);
  if (!checked.ok) throw new TypeError(issuesMessage("subClaim", checked.issues));
  return checked.value;
}
