import {
  INGEST_MAPPING_TARGETS,
  type Mappings,
  type MappingTarget,
  type RegistryEntry,
} from "./define.js";

/** A situation classification; its canonical code is `kind.type[.subtype]`. */
export interface SituationClass {
  kind: string;
  type: string;
  subtype?: string;
}

export function situationCode(c: SituationClass): string {
  return c.subtype === undefined ? `${c.kind}.${c.type}` : `${c.kind}.${c.type}.${c.subtype}`;
}

export function parseSituationCode(code: string): SituationClass {
  const [kind, type, subtype, ...rest] = code.split(".");
  if (!kind || !type || subtype === "" || rest.length > 0) {
    throw new TypeError(`"${code}" is not kind.type[.subtype]`);
  }
  return subtype === undefined ? { kind, type } : { kind, type, subtype };
}

export class CrosswalkError extends Error {}

/** Whether `key` (`type` or `type.subtype`) names a registered type of a kind. */
export function isRegisteredTypeKey(
  types: Readonly<Record<string, readonly string[]>> | undefined,
  key: string,
): boolean {
  const [type, subtype, extra] = key.split(".");
  const subtypes = types?.[type!];
  return (
    subtypes !== undefined &&
    extra === undefined &&
    (subtype === undefined || subtypes.includes(subtype))
  );
}

/**
 * Lookups over the registry's crosswalks, in both directions. Parsers resolve
 * a source code to a classification or a vocabulary value; emitters resolve
 * a classification or a value to a target code.
 */
export interface Crosswalk {
  /** The classification a source code maps to (type- or subtype-level mappings). */
  situation(target: MappingTarget, code: string): SituationClass | undefined;
  /** The value of `vocabulary` a source code maps to. */
  value(vocabulary: string, target: MappingTarget, code: string): string | undefined;
  /** An emitter's code for a classification: the subtype's, else the type's, else the kind's. */
  situationTargetCode(target: MappingTarget, c: SituationClass): string | undefined;
  /** An emitter's code for a vocabulary value. */
  valueTargetCode(vocabulary: string, target: MappingTarget, value: string): string | undefined;
}

type Index<T> = Map<string, T>;

function add<T>(
  index: Index<T>,
  target: MappingTarget,
  code: string,
  value: T,
  same: (a: T, b: T) => boolean,
  where: string,
): void {
  const key = `${target}\u0000${code}`;
  const existing = index.get(key);
  if (existing !== undefined && !same(existing, value)) {
    throw new CrosswalkError(`${where}: ${target} code "${code}" is mapped twice`);
  }
  index.set(key, value);
}

function each(mappings: Mappings | undefined, fn: (target: MappingTarget, code: string) => void) {
  for (const [target, codes] of Object.entries(mappings ?? {}) as [MappingTarget, string[]][]) {
    for (const code of codes) fn(target, code);
  }
}

const ingest = new Set<string>(INGEST_MAPPING_TARGETS);

/**
 * Indexes the crosswalks of a set of registry entries. Throws CrosswalkError
 * when a `typeMappings` key names an unregistered type or subtype, or when a
 * code of a parsed target maps to two different classifications or values.
 */
export function buildCrosswalk(entries: readonly RegistryEntry[]): Crosswalk {
  const situations: Index<SituationClass> = new Map();
  const values: Index<string> = new Map();
  const situationOut = new Map<string, string>();
  const valueOut = new Map<string, string>();
  const sameClass = (a: SituationClass, b: SituationClass) => situationCode(a) === situationCode(b);

  for (const e of entries) {
    if (e.entry === "kind" && e.class === "situation") {
      each(e.mappings, (target, code) => {
        if (!situationOut.has(`${target}\u0000${e.code}`)) {
          situationOut.set(`${target}\u0000${e.code}`, code);
        }
      });
      for (const [key, mappings] of Object.entries(e.typeMappings ?? {})) {
        if (!isRegisteredTypeKey(e.types, key)) {
          throw new CrosswalkError(
            `kind situation:${e.code}: typeMappings key "${key}" is not registered`,
          );
        }
        const [type, subtype] = key.split(".");
        const c: SituationClass =
          subtype === undefined
            ? { kind: e.code, type: type! }
            : { kind: e.code, type: type!, subtype };
        each(mappings, (target, code) => {
          if (ingest.has(target))
            add(situations, target, code, c, sameClass, `kind situation:${e.code}`);
          const outKey = `${target}\u0000${situationCode(c)}`;
          if (!situationOut.has(outKey)) situationOut.set(outKey, code);
        });
      }
    }
    if (e.entry === "vocabulary" || e.entry === "vocabulary_extension") {
      const vocabulary = e.entry === "vocabulary" ? e.code : e.vocabulary;
      for (const [value, mappings] of Object.entries(e.valueMappings ?? {})) {
        each(mappings, (target, code) => {
          if (ingest.has(target)) {
            add(
              values,
              target,
              `${vocabulary}\u0000${code}`,
              value,
              (a, b) => a === b,
              `vocabulary ${vocabulary}`,
            );
          }
          const outKey = `${vocabulary}\u0000${target}\u0000${value}`;
          if (!valueOut.has(outKey)) valueOut.set(outKey, code);
        });
      }
    }
  }

  return {
    situation: (target, code) => situations.get(`${target}\u0000${code}`),
    value: (vocabulary, target, code) => values.get(`${target}\u0000${vocabulary}\u0000${code}`),
    situationTargetCode: (target, c) =>
      situationOut.get(`${target}\u0000${situationCode(c)}`) ??
      situationOut.get(`${target}\u0000${c.kind}.${c.type}`) ??
      situationOut.get(`${target}\u0000${c.kind}`),
    valueTargetCode: (vocabulary, target, value) =>
      valueOut.get(`${vocabulary}\u0000${target}\u0000${value}`),
  };
}
