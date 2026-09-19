import {
  extendVocabulary,
  type KindEntry,
  type Mappings,
  type MappingTarget,
  parseSituationCode,
  type VocabularyExtensionEntry,
} from "@openconditions/model";

/** A parsed source's codes → our situation codes or vocabulary values (`null` = nothing to add). */
export type SourceTable = Readonly<Record<string, string | null>>;
/** Our situation codes or vocabulary values → an emitter's codes (`null` = not representable). */
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

function push(into: Record<string, Mappings>, key: string, target: MappingTarget, code: string) {
  const m = (into[key] ?? {}) as Record<string, string[]>;
  into[key] = m;
  const codes = m[target] ?? [];
  m[target] = codes;
  if (!codes.includes(code)) codes.push(code);
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
  const add = (situation: string, target: MappingTarget, code: string) => {
    const c = parseSituationCode(situation);
    const entry = collected.get(c.kind) ?? { mappings: {}, typeMappings: {} };
    collected.set(c.kind, entry);
    push(
      entry.typeMappings,
      c.subtype === undefined ? c.type : `${c.type}.${c.subtype}`,
      target,
      code,
    );
  };
  for (const { target, table, include } of sources) {
    for (const [code, situation] of Object.entries(table)) {
      if (situation !== null && (include?.(code) ?? true)) add(situation, target, code);
    }
  }
  for (const { target, table } of targets) {
    for (const [situation, code] of Object.entries(table)) {
      if (code !== null) add(situation, target, code);
    }
  }
  return kinds.map((k) => {
    const c = collected.get(k.code);
    return c === undefined ? k : { ...k, typeMappings: c.typeMappings };
  });
}

/** A mapping-only extension of a vocabulary built from source and emitter tables. */
export function vocabularyCrosswalk(
  vocabulary: string,
  sources: readonly SourceCrosswalk[],
  targets: readonly TargetCrosswalk[],
): VocabularyExtensionEntry {
  const valueMappings: Record<string, Mappings> = {};
  for (const { target, table, include } of sources) {
    for (const [code, value] of Object.entries(table)) {
      if (value !== null && (include?.(code) ?? true)) push(valueMappings, value, target, code);
    }
  }
  for (const { target, table } of targets) {
    for (const [value, code] of Object.entries(table)) {
      if (code !== null) push(valueMappings, value, target, code);
    }
  }
  return extendVocabulary({ vocabulary, values: [], valueMappings });
}
