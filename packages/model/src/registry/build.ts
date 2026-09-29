import { z } from "zod";
import { componentSchema, featureSchema } from "../classes/feature.js";
import { observationSchema, resultSchemaFor } from "../classes/observation.js";
import { offerSchema } from "../classes/offer.js";
import { situationSchema } from "../classes/situation.js";
import { buildKernelBase } from "../kernel/build.js";
import type { Effect, Kernel } from "../kernel/effect-type.js";
import { KERNEL_VERSION } from "../kernel/module.js";
import type { Stage } from "../kernel/record-base.js";
import { RECORD_CLASSES, type RecordClass } from "../kernel/scalars.js";
import { enumOf } from "../kernel/vocab.js";
import {
  buildCrosswalk,
  type Crosswalk,
  CrosswalkError,
  isRegisteredTypeKey,
} from "./crosswalk.js";
import {
  type ChangeKindEntry,
  type DomainEntry,
  type EffectEntry,
  type KindClass,
  type KindEntry,
  type LinkingRules,
  type Mappings,
  majorOf,
  type PropertyEntry,
  type RegistryModule,
  type ResultSchemaEntry,
  type SelectorEntry,
} from "./define.js";

export interface Vocabulary {
  code: string;
  description: string;
  extensible: boolean;
  values: readonly string[];
  /** Module that contributed each value. */
  contributedBy: Readonly<Record<string, string>>;
  valueMappings: Readonly<Record<string, Mappings>>;
}

export interface ValidationIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export type ValidationResult<T = Record<string, unknown>> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export interface Registry {
  kernelVersion: string;
  modules: readonly string[];
  kernel: Kernel;
  domains(): readonly DomainEntry[];
  vocabulary(code: string): Vocabulary | undefined;
  vocabularies(): readonly Vocabulary[];
  kind(cls: KindClass, code: string): KindEntry | undefined;
  kinds(cls?: KindClass): readonly KindEntry[];
  property(code: string): PropertyEntry | undefined;
  properties(): readonly PropertyEntry[];
  effect(code: string): EffectEntry | undefined;
  effects(): readonly EffectEntry[];
  /** The schema of one effect variant (base fields + `kind` + `v` + its own fields). */
  effectSchema(code: string): z.ZodType | undefined;
  selectors(): readonly SelectorEntry[];
  resultSchemas(): readonly ResultSchemaEntry[];
  /** Change kinds in registration order (kernel first). */
  changeKinds(): readonly ChangeKindEntry[];
  /** Every module's crosswalks, indexed in both directions. */
  crosswalk: Crosswalk;
  /** The full record schema for (class, kind|property) at a stage. */
  recordSchema(cls: RecordClass, code: string, stage: Stage): z.ZodType | undefined;
  /** Hard validation of a stored/wire record, dispatched on (class, kind|property, v). */
  validate(record: unknown): ValidationResult;
  /** Hard validation of parser output (derived fields must be absent). */
  validateDraft(record: unknown): ValidationResult;
}

export class RegistryError extends Error {}

const kindKey = (cls: KindClass, code: string) => `${cls}:${code}`;

const ROLLUP_RESULTS = new Set(["quantity", "count", "vector", "money"]);

/** A property's retention must describe a history its result type can have. */
function checkRetention(p: PropertyEntry, where: string): void {
  const r = p.retention;
  if (r === undefined) return;
  if (r.latestOnly && (r.rawDays !== undefined || r.rollup !== undefined || r.changeOnly)) {
    throw new RegistryError(`${where}: a latest-only property keeps no history`);
  }
  if (r.rawDays !== undefined && !(r.rawDays > 0)) {
    throw new RegistryError(`${where}: rawDays must be positive`);
  }
  if (r.rollup === undefined) return;
  if (!ROLLUP_RESULTS.has(p.result.type)) {
    throw new RegistryError(`${where}: ${p.result.type} results have no rollup`);
  }
  if (
    "histogram" in r.rollup &&
    (p.result.type !== "quantity" || !(r.rollup.histogram.binWidth > 0))
  ) {
    throw new RegistryError(
      `${where}: a histogram rollup needs a quantity and a positive bin width`,
    );
  }
}

