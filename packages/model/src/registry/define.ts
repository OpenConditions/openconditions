import type { z } from "zod";
import type { KernelBase } from "../kernel/build.js";
import type { Kernel } from "../kernel/effect-type.js";
import type { FusionTier, PrivacyClass } from "../kernel/provenance.js";

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
  /** Fields of `details` besides `kind` and `v`. Offers have no details. */
  details?: (k: Kernel) => S;
  /** Cross-field rules on `details`. */
  refineDetails?: (details: Record<string, unknown>, ctx: z.RefinementCtx) => void;
  /** Feature kinds: the component kinds a feature of this kind may carry. */
  components?: readonly string[];
  /** Situation kinds: effects nested inside `details` (roadworks phases), for id uniqueness and materialisation. */
  nestedEffects?: (details: Record<string, unknown>) => readonly { id: string }[];
}

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

export type RegistryEntry =
  | DomainEntry
  | VocabularyEntry
  | VocabularyExtensionEntry
  | KindEntry
  | PropertyEntry
  | EffectEntry
  | SelectorEntry
  | ResultSchemaEntry;

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

/** The wire `v` of a `major.minor` version. */
export function majorOf(version: SchemaVersion): number {
  return Number(version.split(".")[0]);
}
