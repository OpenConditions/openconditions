import type { z } from "zod";
import { RECORD_CLASSES, type RecordClass } from "../kernel/scalars.js";
import type { Registry, ValidationIssue } from "./build.js";
import { majorOf, type SchemaVersion } from "./define.js";

/** One versioned schema of a registry: the kernel, a kind, a property, an effect, a selector or a result. */
export interface SchemaEntry {
  class: "kernel" | RecordClass | "effect" | "selector" | "result";
  code: string;
  version: SchemaVersion;
}

/** `kernel`, or `<class>/<code>`: what a version is the version of. */
export const schemaKey = (e: Pick<SchemaEntry, "class" | "code">) =>
  e.class === "kernel" ? "kernel" : `${e.class}/${e.code}`;

/** Every versioned schema a registry holds, in key order. */
export function schemaEntries(registry: Registry): SchemaEntry[] {
  const entries: SchemaEntry[] = [
    { class: "kernel", code: "kernel", version: registry.kernelVersion as SchemaVersion },
  ];
  for (const k of registry.kinds()) {
    if (k.class !== "component") entries.push({ class: k.class, code: k.code, version: k.version });
  }
  for (const p of registry.properties())
    entries.push({ class: "observation", code: p.code, version: p.version });
  for (const e of registry.effects())
    entries.push({ class: "effect", code: e.code, version: e.version });
  for (const s of registry.selectors())
    entries.push({ class: "selector", code: s.code, version: s.version });
  for (const r of registry.resultSchemas())
    entries.push({ class: "result", code: r.code, version: r.version });
  return entries.sort((a, b) => schemaKey(a).localeCompare(schemaKey(b)));
}

/**
 * The schema versions an instance advertises (`capabilities.schemaVersions`):
 * `kernel@1.0`, `situation/incident@1.2`, `observation/fuel.price@1.0`, …
 */
export function schemaVersions(registry: Registry): string[] {
  return schemaEntries(registry).map((e) => `${schemaKey(e)}@${e.version}`);
}

/** Splits an advertised `<key>@<major>.<minor>`; undefined when it is not one. */
export function parseSchemaVersion(
  value: string,
): { key: string; major: number; minor: number } | undefined {
  const match = /^(.+)@([1-9]\d*)\.(\d+)$/.exec(value);
  if (match === null) return undefined;
  return { key: match[1]!, major: Number(match[2]), minor: Number(match[3]) };
}

function versionMap(advertised: readonly string[]): Map<string, { major: number; minor: number }> {
  const map = new Map<string, { major: number; minor: number }>();
  for (const value of advertised) {
    const parsed = parseSchemaVersion(value);
    if (parsed !== undefined) map.set(parsed.key, { major: parsed.major, minor: parsed.minor });
  }
  return map;
}

/**
 * The schemas two instances can exchange: every key both advertise at the same
 * major, as `<key>@<major>` (minors differ compatibly). Two instances on
 * different kernel majors share nothing, so the result is empty.
 */
export function sharedSchemaMajors(local: readonly string[], peer: readonly string[]): string[] {
  const mine = versionMap(local);
  const theirs = versionMap(peer);
  if (mine.get("kernel")?.major !== theirs.get("kernel")?.major || !mine.has("kernel")) return [];
  return [...mine]
    .filter(([key, v]) => theirs.get(key)?.major === v.major)
    .map(([key, v]) => `${key}@${v.major}`)
    .sort();
}

export type Admission =
  | { admitted: true; record: Record<string, unknown>; stripped: readonly string[] }
  | { admitted: false; skipped: string }
  | { admitted: false; issues: readonly ValidationIssue[] };

/** The schemas a record is built from: its own, the kernel's, and its effects', selectors' and result's. */
function schemasOf(record: Record<string, unknown>, key: string): string[] {
  const keys = ["kernel", key];
  for (const e of (record["effects"] as { kind?: string }[] | undefined) ?? []) {
    if (typeof e?.kind === "string") keys.push(`effect/${e.kind}`);
  }
  for (const s of Object.keys((record["affects"] as object | undefined) ?? {}))
    keys.push(`selector/${s}`);
  const result = record["result"] as { type?: string; schema?: string } | undefined;
  if (result?.type === "structured" && typeof result.schema === "string")
    keys.push(`result/${result.schema}`);
  return keys;
}

