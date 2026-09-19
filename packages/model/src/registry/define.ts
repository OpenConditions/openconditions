import type { z } from "zod";
import type { SEVERITY_LABELS } from "../classes/situation.js";
import type { KernelBase } from "../kernel/build.js";
import type { Effect, Kernel } from "../kernel/effect-type.js";
import type { FusionTier, PrivacyClass } from "../kernel/provenance.js";

type SeverityLabel = (typeof SEVERITY_LABELS)[number];

/** `major.minor`; the wire `v` is the major. */
export type SchemaVersion = `${number}.${number}`;

/** External vocabularies a registry entry can map to (crosswalks). */
export type MappingTarget =
  | "datex2_v2"
  | "datex2_v3"
  | "wzdx"
  | "open511"
  | "ibi511"
  | "alert_c"
  | "traff"
  | "gtfs_rt"
  | "cap"
  | "ocpi"
  | "oicp"
  | "tpims"
  | "road511"
  | "osm";

/** Source codes an entry corresponds to, per external vocabulary. */
export type Mappings = Partial<Record<MappingTarget, readonly string[]>>;

/**
 * Targets OpenConditions parses. A source code of one of these must resolve
 * to exactly one classification, so the registry rejects a code mapped twice.
 * The other targets are emitter vocabularies, where many classifications
 * legitimately share one code (GTFS-RT `OTHER_CAUSE`).
 */
export const INGEST_MAPPING_TARGETS: readonly MappingTarget[] = [
  "datex2_v2",
  "datex2_v3",
  "wzdx",
  "open511",
  "ibi511",
];

interface EntryBase {
  code: string;
  description: string;
  /** Localised display labels; the first entry is the primary language. */
  labels?: readonly { lang: string; text: string }[];
  mappings?: Mappings;
}

export interface DomainEntry extends EntryBase {
  entry: "domain";
}

export interface VocabularyEntry extends EntryBase {
  entry: "vocabulary";
  values: readonly string[];
  /** Extensible vocabularies accept values contributed by other modules (`extendVocabulary`). */
  extensible: boolean;
  /** Per-value crosswalks: value → mappings. */
  valueMappings?: Readonly<Record<string, Mappings>>;
}

export interface VocabularyExtensionEntry {
  entry: "vocabulary_extension";
  vocabulary: string;
  values: readonly string[];
  valueMappings?: Readonly<Record<string, Mappings>>;
}

/** The registry-side classes a kind belongs to; components are addressable sub-records, not a record class. */
export type KindClass = "feature" | "component" | "situation" | "offer";

export interface KindEntry<C extends string = string, S extends z.ZodRawShape = z.ZodRawShape>
  extends EntryBase {
  entry: "kind";
  code: C;
  class: KindClass;
  /** Components inherit the domain of their feature and declare none. */
  domain?: string;
  version: SchemaVersion;
  /** Closed type → subtype lists. Absent = the kind has no `type`. */
  types?: Readonly<Record<string, readonly string[]>>;
  /** Crosswalks of one `type` or `type.subtype`; the kind-level ones are `mappings`. */
  typeMappings?: Readonly<Record<string, Mappings>>;
  /**
   * Situation kinds: the severity rule for a situation whose source declares
   * none. Returns undefined when the rule has no signal, so the label stays
   * `unknown` rather than a default.
   */
  deriveSeverity?: (situation: SeverityRuleInput) => DerivedSeverity | undefined;
  /** Fields of `details` besides `kind` and `v`. Offers have no details. */
  details?: (k: Kernel) => S;
  /** Cross-field rules on `details`. */
  refineDetails?: (details: Record<string, unknown>, ctx: z.RefinementCtx) => void;
  /** Feature kinds: the component kinds a feature of this kind may carry. */
  components?: readonly string[];
  /** Situation kinds: effects nested inside `details` (roadworks phases), for id uniqueness and materialisation. */
  nestedEffects?: (details: Record<string, unknown>) => readonly { id: string }[];
}

/** What a situation kind's severity rule reads: the classification and the effects. */
export interface SeverityRuleInput {
  type: string;
  subtype?: string;
  effects: readonly Effect[];
}

export type DerivedSeverity = Exclude<SeverityLabel, "unknown">;

export type PropertyResultSpec =
  | { type: "quantity"; unit: string }
  | { type: "count" }
  | { type: "boolean" }
  | { type: "category"; vocabulary: string }
  | { type: "text" }
  | { type: "vector"; unit: string; keys: readonly string[] }
  | { type: "money"; per?: readonly string[] }
  | { type: "structured"; schema: string };

