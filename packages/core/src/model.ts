import type { Geometry, LineString, MultiLineString, Point } from "geojson";
import type { EvidenceState } from "./evidence.js";

export type GeoJsonGeometry = Geometry;
export type LineStringGeometry = LineString;
export type MultiLineStringGeometry = MultiLineString;
export type PointGeometry = Point;

export interface Attribution {
  provider: string;
  license: string;
  url?: string;
}

/**
 * A non-primary source folded into an observation by cross-source dedup. The
 * surviving (primary) observation keeps its own `origin`; every other source
 * that described the same real-world condition is recorded here so no source's
 * attribution is ever dropped when duplicates are merged.
 */
export interface MergedSource {
  source: string;
  id: string;
  attribution: Attribution;
}

export type SourceFormat =
  | "datex2"
  | "open511"
  | "wzdx"
  | "geojson"
  | "ibi511-json"
  | "lta-json"
  | "gddkia-xml"
  | "flatjson"
  | "trafikverket-json"
  | "traff"
  | "autobahn-json"
  | "digitraffic-json"
  | "fintraffic-tms-json"
  | "webtris-json"
  | "nyc-dot-speed-json"
  | "ohgo-json"
  | "trafikverket-flow-json"
  | "bonn-geojson"
  | "madrid-informo-xml"
  | "lta-speedbands-json"
  | "miv-xml"
  | "turin-fdt-xml"
  | "hk-raw-xml"
  | "gtfs-rt"
  | "native"
  | "crowd";

export type ObservationDomain = "roads" | "transit" | "places" | string;

export type Severity = "low" | "medium" | "high" | "critical" | "unknown";

export type Confidence = "observed" | "likely" | "possible" | "unknown";

/**
 * How precisely an observation's geometry/extent is known. `exact` is the
 * default; the `*_res` values mark deliberately coarsened geometry and the
 * `*_unknown` values mark an open-ended or missing extent boundary.
 */
export type Fuzziness =
  | "exact"
  | "low_res"
  | "medium_res"
  | "end_unknown"
  | "start_unknown"
  | "extent_unknown";

/**
 * The privacy tier an observation was produced under. Governs how it may be
 * exposed/aggregated. (The DB carries an extra `unknown` legacy default that is
 * intentionally NOT part of this enum — a defaulting seam assigns a real class.)
 */
export type PrivacyClass =
  | "authoritative"
  | "aggregate"
  | "k_anon"
  | "dp_noised"
  | "crowd_pseudonym";

/**
 * A recurring validity rule, shaped after schema.org `Schedule`
 * (https://schema.org/Schedule). The local wall-clock fields (`startTime`,
 * `startDate`/`endDate`, …) are interpreted in `scheduleTimezone` (an IANA name),
 * so the rule is unambiguous and DST-correct without materialising occurrences.
 * `duration` is the authoritative occurrence length (overnight-safe, e.g.
 * "PT9H" for 20:00–05:00); `endTime` is an optional human-readable convenience.
 * An Observation with no `schedule` (or an empty array) is continuously active
 * across `[validFrom, validTo]`.
 */
export interface Schedule {
  /** ISO 8601 duration between occurrences: "P1D" daily, "P1W" weekly. */
  repeatFrequency?: string;
  /** Bound the recurrence by a count of occurrences instead of `endDate`. */
  repeatCount?: number;
  /** Local ISO date of the first occurrence (recurrence lower bound). */
  startDate?: string;
  /** Local ISO date of the last occurrence's start (recurrence upper bound). */
  endDate?: string;
  /** Local time-of-day each occurrence starts ("HH:MM" or "HH:MM:SS"). */
  startTime?: string;
  /** Optional local end time-of-day (human-readable; `duration` is authoritative). */
  endTime?: string;
  /** ISO 8601 duration of each occurrence, e.g. "PT9H"; overnight-safe. */
  duration?: string;
  /** Days of week as two-letter iCal codes (SU MO TU WE TH FR SA). */
  byDay?: string[];
  /** Months of the year (1-12) the recurrence applies to. */
  byMonth?: number[];
  /** Days of the month (1-31). */
  byMonthDay?: number[];
  /** Local ISO dates excluded from the recurrence. */
  exceptDate?: string[];
  /** IANA timezone the local fields above are expressed in (e.g. "Europe/Berlin"). */
  scheduleTimezone: string;
}