function without(value: unknown, path: readonly PropertyKey[], keys: readonly string[]): unknown {
  if (value === null || typeof value !== "object") return value;
  if (path.length === 0) {
    if (Array.isArray(value)) return value;
    const copy = { ...(value as Record<string, unknown>) };
    for (const k of keys) delete copy[k];
    return copy;
  }
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    return value.map((v, i) => (i === head ? without(v, rest, keys) : v));
  }
  const obj = value as Record<string, unknown>;
  return { ...obj, [head as string]: without(obj[head as string], rest, keys) };
}

/**
 * Whether a peer's stored record may be kept here, and as what. A record of a
 * kind or property this registry does not register, or whose schema the peer
 * runs at another major, is skipped, never rejected: peers on other registries
 * are normal. A peer on a newer minor may send fields this registry does not
 * know yet; when the peer advertises a newer minor of a schema the record is
 * built from, those fields are dropped and the rest is validated as usual.
 * An effect kind or an `affects` selector this registry does not know is not
 * such a field, and anything else that fails validation is rejected.
 */
export function admitRecord(
  registry: Registry,
  peerVersions: readonly string[],
  record: unknown,
): Admission {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return {
      admitted: false,
      issues: [{ path: [], code: "invalid_type", message: "a record is an object" }],
    };
  }
  const rec = record as Record<string, unknown>;
  const cls = rec["class"] as RecordClass;
  if (!(RECORD_CLASSES as readonly string[]).includes(cls)) {
    return { admitted: false, skipped: `unknown class ${String(cls)}` };
  }
  const code = (cls === "observation" ? rec["property"] : rec["kind"]) as string;
  const key = `${cls}/${code}`;
  const local = versionMap(schemaVersions(registry));
  const peer = versionMap(peerVersions);
  if (local.get("kernel")?.major !== peer.get("kernel")?.major) {
    return { admitted: false, skipped: "the peer runs another kernel major" };
  }
  const mine = local.get(key);
  if (mine === undefined) return { admitted: false, skipped: `${key} is not registered here` };
  const theirs = peer.get(key);
  if (theirs === undefined || theirs.major !== mine.major) {
    return { admitted: false, skipped: `the peer does not run ${key}@${mine.major}` };
  }
  for (const k of schemasOf(rec, key)) {
    const [l, p] = [local.get(k), peer.get(k)];
    if (l !== undefined && p !== undefined && p.major !== l.major) {
      return { admitted: false, skipped: `the peer does not run ${k}@${l.major}` };
    }
  }
  const newer = schemasOf(rec, key).some((k) => {
    const [l, p] = [local.get(k), peer.get(k)];
    return l !== undefined && p !== undefined && p.major === l.major && p.minor > l.minor;
  });
  const schema = registry.recordSchema(cls, code, "stored") as z.ZodType;
  let candidate: unknown = rec;
  const stripped: string[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const checked = registry.validate(candidate);
    if (checked.ok) return { admitted: true, record: checked.value, stripped: stripped.sort() };
    const parsed = schema.safeParse(candidate);
    const unknown = parsed.success
      ? []
      : parsed.error.issues.filter((i) => i.code === "unrecognized_keys");
    // A selector key under `affects` names a schema this registry does not run, not a newer
    // minor's field: dropping it would silently change what the situation affects.
    const selector = unknown.some((i) => i.path.length === 1 && i.path[0] === "affects");
    if (!newer || unknown.length === 0 || selector) {
      return { admitted: false, issues: checked.issues };
    }
    for (const issue of unknown) {
      const keys = (issue as { keys: string[] }).keys;
      candidate = without(candidate, issue.path, keys);
      for (const k of keys) stripped.push([...issue.path.map(String), k].join("."));
    }
  }
  return {
    admitted: false,
    issues: [{ path: [], code: "too_deep", message: "too many unknown fields" }],
  };
}