export type SubjectSpec =
  | { kind: "feature"; featureKinds?: readonly string[]; componentKinds?: readonly string[] }
  | { kind: "segments" }
  | { kind: "location" }
  | { kind: "situation"; situationKinds?: readonly string[] };

export interface PropertyEntry extends EntryBase {
  entry: "property";
  domain: string;
  version: SchemaVersion;
  result: PropertyResultSpec;
  subjects: readonly SubjectSpec[];
  /** Closed qualifier keys: only where neither a component nor a vector result fits. */
  qualifiers?: (k: Kernel) => z.ZodRawShape;
  freshnessWindowSec?: number;
  decayTtlSec?: { feed?: number; crowd?: number };
  retention?: {
    rawDays?: number;
    rollup?: "hourly" | "hourly_histogram" | "daily";
    changeOnly?: boolean;
    latestOnly?: boolean;
  };
  privacyDefault?: PrivacyClass;
  /** Fusion order for this property, highest first; defaults to FUSION_TIERS. */
  fusionTiers?: readonly FusionTier[];
  routingRelevant?: boolean;
  icon?: string;
}

export interface EffectEntry<C extends string = string, S extends z.ZodRawShape = z.ZodRawShape>
  extends EntryBase {
  entry: "effect";
  code: C;
  version: SchemaVersion;
  /** Fields besides the EffectBase fields and `kind`/`v`. */
  shape: (k: KernelBase) => S;
  refine?: (effect: Record<string, unknown>, ctx: z.RefinementCtx) => void;
}

export interface SelectorEntry extends EntryBase {
  entry: "selector";
  version: SchemaVersion;
  /** The schema of this key's value inside `Situation.affects`. */
  schema: (k: Kernel) => z.ZodType;
}

export interface ResultSchemaEntry extends EntryBase {
  entry: "result_schema";
  version: SchemaVersion;
  /** Fields of the structured value besides `v`. */
  shape: (k: Kernel) => z.ZodRawShape;
}

/** Record classes that keep revisions; observations are a time series instead. */
export type RevisionClass = "situation" | "feature" | "offer";

/**
 * A named kind of change between two revisions of a record (the history
 * API's `change_kinds`). `select` picks the part of the record this change
 * kind watches; the change is present when the picks of the previous and the
 * new revision differ (compared as RFC 8785 JCS).
 */
export interface ChangeKindEntry extends EntryBase {
  entry: "change_kind";
  classes: readonly RevisionClass[];
  select: (record: Readonly<Record<string, unknown>>) => unknown;
}

export type RegistryEntry =
  | DomainEntry
  | VocabularyEntry
  | VocabularyExtensionEntry
  | KindEntry
  | PropertyEntry
  | EffectEntry
  | SelectorEntry
  | ResultSchemaEntry
  | ChangeKindEntry;

/** A named bundle of entries: the kernel, or one domain package. */
export interface RegistryModule {
  name: string;
  entries: readonly RegistryEntry[];
}

type Def<T extends { entry: string }> = Omit<T, "entry">;

export const defineDomain = (d: Def<DomainEntry>): DomainEntry => ({ entry: "domain", ...d });
export const defineVocabulary = (d: Def<VocabularyEntry>): VocabularyEntry => ({
  entry: "vocabulary",
  ...d,
});
export const extendVocabulary = (d: Def<VocabularyExtensionEntry>): VocabularyExtensionEntry => ({
  entry: "vocabulary_extension",
  ...d,
});
export const defineKind = <const C extends string, S extends z.ZodRawShape = Record<never, never>>(
  d: Def<KindEntry<C, S>>,
): KindEntry<C, S> => ({ entry: "kind", ...d });
export const defineProperty = (d: Def<PropertyEntry>): PropertyEntry => ({
  entry: "property",
  ...d,
});
export const defineEffect = <const C extends string, S extends z.ZodRawShape>(
  d: Def<EffectEntry<C, S>>,
): EffectEntry<C, S> => ({ entry: "effect", ...d });
export const defineSelector = (d: Def<SelectorEntry>): SelectorEntry => ({
  entry: "selector",
  ...d,
});
export const defineResultSchema = (d: Def<ResultSchemaEntry>): ResultSchemaEntry => ({
  entry: "result_schema",
  ...d,
});
export const defineChangeKind = (d: Def<ChangeKindEntry>): ChangeKindEntry => ({
  entry: "change_kind",
  ...d,
});

/** The wire `v` of a `major.minor` version. */
export function majorOf(version: SchemaVersion): number {
  return Number(version.split(".")[0]);
}
