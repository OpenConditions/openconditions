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

/** A feature classification: the kind, and its type and subtype when the kind has types. */
export interface FeatureClass {
  kind: string;
  type?: string;
  subtype?: string;
}

/** `kind[.type[.subtype]]`. */
export function featureCode(c: FeatureClass): string {
  return [c.kind, c.type, c.subtype].filter((p) => p !== undefined).join(".");
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
  /** The feature classification a source code maps to (kind-, type- or subtype-level mappings). */
  feature(target: MappingTarget, code: string): FeatureClass | undefined;
  /** The value of `vocabulary` a source code maps to. */
  value(vocabulary: string, target: MappingTarget, code: string): string | undefined;
  /** An emitter's code for a classification: the subtype's, else the type's, else the kind's. */
  situationTargetCode(target: MappingTarget, c: SituationClass): string | undefined;
  /** An emitter's code for a feature classification: the subtype's, else the type's, else the kind's. */
  featureTargetCode(target: MappingTarget, c: FeatureClass): string | undefined;
  /**
   * An emitter's code for a vocabulary value. A value several modules map
   * (a shared kernel vocabulary) has a code per source enumeration; name the
   * enumeration to get its code (`travelTimeTrendType` → `travelTimeTrendType:increasing`).
   */
  valueTargetCode(
    vocabulary: string,
    target: MappingTarget,
    value: string,
    enumeration?: string,
  ): string | undefined;
  /** The property a source's measured-value code maps to (DATEX `TrafficSpeed/averageVehicleSpeed`). */
  property(target: MappingTarget, code: string): string | undefined;
  /** An emitter's code for a property. */
  propertyTargetCode(target: MappingTarget, property: string): string | undefined;
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
  const valueOut = new Map<string, string[]>();
  const sameClass = (a: SituationClass, b: SituationClass) => situationCode(a) === situationCode(b);
  const features: Index<FeatureClass> = new Map();
  const featureOut = new Map<string, string>();
  const sameFeature = (a: FeatureClass, b: FeatureClass) => featureCode(a) === featureCode(b);
  const properties: Index<string> = new Map();
  const propertyOut = new Map<string, string>();

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
    if (e.entry === "kind" && e.class === "feature") {
      const where = `kind feature:${e.code}`;
      const rows: [FeatureClass, Mappings | undefined][] = [[{ kind: e.code }, e.mappings]];
      for (const [key, mappings] of Object.entries(e.typeMappings ?? {})) {
        if (!isRegisteredTypeKey(e.types, key)) {
          throw new CrosswalkError(`${where}: typeMappings key "${key}" is not registered`);
        }
        const [type, subtype] = key.split(".");
        rows.push([
          subtype === undefined ? { kind: e.code, type } : { kind: e.code, type, subtype },
          mappings,
        ]);
      }
      for (const [c, mappings] of rows) {
        each(mappings, (target, code) => {
          if (ingest.has(target)) add(features, target, code, c, sameFeature, where);
          const outKey = `${target}\u0000${featureCode(c)}`;
          if (!featureOut.has(outKey)) featureOut.set(outKey, code);
        });
      }
    }
    if (e.entry === "property") {
      each(e.mappings, (target, code) => {
        if (ingest.has(target))
          add(properties, target, code, e.code, (a, b) => a === b, `property ${e.code}`);
        const outKey = `${target}\u0000${e.code}`;
        if (!propertyOut.has(outKey)) propertyOut.set(outKey, code);
      });
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
          const codes = valueOut.get(outKey) ?? [];
          if (!codes.includes(code)) valueOut.set(outKey, [...codes, code]);
        });
      }
    }
  }

  return {
    situation: (target, code) => situations.get(`${target}\u0000${code}`),
    feature: (target, code) => features.get(`${target}\u0000${code}`),
    value: (vocabulary, target, code) => values.get(`${target}\u0000${vocabulary}\u0000${code}`),
    situationTargetCode: (target, c) =>
      situationOut.get(`${target}\u0000${situationCode(c)}`) ??
      situationOut.get(`${target}\u0000${c.kind}.${c.type}`) ??
      situationOut.get(`${target}\u0000${c.kind}`),
    featureTargetCode: (target, c) =>
      featureOut.get(`${target}\u0000${featureCode(c)}`) ??
      (c.type === undefined ? undefined : featureOut.get(`${target}\u0000${c.kind}.${c.type}`)) ??
      featureOut.get(`${target}\u0000${c.kind}`),
    valueTargetCode: (vocabulary, target, value, enumeration) => {
      const codes = valueOut.get(`${vocabulary}\u0000${target}\u0000${value}`) ?? [];
      return enumeration === undefined
        ? codes[0]
        : codes.find((c) => c.startsWith(`${enumeration}:`));
    },
    property: (target, code) => properties.get(`${target}\u0000${code}`),
    propertyTargetCode: (target, property) => propertyOut.get(`${target}\u0000${property}`),
  };
}
