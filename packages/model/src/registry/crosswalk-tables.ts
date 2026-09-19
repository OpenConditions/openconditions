import { parseSituationCode } from "./crosswalk.js";
import {
  extendVocabulary,
  type KindEntry,
  type Mappings,
  type MappingTarget,
  type PropertyEntry,
  type VocabularyExtensionEntry,
} from "./define.js";

/** A parsed source's codes → our codes or vocabulary values (`null` = nothing to add). */
export type SourceTable = Readonly<Record<string, string | null>>;
/** Our codes or vocabulary values → an emitter's codes (`null` = not representable). */
export type TargetTable = Readonly<Record<string, string | null>>;

export interface SourceCrosswalk {
  target: MappingTarget;
  table: SourceTable;
  /** Restricts the table to the codes this target version knows (DATEX v2 vs v3). */
  include?: (code: string) => boolean;
}

export interface TargetCrosswalk {
  target: MappingTarget;
  table: TargetTable;
}

type Collected = Map<string, { mappings: Mappings; typeMappings: Record<string, Mappings> }>;

function addCode(m: Mappings, target: MappingTarget, code: string) {
  const codes = (m as Record<string, string[]>)[target] ?? [];
  (m as Record<string, string[]>)[target] = codes;
  if (!codes.includes(code)) codes.push(code);
}

function push(into: Record<string, Mappings>, key: string, target: MappingTarget, code: string) {
  const m = into[key] ?? {};
  into[key] = m;
  addCode(m, target, code);
}

function eachRow(
  sources: readonly SourceCrosswalk[],
  targets: readonly TargetCrosswalk[],
  add: (ours: string, target: MappingTarget, code: string) => void,
) {
  for (const { target, table, include } of sources) {
    for (const [code, ours] of Object.entries(table)) {
      if (ours !== null && (include?.(code) ?? true)) add(ours, target, code);
    }
  }
  for (const { target, table } of targets) {
    for (const [ours, code] of Object.entries(table)) {
      if (code !== null) add(ours, target, code);
    }
  }
}

/**
 * Attaches crosswalks to situation kinds: every source table entry becomes a
 * `typeMappings` code of the classification it names, every emitter table
 * entry the target code of that classification. The tables stay the single
 * source of truth; the kinds only carry what the tables say.
 */
export function withSituationCrosswalks<K extends KindEntry>(
  kinds: readonly K[],
  sources: readonly SourceCrosswalk[],
  targets: readonly TargetCrosswalk[],
): K[] {
  const collected: Collected = new Map();
  eachRow(sources, targets, (situation, target, code) => {
    const c = parseSituationCode(situation);
    const entry = collected.get(c.kind) ?? { mappings: {}, typeMappings: {} };
    collected.set(c.kind, entry);
    push(
      entry.typeMappings,
      c.subtype === undefined ? c.type : `${c.type}.${c.subtype}`,
      target,
      code,
    );
  });
  return kinds.map((k) => {
    const c = collected.get(k.code);
    return c === undefined ? k : { ...k, typeMappings: c.typeMappings };
  });
}

/**
 * Attaches crosswalks to feature kinds. Table values are `kind`,
 * `kind.type` or `kind.type.subtype`: a kind-level code lands in the kind's
 * `mappings`, a finer one in its `typeMappings`.
 */
export function withFeatureCrosswalks<K extends KindEntry>(
  kinds: readonly K[],
  sources: readonly SourceCrosswalk[],
  targets: readonly TargetCrosswalk[],
): K[] {
  const collected: Collected = new Map();
  eachRow(sources, targets, (feature, target, code) => {
    const [kind, ...rest] = feature.split(".");
    const entry = collected.get(kind!) ?? { mappings: {}, typeMappings: {} };
    collected.set(kind!, entry);
    if (rest.length === 0) addCode(entry.mappings, target, code);
    else push(entry.typeMappings, rest.join("."), target, code);
  });
  return kinds.map((k) => {
    const c = collected.get(k.code);
    if (c === undefined) return k;
    return {
      ...k,
      ...(Object.keys(c.mappings).length > 0 ? { mappings: c.mappings } : {}),
      ...(Object.keys(c.typeMappings).length > 0 ? { typeMappings: c.typeMappings } : {}),
    };
  });
}

/** Attaches measured-value crosswalks to properties: table values are property codes. */
export function withPropertyCrosswalks<P extends PropertyEntry>(
  properties: readonly P[],
  sources: readonly SourceCrosswalk[],
  targets: readonly TargetCrosswalk[],
): P[] {
  const collected: Record<string, Mappings> = {};
  eachRow(sources, targets, (property, target, code) => push(collected, property, target, code));
  return properties.map((p) => {
    const m = collected[p.code];
    return m === undefined ? p : { ...p, mappings: m };
  });
}

/**
 * A `SourceCrosswalk.include` over per-class path lists (DATEX measured
 * values): `Class` matches a listed class, `Class/path` a listed path of it.
 */
export function inClassPaths(paths: Readonly<Record<string, readonly string[]>>) {
  return (code: string): boolean => {
    const [cls, ...path] = code.split("/");
    const listed = paths[cls!];
    return listed !== undefined && (path.length === 0 || listed.includes(path.join("/")));
  };
}

/** A mapping-only extension of a vocabulary built from source and emitter tables. */
export function vocabularyCrosswalk(
  vocabulary: string,
  sources: readonly SourceCrosswalk[],
  targets: readonly TargetCrosswalk[],
): VocabularyExtensionEntry {
  const valueMappings: Record<string, Mappings> = {};
  eachRow(sources, targets, (value, target, code) => push(valueMappings, value, target, code));
  return extendVocabulary({ vocabulary, values: [], valueMappings });
}