/** A kind's linking rules must describe a window a match can fall in. */
function checkLinking(
  rules: LinkingRules,
  where: string,
  requireScheme: (scheme: string) => void,
): void {
  for (const scheme of rules.idSchemes) requireScheme(scheme);
  if (!(rules.alwaysMetres > 0) || rules.alwaysMetres > rules.neverMetres) {
    throw new RegistryError(`${where}: 0 < alwaysMetres <= neverMetres`);
  }
  const thresholds = { ...rules.attribute, ...(rules.pendingAttribute ?? {}) };
  for (const [field, value] of Object.entries(thresholds)) {
    if (!(value > 0) || value > 1) {
      throw new RegistryError(`${where}: ${field} similarity is in (0, 1]`);
    }
  }
  for (const [field, min] of Object.entries(rules.pendingAttribute ?? {})) {
    const accept = rules.attribute[field as keyof typeof rules.attribute];
    if (accept !== undefined && min >= accept) {
      throw new RegistryError(
        `${where}: pending ${field} similarity must be below the accepting one`,
      );
    }
  }
  for (const tag of rules.osm?.tags ?? []) {
    if (!/^[\w:]+=[^=]+$/.test(tag))
      throw new RegistryError(`${where}: osm tag "${tag}" is not key=value`);
  }
  for (const scheme of Object.values(rules.osm?.idTags ?? {})) requireScheme(scheme);
  if (rules.osm !== undefined && rules.osm.tags.length === 0) {
    throw new RegistryError(`${where}: osm rules without tags`);
  }
}

/**
 * Assembles registry modules into one closed registry: vocabularies merged
 * with their extensions, cross-references checked, and every record schema
 * built once. Throws RegistryError on the first inconsistency, so a broken
 * module fails at startup, not at the first record.
 */