export interface SubjectRef {
  type: "geo" | "osm" | "gtfs-stop" | "gtfs-trip" | "gtfs-route" | "place" | "segment";
  id: string;
  role?: string;
}

export interface ReporterRef {
  keyId: string;
  signature: string;
  reputation?: number;
}

export type Provenance =
  | { kind: "feed"; attribution: Attribution }
  | { kind: "crowd"; attribution: Attribution; reporter: ReporterRef };

export interface Observation {
  id: string;
  source: string;
  sourceFormat: SourceFormat;
  domain: ObservationDomain;
  kind: "event" | "measurement";

  subject?: SubjectRef[];
  geometry: GeoJsonGeometry;

  status: "active" | "inactive" | "archived" | "cancelled";
  validFrom?: string | null;
  validTo?: string | null;
  schedule?: Schedule[];
  confidence?: Confidence;
  isForecast?: boolean;

  label?: string;

  origin: Provenance;
  dataUpdatedAt: string;
  fetchedAt: string;
  expiresAt?: string;
  isStale: boolean;

  relatedIds?: string[];

  /**
   * Other sources whose duplicate of this condition was merged into this one by
   * the aggregator's cross-source dedup. Absent on observations that were never
   * merged. See `dedupeAcrossSources`.
   */
  mergedSources?: MergedSource[];

  /** Stable id of the concrete report instance this observation came from. */
  instanceId?: string;
  /** Id of the canonical condition this observation resolves to (fusion key). */
  canonicalId?: string;
  /** Hash grouping observations that describe the same real-world phenomenon. */
  phenomenonFingerprint?: string;
  /** Canonical ids this observation supersedes. */
  replaces?: string[];
  /** Ids of independent observations that corroborate this one. */
  corroborations?: string[];
  /** How precisely the geometry/extent is known (defaults to `exact`). */
  fuzziness?: Fuzziness;
  /** Normalized [0,1] confidence for this observation. */
  confidenceScore?: number;
  /**
   * Crowd-evidence lifecycle state, materialized from the authoritative
   * `report_evidence` ledger by the evidence policy. NULL/absent on non-crowd
   * (feed) rows; a parser must never assert it.
   */
  evidenceState?: EvidenceState;
  /**
   * Whether this observation is routing-eligible. Only an external resolution
   * sets it; peer corroboration never does. Derived, never parser-supplied.
   */
  routingEligible?: boolean;
  /** Privacy tier this observation was produced under. */
  privacyClass?: PrivacyClass;
  /** k for k-anonymity, when the observation is a k-anonymized aggregate. */
  kAnonymity?: number;
  /** Differential-privacy epsilon budget spent, when DP-noised. */
  dpEpsilon?: number;
  /** Differential-privacy delta parameter, when DP-noised. */
  dpDelta?: number;
  /** Transit entities this observation informs (modes/routes/stops/trips). */
  informed?: { modes?: string[]; routes?: string[]; stops?: string[]; trips?: string[] };
  /** Canonical URI of the upstream record this observation derives from. */
  sourceUri?: string;
  /** SPDX license the upstream source is published under. */
  sourceLicense?: string;
}

export interface ConditionEvent extends Observation {
  kind: "event";
  type: string;
  subtype?: string;
  category: "incident" | "planned" | "conditions" | "report";
  severity: Severity;
  /** Numeric 1–5 severity, when a controller assigns a graded level. */
  severityLevel?: 1 | 2 | 3 | 4 | 5;
  severitySource: "declared" | "derived";
  headline: string;
  description?: string;
}

export interface Measurement extends Observation {
  kind: "measurement";
  metric: string;
  value?: number;
  level?: string;
  unit?: string;
  scale?: { min: number; max: number } | string;
  aggregation: "live" | "typical" | "forecast";
  window?: { start: string; end: string };
}
