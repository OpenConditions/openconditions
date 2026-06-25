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
  | "traff"
  | "autobahn-json"
  | "digitraffic-json"
  | "gtfs-rt"
  | "native"
  | "crowd";

export type ObservationDomain = "roads" | "transit" | "places" | string;

export type Severity = "low" | "medium" | "high" | "critical" | "unknown";

export type Confidence = "observed" | "likely" | "possible" | "unknown";

export interface RecurringWindow {
  dayOfWeek?: number[];
  timeStart?: string;
  timeEnd?: string;
  /** Date the recurrence applies from/until (ISO date), when bounded. */
  dateStart?: string;
  dateEnd?: string;
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
  schedule?: RecurringWindow[];
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
