import type { Schedule } from "@openconditions/core";

/**
 * The normalized vehicle-restriction display contract, version 1.
 *
 * A published fact here is a *source-verified statement*, never a claim that a
 * particular vehicle may pass. The contract deliberately has no value meaning
 * "this road is unrestricted": absence of the envelope is the only way to say
 * nothing about vehicle applicability. Presence — even of an empty or
 * unparseable envelope — is therefore treated as restriction evidence and
 * excludes the record from shared routing and from lossy exports.
 */

/** Closed set of reasons a source restriction could not be normalized. */
export type RestrictionIssueCode =
  | "unsupported_type"
  | "unsupported_unit"
  | "unsupported_operator"
  | "invalid_value"
  | "invalid_window"
  | "unsupported_schedule"
  | "unsupported_status"
  | "unknown_vehicle"
  | "compound_condition"
  | "conflicting_direction";

/**
 * A bounded, allowlisted bag of original source tokens. Adapters choose which
 * keys to retain; this is never a recursive passthrough of the raw record, and
 * never carries contact data.
 */
export type RestrictionTokens = Record<string, unknown>;

/** An unsupported or malformed source fact, retained as explicit evidence. */
export interface RestrictionIssue {
  code: RestrictionIssueCode;
  /** null for an unnormalized fact or a whole-record issue. */
  factId: string | null;
  sourcePath: string;
  sourceText?: string;
  sourceTokens?: RestrictionTokens;
  /** Set when `sourceText`/`sourceTokens` were clipped to the size bound. */
  truncated?: true;
}

/**
 * Source and rights provenance for the restriction facts. These are *source*
 * identities, not graph provenance: `feedUrls` is the configured canonical
 * endpoint list, not a per-record permalink.
 */
export interface RestrictionSource {
  sourceId: string;
  recordId: string;
  recordVersion: string | null;
  sourceUpdatedAt: string | null;
  feedUrls: string[];
  publisher: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  modificationNotice: string;
  notices?: string[];
}

/** Fields every restriction fact carries, regardless of its kind. */
export interface RestrictionFactBase {
  /**
   * Opaque identity within a source record version, derived from record id,
   * phase id or `event`, scope and source field path. Not a long-lived
   * observation id.
   */
  id: string;
  scope: {
    kind: "event_road" | "roadwork_phase" | "detour";
    phaseId: string | null;
    locationDescription: string | null;
    sourceLocationRefs: RestrictionTokens;
    /**
     * No fact in this release receives an independent restriction binding: an
     * event's segment binding never establishes the restriction's extent.
     */
    restrictionBinding: "not_established";
  };
  direction: {
    basis: "road_reference" | "alert_c" | "openlr" | "unknown";
    value: "positive" | "negative" | "both" | "unknown";
    description: string | null;
  };
  /** Intersection of the applicable valid source windows, or null when unknown. */
  validFrom: string | null;
  validTo: string | null;
  /** Only fully represented applicability recurrences; never working hours. */
  schedule?: Schedule[];
  sourceTokens: RestrictionTokens;
  context: {
    /** Display-only local schedules; they never constrain restriction state. */
    workingHours?: Schedule[];
    restrictionsLiftable: boolean | null;
    compliance: "mandatory" | "advisory" | "unknown";
    operatorActionStatus: string | null;
    validityStatus: string | null;
    comments?: Array<{ text: string; language: string | null }>;
  };
}

/** Canonical vehicle-class tokens verified in this release. */
export type RestrictionVehicleClass = "truck";

/** Canonical vehicle-usage tokens verified in this release. */
export type RestrictionVehicleUsage = "emergency_services";

/**
 * A single verified restriction fact. Dimension facts are a separate branch of
 * the union so a class/usage value can never be numeric, and a numeric value
 * can never appear without its unit and comparator.
 */
export type RoadRestrictionFact = RestrictionFactBase &
  (
    | {
        kind: "dimension";
        dimension: "height" | "width" | "length" | "gross_weight";
        meaning: "maximum_permitted" | "event_applies_when";
        value: number;
        unit: "m" | "kg";
        operator: "lt" | "lte" | "eq" | "gte" | "gt";
      }
    | { kind: "vehicle_class"; meaning: "event_applies_when"; value: RestrictionVehicleClass }
    | { kind: "vehicle_usage"; meaning: "event_applies_when"; value: RestrictionVehicleUsage }
  );

/** The persisted source-semantics envelope. Carries no evaluated state. */
export interface RoadRestrictionDetailsV1 {
  schemaVersion: 1;
  vehicleScope: "specific" | "unknown";
  completeness: "complete" | "partial";
  facts: RoadRestrictionFact[];
  issues: RestrictionIssue[];
  source: RestrictionSource;
}

/** Temporal state of a single fact at an evaluation instant. */
export type RestrictionState = "active" | "scheduled" | "ended" | "unknown";

/**
 * The publication-time projection. `evaluatedAt`/`sourceCheckedAt`/`freshUntil`
 * /`nextTransitionAt`/`isStale` and per-fact `state` are computed and must never
 * enter the content hash or the persisted attributes.
 */
export interface PublishedRoadRestrictionDetailsV1 extends Omit<RoadRestrictionDetailsV1, "facts"> {
  facts: Array<RoadRestrictionFact & { state: RestrictionState }>;
  evaluatedAt: string;
  sourceCheckedAt: string | null;
  freshUntil: string | null;
  nextTransitionAt: string | null;
  isStale: boolean;
}

/**
 * Anything that may carry restriction evidence: a road event, an observation, a
 * publisher row's attributes bag or a host DTO. `restrictionDetails` is
 * deliberately `unknown` so a carrier can hold an *invalid* envelope that must
 * still be recognized as evidence rather than silently read as absence.
 */
export interface RestrictionCarrier {
  restrictionDetails?: unknown;
  restrictionDetailsUnsupported?: boolean;
}

/** Maximum retained public text/token size per issue, in Unicode code points. */
export const RESTRICTION_TEXT_LIMIT = 4096;
