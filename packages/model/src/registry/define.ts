import type { z } from "zod";
import type { SEVERITY_LABELS } from "../classes/situation.js";
import type { KernelBase } from "../kernel/build.js";
import type { Effect, Kernel } from "../kernel/effect-type.js";
import type { FusionTier, PrivacyClass } from "../kernel/provenance.js";
import type { Validity } from "../kernel/validity.js";

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
  | "parkapi"
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
  "ocpi",
  "oicp",
  "parkapi",
  "tpims",
  "cap",
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
  /**
   * Feature kinds: traits (vocabulary `feature_trait`) a property can name as
   * its subject instead of listing kinds, so a property of one domain module
   * applies to feature kinds of another without either importing the other.
   */
  traits?: readonly string[];
  /** Feature kinds: how two sources' records of this kind are linked, and its OSM tags. */
  linking?: LinkingRules;
  /**
   * Situation kinds: effects nested inside `details` (roadworks phases), each
   * with the phase it belongs to, for id uniqueness and for storing every
   * effect of a situation in one table.
   */
  nestedEffects?: (details: Record<string, unknown>) => readonly NestedEffect[];
  /** Situation kinds: how the crowd reports this kind; absent, the crowd cannot report it. */
  crowd?: SituationCrowdRules;
  /** Component kinds: what makes two sources' components one component of a linked feature. */
  identity?: ComponentIdentity;
}

/**
 * An effect nested inside a situation's details: the effect, the phase it
 * belongs to and that phase's validity, which the effect defaults to.
 */
export interface NestedEffect {
  phaseId: string;
  validity: Validity;
  effect: { id: string } & Record<string, unknown>;
}

/**
 * How crowd reports of one situation kind or one property live and are
 * judged. A report is live for `ttlSec`; confirmations extend it, never past
 * `maxLifetimeSec` after the first report. `corroborationKeys` distinct
 * reporters corroborate it, `negationKeys` distinct reporters saying it is
 * gone end it.
 */
export interface CrowdRules {
  ttlSec: number;
  maxLifetimeSec: number;
  /** Default 2: one reporter never corroborates their own report. */
  corroborationKeys?: number;
  /** Default 2: one stranger's "gone" never ends a report. */
  negationKeys?: number;
}

export interface SituationCrowdRules extends CrowdRules {
  /**
   * A report and another record of the same kind and type describe one
   * phenomenon when the report lies within this distance of the other's
   * geometry (default 250 m).
   */
  matchMetres?: number;
  /** Lifetimes of the types that live longer or shorter than their kind. */
  types?: Readonly<Record<string, Pick<CrowdRules, "ttlSec" | "maxLifetimeSec">>>;
}

export interface PropertyCrowdRules extends CrowdRules {
  /**
   * When an authoritative reading agrees with a crowd report: an equal
   * result, or for a quantity or a price one within `tolerance` (in the
   * property's unit or the price's currency). Agreement is what resolves a
   * report externally and trains its reporter.
   */
  agreement?: { tolerance: number };
  /**
   * How far from its subject a reporter may stand (default 300 m): a price is
   * read off the pole and a broken charger seen at the charger, so a report
   * from further away is not an observation.
   */
  reachMetres?: number;
}

/**
 * What makes components of two linked features one component. Only a shared
 * id of one of `idSchemes` — compared within the corresponding parent when
 * `withinParent`, because an OCPI connector id is only unique within its
 * EVSE — or, for a kind whose sources publish no id, equal values of the
 * `details` fields in `fields`. Never position or name.
 */
export interface ComponentIdentity {
  idSchemes?: readonly string[];
  withinParent?: boolean;
  fields?: readonly string[];
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

/**
 * How two per-source features of one kind are recognised as the same thing
 * and which OSM elements that kind can be. Tier 1 is a shared id of an
 * authoritative scheme; tier 2 a spatial match, on its own below
 * `alwaysMetres` and otherwise only when an attribute agrees at least as well
 * as `attribute` demands; a pair that only reaches `pendingAttribute` is kept
 * for review instead of linked. Distances are metres between representative
 * points.
 */
export interface LinkingRules {
  /** Id schemes that identify the feature across sources; a conflict under one blocks the link. */
  idSchemes: readonly string[];
  alwaysMetres: number;
  neverMetres: number;
  attribute: { name?: number; operator?: number; address?: number };
  /**
   * How far an agreeing attribute may link on its own; beyond it, another
   * attribute must agree as well (an operator with dozens of sites per square
   * kilometre says little at 120 m).
   */
  attributeWithinMetres?: { name?: number; operator?: number; address?: number };
  pendingAttribute?: { name?: number; operator?: number; address?: number };
  /** Tokens every feature of the kind shares, so they carry no evidence ("parkhaus"). */
  nameStopwords?: readonly string[];
  /** Types that may still be one feature; by default only equal types link. */
  typeCompatible?: (a: string | undefined, b: string | undefined) => boolean;
  osm?: {
    /** `key=value` filters an element of this kind carries. */
    tags: readonly string[];
    /** OSM tag → the id scheme whose value it holds (`ref:EU:EVSE` → `emi3:evse`). */
    idTags?: Readonly<Record<string, string>>;
  };
}

/**
 * What a property may be observed about. A feature subject names feature
 * kinds, traits (any feature kind carrying one), component kinds, or a mix;
 * none of them means any feature.
 */
export type SubjectSpec =
  | {
      kind: "feature";
      featureKinds?: readonly string[];
      traits?: readonly string[];
      componentKinds?: readonly string[];
    }
  | { kind: "segments" }
  | { kind: "location" }
  | { kind: "situation"; situationKinds?: readonly string[] };

/**
 * How long a property's history is kept and in what form. A series keeps
 * every distinct result (`changeOnly`: only results that differ from the
 * latest), raw rows for `rawDays`, then only its rollups; `latestOnly` keeps
 * no history at all, only the reading in effect. Rollups aggregate numeric
 * results; an hourly histogram keeps the distribution (bins of `binWidth` in the
 * property's unit), because percentiles over a window cannot be rebuilt from
 * per-hour percentiles. A property without a retention entry keeps every row,
 * which only suits a sparse series (a regulated price cap).
 * `componentHistory: false` keeps readings about a component (a lane, a
 * vehicle class) latest-only while the feature's own series keeps its
 * history: per-lane traffic history would multiply the site series many
 * times over.
 */
export interface Retention {
  rawDays?: number;
  changeOnly?: boolean;
  latestOnly?: boolean;
  componentHistory?: false;
  rollup?: { period: "hourly" | "daily" } | { period: "hourly"; histogram: { binWidth: number } };
}

export interface PropertyEntry extends EntryBase {
  entry: "property";
  domain: string;
  version: SchemaVersion;
  result: PropertyResultSpec;
  subjects: readonly SubjectSpec[];
  /** Closed qualifier keys: only where neither a component nor a vector result fits. */
  qualifiers?: (k: Kernel) => z.ZodRawShape;
  /** Cross-field rules of one property's observations (which subject needs which qualifier). */
  refine?: (observation: Record<string, unknown>, ctx: z.RefinementCtx) => void;
  freshnessWindowSec?: number;
  /** How the crowd reports this property; absent, the crowd cannot report it. */
  crowd?: PropertyCrowdRules;
  retention?: Retention;
  /**
   * Each series holds one reading of one instant, such as a satellite
   * detection at a place: written once, never revised, and deleted with its
   * reading's expiry. Such a series has no change to compare and nothing to
   * roll up, so it is never change-only, latest-only or rolled up.
   */
  transient?: true;
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
