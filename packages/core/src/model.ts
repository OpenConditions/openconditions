import type { Geometry, LineString, MultiLineString, Point } from "geojson";

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
  | "gtfs-rt"
  | "native"
  | "crowd";

export type ObservationDomain = "roads" | "transit" | "places" | string;

export type Severity = "low" | "medium" | "high" | "critical" | "unknown";

export type Confidence = "observed" | "likely" | "possible" | "unknown";

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
}

export interface ConditionEvent extends Observation {
  kind: "event";
  type: string;
  subtype?: string;
  category: "incident" | "planned" | "conditions" | "report";
  severity: Severity;
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