export function buildRegistry(modules: readonly RegistryModule[]): Registry {
  const domains = new Map<string, DomainEntry>();
  const vocabularies = new Map<string, Vocabulary & { values: string[] }>();
  const kinds = new Map<string, KindEntry>();
  const properties = new Map<string, PropertyEntry>();
  const effects = new Map<string, EffectEntry>();
  const selectors = new Map<string, SelectorEntry>();
  const resultSchemaEntries = new Map<string, ResultSchemaEntry>();
  const changeKinds = new Map<string, ChangeKindEntry>();
  const extensions: {
    module: string;
    vocabulary: string;
    values: readonly string[];
    valueMappings?: Readonly<Record<string, Mappings>>;
  }[] = [];

  const unique = <T>(map: Map<string, T>, key: string, value: T, what: string) => {
    if (map.has(key)) throw new RegistryError(`duplicate ${what} "${key}"`);
    map.set(key, value);
  };
  const checkVersion = (version: string, what: string) => {
    if (!/^[1-9]\d*\.\d+$/.test(version))
      throw new RegistryError(`${what}: version "${version}" is not major.minor`);
  };

  const moduleNames = new Set<string>();
  for (const mod of modules) {
    if (moduleNames.has(mod.name)) throw new RegistryError(`duplicate module "${mod.name}"`);
    moduleNames.add(mod.name);
    for (const e of mod.entries) {
      switch (e.entry) {
        case "domain":
          unique(domains, e.code, e, "domain");
          break;
        case "vocabulary": {
          const contributedBy: Record<string, string> = {};
          for (const v of e.values) {
            if (contributedBy[v] !== undefined)
              throw new RegistryError(`vocabulary ${e.code}: duplicate value "${v}"`);
            contributedBy[v] = mod.name;
          }
          unique(
            vocabularies,
            e.code,
            {
              code: e.code,
              description: e.description,
              extensible: e.extensible,
              values: [...e.values],
              contributedBy,
              valueMappings: { ...(e.valueMappings ?? {}) },
            },
            "vocabulary",
          );
          break;
        }
        case "vocabulary_extension":
          extensions.push({ module: mod.name, ...e });
          break;
        case "kind":
          checkVersion(e.version, `kind ${e.class}:${e.code}`);
          unique(kinds, kindKey(e.class, e.code), e, "kind");
          break;
        case "property":
          checkVersion(e.version, `property ${e.code}`);
          unique(properties, e.code, e, "property");
          break;
        case "effect":
          checkVersion(e.version, `effect ${e.code}`);
          unique(effects, e.code, e, "effect");
          break;
        case "selector":
          checkVersion(e.version, `selector ${e.code}`);
          unique(selectors, e.code, e, "selector");
          break;
        case "result_schema":
          checkVersion(e.version, `result schema ${e.code}`);
          unique(resultSchemaEntries, e.code, e, "result schema");
          break;
        case "change_kind":
          if (e.code === "created" || e.code === "tombstoned") {
            throw new RegistryError(`change kind "${e.code}" is reserved`);
          }
          if (e.classes.length === 0) throw new RegistryError(`change kind ${e.code}: no classes`);
          unique(changeKinds, e.code, e, "change kind");
          break;
      }
    }
  }

  for (const ext of extensions) {
    const vocab = vocabularies.get(ext.vocabulary);
    if (vocab === undefined)
      throw new RegistryError(`${ext.module} extends unknown vocabulary "${ext.vocabulary}"`);
    // A closed vocabulary keeps its value set; another module may still add crosswalks.
    if (!vocab.extensible && ext.values.length > 0)
      throw new RegistryError(`${ext.module} extends closed vocabulary "${ext.vocabulary}"`);
    for (const v of ext.values) {
      if (vocab.contributedBy[v] !== undefined) {
        throw new RegistryError(
          `vocabulary ${ext.vocabulary}: "${v}" already contributed by ${vocab.contributedBy[v]}`,
        );
      }
      (vocab.contributedBy as Record<string, string>)[v] = ext.module;
      vocab.values.push(v);
    }
    // Modules sharing a kernel vocabulary (trend: parking occupancy and travel
    // times) map one value from different source enumerations, so their codes
    // are pooled; the crosswalk still rejects a code that names two values.
    const merged = vocab.valueMappings as Record<string, Mappings>;
    for (const [value, mappings] of Object.entries(ext.valueMappings ?? {})) {
      const pooled: Mappings = { ...merged[value] };
      for (const [target, codes] of Object.entries(mappings) as [keyof Mappings, string[]][]) {
        const known = pooled[target] ?? [];
        const repeated = codes.find((c) => known.includes(c));
        if (repeated !== undefined) {
          throw new RegistryError(
            `${ext.module}: vocabulary ${ext.vocabulary} value "${value}" already maps ${target} code "${repeated}"`,
          );
        }
        pooled[target] = [...known, ...codes];
      }
      merged[value] = pooled;
    }
  }
  for (const v of vocabularies.values()) {
    for (const value of Object.keys(v.valueMappings)) {
      if (!v.values.includes(value)) {
        throw new RegistryError(`vocabulary ${v.code}: mappings for unregistered value "${value}"`);
      }
    }
  }

  const requireVocab = (code: string, where: string) => {
    const v = vocabularies.get(code);
    if (v === undefined)
      throw new RegistryError(`${where} references unknown vocabulary "${code}"`);
    return v;
  };
  const requireDomain = (code: string | undefined, where: string) => {
    if (code === undefined || !domains.has(code))
      throw new RegistryError(`${where}: unknown domain "${code}"`);
  };
  const requireValue = (vocabulary: string, value: string, where: string) => {
    if (!requireVocab(vocabulary, where).values.includes(value))
      throw new RegistryError(`${where}: "${value}" is not a registered ${vocabulary}`);
  };

  for (const k of kinds.values()) {
    const where = `kind ${k.class}:${k.code}`;
    if (k.class === "component") {
      if (k.domain !== undefined)
        throw new RegistryError(`${where}: components take their feature's domain`);
    } else {
      requireDomain(k.domain, where);
    }
    if (k.class === "situation" && Object.keys(k.types ?? {}).length === 0) {
      throw new RegistryError(`${where}: situation kinds declare their types`);
    }
    if (k.deriveSeverity !== undefined && k.class !== "situation") {
      throw new RegistryError(`${where}: only situation kinds derive severity`);
    }
    for (const key of Object.keys(k.typeMappings ?? {})) {
      if (!isRegisteredTypeKey(k.types, key)) {
        throw new RegistryError(`${where}: typeMappings key "${key}" is not a registered type`);
      }
    }
    if (k.class === "offer" && k.details !== undefined)
      throw new RegistryError(`${where}: offers have no details`);
    if (k.class !== "offer" && k.details === undefined)
      throw new RegistryError(`${where}: details schema missing`);
    for (const c of k.components ?? []) {
      if (k.class !== "feature")
        throw new RegistryError(`${where}: only feature kinds list components`);
      if (!kinds.has(kindKey("component", c)))
        throw new RegistryError(`${where}: unknown component kind "${c}"`);
    }
    for (const t of k.traits ?? []) {
      if (k.class !== "feature")
        throw new RegistryError(`${where}: only feature kinds have traits`);
      requireValue("feature_trait", t, where);
    }
    if (k.linking !== undefined) {
      if (k.class !== "feature")
        throw new RegistryError(`${where}: only feature kinds declare linking rules`);
      checkLinking(k.linking, where, (scheme) =>
        requireValue("external_id_scheme", scheme, `${where} linking`),
      );
    }
  }
  for (const p of properties.values()) {
    const where = `property ${p.code}`;
    requireDomain(p.domain, where);
    if (p.subjects.length === 0) throw new RegistryError(`${where}: no subjects`);
    if (p.fusionTiers && new Set(p.fusionTiers).size !== p.fusionTiers.length) {
      throw new RegistryError(`${where}: fusionTiers lists a tier twice`);
    }
    if (p.result.type === "category") requireVocab(p.result.vocabulary, where);
    if (p.result.type === "structured" && !resultSchemaEntries.has(p.result.schema)) {
      throw new RegistryError(`${where}: unknown result schema "${p.result.schema}"`);
    }
    for (const s of p.subjects) {
      if (s.kind !== "feature") continue;
      for (const f of s.featureKinds ?? []) {
        if (!kinds.has(kindKey("feature", f)))
          throw new RegistryError(`${where}: unknown feature kind "${f}"`);
      }
      for (const t of s.traits ?? []) requireValue("feature_trait", t, where);
      for (const c of s.componentKinds ?? []) {
        if (!kinds.has(kindKey("component", c)))
          throw new RegistryError(`${where}: unknown component kind "${c}"`);
      }
    }
    checkRetention(p, where);
  }

  let crosswalk: Crosswalk;
  try {
    crosswalk = buildCrosswalk(modules.flatMap((m) => m.entries));
  } catch (err) {
    if (err instanceof CrosswalkError) throw new RegistryError(err.message);
    throw err;
  }

  const vocab = (code: string) => enumOf(requireVocab(code, "kernel").values);
  const base = buildKernelBase(vocab);
  const effectVariants = [...effects.values()].map((e) => {
    let variant = z.strictObject({
      ...base.effectBaseShape,
      kind: z.literal(e.code),
      v: z.literal(majorOf(e.version)),
      ...e.shape(base),
    });
    if (e.refine) {
      const refine = e.refine;
      variant = variant.superRefine((value, ctx) => refine(value as Record<string, unknown>, ctx));
    }
    return variant;
  });
  const effectSchemas = new Map(
    [...effects.keys()].map((code, i) => [code, effectVariants[i] as z.ZodType]),
  );
  if (effectVariants.length === 0) throw new RegistryError("no effect variants registered");
  const kernel: Kernel = {
    ...base,
    Effect: z.discriminatedUnion(
      "kind",
      effectVariants as unknown as [z.ZodObject, ...z.ZodObject[]],
    ) as unknown as z.ZodType<Effect>,
  };

  const detailsSchema = (k: KindEntry): z.ZodType => {
    let schema = z.strictObject({
      kind: z.literal(k.code),
      v: z.literal(majorOf(k.version)),
      ...k.details!(kernel),
    });
    if (k.refineDetails) {
      const refine = k.refineDetails;
      schema = schema.superRefine((d, ctx) => refine(d as Record<string, unknown>, ctx));
    }
    return schema;
  };
  const resultSchemas = new Map(
    [...resultSchemaEntries.values()].map((r) => [
      r.code,
      {
        entry: r,
        value: z.strictObject({
          v: z.literal(majorOf(r.version)),
          ...r.shape(kernel),
        }) as z.ZodType,
      },
    ]),
  );
  const componentSchemas = new Map(
    [...kinds.values()]
      .filter((k) => k.class === "component")
      .map((k) => [k.code, componentSchema(kernel, k, detailsSchema(k))]),
  );
  const vocabValues = (code: string) => requireVocab(code, "property").values;
  const selectorList = [...selectors.values()];

  const cache = new Map<string, z.ZodType>();
  const recordSchema = (cls: RecordClass, code: string, stage: Stage): z.ZodType | undefined => {
    const key = `${stage}:${cls}:${code}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let schema: z.ZodType | undefined;
    if (cls === "observation") {
      const p = properties.get(code);
      if (p)
        schema = observationSchema(
          kernel,
          p,
          resultSchemaFor(p.result, vocabValues, resultSchemas),
          stage,
        );
    } else {
      const k = kinds.get(kindKey(cls, code));
      if (k?.class === "situation")
        schema = situationSchema(kernel, k, detailsSchema(k), selectorList, stage);
      if (k?.class === "feature") {
        const comps = (k.components ?? []).map((c) => componentSchemas.get(c)!);
        schema = featureSchema(kernel, k, detailsSchema(k), comps, stage);
      }
      if (k?.class === "offer") schema = offerSchema(kernel, k, stage);
    }
    if (schema) cache.set(key, schema);
    return schema;
  };

  // Build every schema now: a factory that throws must fail the registry, not the first record.
  for (const stage of ["draft", "stored"] as const) {
    for (const k of kinds.values())
      if (k.class !== "component") recordSchema(k.class, k.code, stage);
    for (const p of properties.values()) recordSchema("observation", p.code, stage);
  }

  const validateAt =
    (stage: Stage) =>
    (input: unknown): ValidationResult => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return {
          ok: false,
          issues: [{ path: [], code: "invalid_type", message: "a record is an object" }],
        };
      }
      const rec = input as Record<string, unknown>;
      const cls = rec["class"];
      if (typeof cls !== "string" || !(RECORD_CLASSES as readonly string[]).includes(cls)) {
        return {
          ok: false,
          issues: [
            { path: ["class"], code: "unknown_class", message: `unknown class ${String(cls)}` },
          ],
        };
      }
      const recordClass = cls as RecordClass;
      const code = recordClass === "observation" ? rec["property"] : rec["kind"];
      const codeField = recordClass === "observation" ? "property" : "kind";
      const schema = typeof code === "string" ? recordSchema(recordClass, code, stage) : undefined;
      if (schema === undefined) {
        return {
          ok: false,
          issues: [
            {
              path: [codeField],
              code: `unknown_${codeField}`,
              message: `unregistered ${recordClass} ${codeField} ${String(code)}`,
            },
          ],
        };
      }
      if (recordClass !== "observation" && recordClass !== "offer") {
        const entry = kinds.get(kindKey(recordClass, code as string))!;
        const v = (rec["details"] as { v?: unknown } | undefined)?.v;
        if (v !== majorOf(entry.version)) {
          return {
            ok: false,
            issues: [
              {
                path: ["details", "v"],
                code: "unsupported_version",
                message: `${recordClass} ${String(code)} is at v${majorOf(entry.version)}, got v${String(v)}`,
              },
            ],
          };
        }
      }
      const parsed = schema.safeParse(input);
      if (parsed.success) return { ok: true, value: parsed.data as Record<string, unknown> };
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
          code: i.code,
          message: i.message,
        })),
      };
    };

  return {
    kernelVersion: KERNEL_VERSION,
    modules: [...moduleNames],
    kernel,
    domains: () => [...domains.values()],
    vocabulary: (code) => vocabularies.get(code),
    vocabularies: () => [...vocabularies.values()],
    kind: (cls, code) => kinds.get(kindKey(cls, code)),
    kinds: (cls) => [...kinds.values()].filter((k) => cls === undefined || k.class === cls),
    property: (code) => properties.get(code),
    properties: () => [...properties.values()],
    effect: (code) => effects.get(code),
    effects: () => [...effects.values()],
    effectSchema: (code) => effectSchemas.get(code),
    selectors: () => selectorList,
    resultSchemas: () => [...resultSchemaEntries.values()],
    changeKinds: () => [...changeKinds.values()],
    crosswalk,
    recordSchema,
    validate: validateAt("stored"),
    validateDraft: validateAt("draft"),
  };
}
