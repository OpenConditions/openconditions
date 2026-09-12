import { deriveSeverity } from "@openconditions/core";
import type { GeoJsonGeometry, Severity } from "@openconditions/core";
import type { Restriction, RoadEvent, RoadRef } from "./model.js";
import { digitrafficRestrictionDetails } from "./digitraffic-restrictions.js";
import { recordSkippedNoGeometry } from "./skip-metrics.js";
import {
  reconcileRoadSnapshots,
  snapshotFingerprint,
  type RoadSnapshotRecord,
  type RoadSnapshotReport,
} from "./snapshot.js";

import { mapSourceType } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";

interface DigitrafficTimeAndDuration {
  startTime?: unknown;
  endTime?: unknown;
}

interface DigitrafficAnnouncement {
  title?: unknown;
  timeAndDuration?: DigitrafficTimeAndDuration;
  [key: string]: unknown;
}

interface DigitrafficProperties {
  situationId?: unknown;
  situationType?: unknown;
  trafficAnnouncementType?: unknown;
  announcements?: unknown;
  dataUpdatedTime?: unknown;
  releaseTime?: unknown;
  [key: string]: unknown;
}

interface DigitrafficFeature {
  geometry?: unknown;
  properties?: DigitrafficProperties;
  [key: string]: unknown;
}

interface DigitrafficFeatureCollection {
  type?: unknown;
  features?: unknown;
  [key: string]: unknown;
}

function coerceString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Canonicalize a Digitraffic *enum* token. v1 published `SINGLE_LANE_CLOSED`;
 * v2 publishes `single lane closed`, so both editions normalize to one form.
 * Applied only to known enum fields — never to descriptions or free text.
 */
export function normalizeDtToken(value: string): string {
  return value.trim().replaceAll(" ", "_").replaceAll("-", "_").toUpperCase();
}

function firstAnnouncement(announcements: unknown): DigitrafficAnnouncement | null {
  if (!Array.isArray(announcements) || announcements.length === 0) return null;
  const first = announcements[0];
  return first && typeof first === "object" ? (first as DigitrafficAnnouncement) : null;
}

interface DigitrafficPrimaryPoint {
  roadName?: unknown;
  roadAddress?: { road?: unknown };
}

interface DtWorkType {
  type?: unknown;
}

interface DtRestriction {
  type?: unknown;
  restriction?: {
    quantity?: unknown;
    unit?: unknown;
    timeAndDuration?: DigitrafficTimeAndDuration;
  };
}

interface DtWorkingHour {
  weekday?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

interface DtRoadWorkPhase {
  severity?: unknown;
  workTypes?: DtWorkType[];
  restrictions?: DtRestriction[];
  workingHours?: DtWorkingHour[];
  comment?: unknown;
}

// Restriction-type groupings → canonical roadState (worst wins).
const DT_CLOSED = new Set([
  "ROAD_CLOSED",
  "INTERMITTENT_SHORT_TERM_CLOSURE",
  "SINGLE_CARRIAGEWAY_CLOSED",
]);
const DT_SOME = new Set(["SINGLE_LANE_CLOSED", "MULTIPLE_LANES_CLOSED", "NARROW_LANES"]);
const DT_ALT = new Set(["SINGLE_ALTERNATE_LINE_TRAFFIC", "TRAFFIC_LIGHTS"]);

function restrictionTypes(ann: DigitrafficAnnouncement | null): Set<string> {
  const types = new Set<string>();
  for (const p of roadWorkPhases(ann)) {
    for (const r of p.restrictions ?? []) {
      // v1 published SINGLE_LANE_CLOSED, v2 publishes "single lane closed".
      if (typeof r?.type === "string") types.add(normalizeDtToken(r.type));
    }
  }
  return types;
}

function roadStateFromPhases(
  ann: DigitrafficAnnouncement | null
): RoadEvent["roadState"] | undefined {
  const t = restrictionTypes(ann);
  if ([...t].some((x) => DT_CLOSED.has(x))) return "closed";
  if ([...t].some((x) => DT_SOME.has(x))) return "some_lanes_closed";
  if ([...t].some((x) => DT_ALT.has(x))) return "single_lane_alternating";
  return undefined;
}

function speedLimitFromPhases(ann: DigitrafficAnnouncement | null): number | undefined {
  let min: number | undefined;
  for (const p of roadWorkPhases(ann)) {
    for (const r of p.restrictions ?? []) {
      const type = typeof r?.type === "string" ? normalizeDtToken(r.type) : "";
      if (type === "SPEED_LIMIT" && typeof r.restriction?.quantity === "number") {
        min = min == null ? r.restriction.quantity : Math.min(min, r.restriction.quantity);
      }
    }
  }
  return min;
}

function locationDescription(ann: DigitrafficAnnouncement | null): string | undefined {
  const loc = ann?.["location"] as { description?: unknown } | undefined;
  return coerceString(loc?.description) ?? undefined;
}

function roadWorkPhases(ann: DigitrafficAnnouncement | null): DtRoadWorkPhase[] {
  const phases = ann?.["roadWorkPhases"];
  return Array.isArray(phases) ? (phases as DtRoadWorkPhase[]) : [];
}

const DT_SEVERITY_ORDER: Severity[] = ["low", "medium", "high", "critical"];

function mapDtSeverity(raw: unknown): Severity | undefined {
  switch (typeof raw === "string" ? normalizeDtToken(raw) : "") {
    case "LOW":
      return "low";
    case "HIGH":
      return "high";
    case "HIGHEST":
      return "critical";
    default:
      return undefined;
  }
}

/** Worst severity across the announcement's road-work phases. */
function severityFromPhases(ann: DigitrafficAnnouncement | null): Severity | undefined {
  let worst: Severity | undefined;
  for (const p of roadWorkPhases(ann)) {
    const s = mapDtSeverity(p.severity);
    if (s && (worst == null || DT_SEVERITY_ORDER.indexOf(s) > DT_SEVERITY_ORDER.indexOf(worst))) {
      worst = s;
    }
  }
  return worst;
}

function subtypeFromAnnouncement(ann: DigitrafficAnnouncement | null): string | undefined {
  const wt = roadWorkPhases(ann)[0]?.workTypes;
  if (Array.isArray(wt) && typeof wt[0]?.type === "string") return wt[0].type;
  const features = ann?.["features"];
  const first = Array.isArray(features) ? (features[0] as { name?: unknown }) : undefined;
  return typeof first?.name === "string" ? first.name : undefined;
}

function restrictionsFromPhases(ann: DigitrafficAnnouncement | null): Restriction[] | undefined {
  const out: Restriction[] = [];
  for (const p of roadWorkPhases(ann)) {
    for (const r of p.restrictions ?? []) {
      if (typeof r?.type !== "string") continue;
      const item: Restriction = { type: r.type };
      if (typeof r.restriction?.quantity === "number") item.value = r.restriction.quantity;
      if (typeof r.restriction?.unit === "string") item.unit = r.restriction.unit;
      const from = coerceString(r.restriction?.timeAndDuration?.startTime);
      const to = coerceString(r.restriction?.timeAndDuration?.endTime);
      if (from) item.validFrom = from;
      if (to) item.validTo = to;
      out.push(item);
    }
  }
  return out.length > 0 ? out : undefined;
}

// Finnish announcement-feature names → canonical dimension-restriction types.
const FEATURE_DIMENSION_TYPE: { match: string; type: string }[] = [
  { match: "leveys", type: "width" },
  { match: "korkeus", type: "height" },
  { match: "pituus", type: "length" },
  { match: "massa", type: "weight" },
];

interface DtAnnFeature {
  name?: unknown;
  quantity?: unknown;
  unit?: unknown;
}

function announcementFeatures(ann: DigitrafficAnnouncement | null): DtAnnFeature[] {
  const features = ann?.["features"];
  return Array.isArray(features) ? (features as DtAnnFeature[]) : [];
}

/**
 * Announcements without road-work phases (e.g. TRAFFIC_ANNOUNCEMENT records)
 * carry their structured restriction/speed data in `features[]` as
 * `{ name, quantity, unit }`. Derive a canonical speed limit from a Finnish
 * "Nopeusrajoitus" feature only when there are no phases to read it from.
 */
function speedLimitFromFeatures(ann: DigitrafficAnnouncement | null): number | undefined {
  if (roadWorkPhases(ann).length > 0) return undefined;
  for (const f of announcementFeatures(ann)) {
    const name = coerceString(f.name);
    if (name && name.toLowerCase().includes("nopeusrajoitus") && typeof f.quantity === "number") {
      return f.quantity;
    }
  }
  return undefined;
}

/** Dimension restrictions derived from phase-less announcement features. */
function restrictionsFromFeatures(ann: DigitrafficAnnouncement | null): Restriction[] | undefined {
  if (roadWorkPhases(ann).length > 0) return undefined;
  const out: Restriction[] = [];
  for (const f of announcementFeatures(ann)) {
    const name = coerceString(f.name);
    if (!name || typeof f.quantity !== "number") continue;
    const lower = name.toLowerCase();
    const dim = FEATURE_DIMENSION_TYPE.find((d) => lower.includes(d.match));
    if (!dim) continue;
    const item: Restriction = { type: dim.type, value: f.quantity };
    const unit = coerceString(f.unit);
    if (unit) item.unit = unit;
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function directionFromAnnouncement(ann: DigitrafficAnnouncement | null): string | undefined {
  const ral = (
    ann?.["locationDetails"] as
      { roadAddressLocation?: { direction?: unknown; directionDescription?: unknown } } | undefined
  )?.roadAddressLocation;
  const desc = coerceString(ral?.directionDescription);
  if (desc) return desc;
  const dir = coerceString(ral?.direction);
  return dir && dir.toUpperCase() !== "UNKNOWN" ? dir : undefined;
}

/** Road name + number live deep under the announcement's location details. */
function roadsFromAnnouncement(ann: DigitrafficAnnouncement | null): RoadRef[] {
  const ral = (
    ann?.["locationDetails"] as
      | {
          roadAddressLocation?: {
            primaryPoint?: DigitrafficPrimaryPoint;
            secondaryPoint?: DigitrafficPrimaryPoint;
          };
        }
      | undefined
  )?.roadAddressLocation;
  const primary = ral?.primaryPoint;
  if (!primary) return [];
  const name = coerceString(primary.roadName);
  const road = primary.roadAddress?.road;
  const ref = typeof road === "number" ? String(road) : coerceString(road);
  if (!name && !ref) return [];
  const roadRef: RoadRef = { name: name ?? ref!, ...(ref ? { ref } : {}) };
  // secondaryPoint marks the end of the affected segment.
  const to = coerceString(ral?.secondaryPoint?.roadName);
  if (to) roadRef.to = to;
  return [roadRef];
}

interface DtAdminPoint {
  municipality?: unknown;
  province?: unknown;
}

/** Distinct administrative areas (municipality/province + areaLocation names). */
function regionsFromAnnouncement(ann: DigitrafficAnnouncement | null): string[] | undefined {
  const locationDetails = ann?.["locationDetails"] as
    | {
        roadAddressLocation?: {
          primaryPoint?: DtAdminPoint;
          secondaryPoint?: DtAdminPoint;
        };
        areaLocation?: { areas?: { name?: unknown }[] };
      }
    | undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (v: unknown) => {
    const s = coerceString(v);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  const ral = locationDetails?.roadAddressLocation;
  add(ral?.primaryPoint?.municipality);
  add(ral?.primaryPoint?.province);
  add(ral?.secondaryPoint?.municipality);
  add(ral?.secondaryPoint?.province);
  for (const area of locationDetails?.areaLocation?.areas ?? []) {
    add(area?.name);
  }
  return out.length > 0 ? out : undefined;
}

/** Announcement comment plus any substantive road-work-phase comments. */
function descriptionFromAnnouncement(ann: DigitrafficAnnouncement | null): string | undefined {
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (v: unknown) => {
    const s = coerceString(v);
    if (s && !seen.has(s)) {
      seen.add(s);
      parts.push(s);
    }
  };
  add(ann?.["comment"]);
  for (const p of roadWorkPhases(ann)) {
    add(p.comment);
  }
  if (parts.length > 0) return parts.join("\n");
  return locationDescription(ann);
}

interface DtLocation {
  countryCode?: unknown;
  locationTableNumber?: unknown;
}

/**
 * Alert-C / TMC reference from the announcement's `location` block. Set
 * `tmc = { country, table, code }` only when the feed carries an Alert-C
 * country code; otherwise fall back to a provider-scoped `external` ref so the
 * location code is preserved without fabricating a country.
 */
function externalRefsFromAnnouncement(
  ann: DigitrafficAnnouncement | null
): RoadEvent["externalRefs"] {
  const location = ann?.["location"] as DtLocation | undefined;
  const ral = (
    ann?.["locationDetails"] as
      | { roadAddressLocation?: { primaryPoint?: { alertCLocation?: { locationCode?: unknown } } } }
      | undefined
  )?.roadAddressLocation;
  const codeNum = ral?.primaryPoint?.alertCLocation?.locationCode;
  if (typeof codeNum !== "number") return undefined;

  const country =
    typeof location?.countryCode === "number" ? String(location.countryCode) : undefined;
  const table =
    typeof location?.locationTableNumber === "number" ? location.locationTableNumber : undefined;

  if (country && table != null) {
    return { tmc: { country, table, code: codeNum } };
  }
  return { external: { system: "alertc-fi", code: String(codeNum) } };
}

/** Values of the source's early-closing field that terminate a record. */
const DT_TERMINAL: Record<string, "closed" | "canceled"> = {
  CLOSED: "closed",
  CANCELED: "canceled",
  CANCELLED: "canceled",
};

/**
 * Has the publisher explicitly ended this record? A terminal record withdraws
 * its predecessor whether or not it still carries geometry, so this is checked
 * before localization.
 */
function terminalStatusOf(
  props: DigitrafficProperties,
  ann: DigitrafficAnnouncement | null
): "closed" | "canceled" | undefined {
  for (const raw of [props["earlyClosing"], ann?.["earlyClosing"]]) {
    const token = coerceString(raw);
    if (token) {
      const mapped = DT_TERMINAL[normalizeDtToken(token)];
      if (mapped) return mapped;
    }
  }
  return undefined;
}

function readFeatureCollection(
  geojson: string | Buffer | object
): DigitrafficFeatureCollection | null {
  try {
    const str = Buffer.isBuffer(geojson) ? geojson.toString("utf8") : geojson;
    return (typeof str === "string" ? JSON.parse(str) : str) as DigitrafficFeatureCollection;
  } catch (err) {
    console.warn("[digitraffic] failed to parse JSON input:", err);
    return null;
  }
}

/** Build one road event from an already-validated feature. */
function buildDigitrafficEvent(
  props: DigitrafficProperties,
  geometry: GeoJsonGeometry,
  situationId: string,
  src: SourceDescriptor,
  fetchedAt: string
): RoadEvent {
  const situationType = coerceString(props.situationType) ?? "";
  const announcementType = coerceString(props.trafficAnnouncementType);
  const codeForMapping = announcementType ?? situationType;
  // The taxonomy crosswalk is keyed on the v1 underscore vocabulary, so the
  // v2 space-separated token is canonicalized before lookup. `subtype` keeps
  // the publisher's original token.
  const { type, category, isPlanned } = mapSourceType(
    "digitraffic",
    codeForMapping ? normalizeDtToken(codeForMapping) : ""
  );

  const ann = firstAnnouncement(props.announcements);
  const headline = coerceString(ann?.title) ?? type;
  const validFrom = coerceString(ann?.timeAndDuration?.startTime) ?? null;
  const validTo = coerceString(ann?.timeAndDuration?.endTime) ?? null;

  const phaseSeverity = severityFromPhases(ann);
  const severity = phaseSeverity ?? deriveSeverity({});

  const restrictions = restrictionsFromPhases(ann) ?? restrictionsFromFeatures(ann);
  const speedLimitKph = speedLimitFromPhases(ann) ?? speedLimitFromFeatures(ann);
  const terminal = terminalStatusOf(props, ann);
  const restrictionDetails = digitrafficRestrictionDetails(props as Record<string, unknown>, src);

  const dataUpdatedAt =
    coerceString(props.versionTime) ??
    coerceString(props.dataUpdatedTime) ??
    coerceString(props.releaseTime) ??
    fetchedAt;

  return {
    id: `${src.id}:${situationId}`,
    source: src.id,
    sourceFormat: "digitraffic",
    domain: "roads",
    kind: "event",
    type,
    subtype: subtypeFromAnnouncement(ann) ?? (codeForMapping || undefined),
    category,
    isPlanned,
    severity,
    severitySource: phaseSeverity ? "declared" : "derived",
    // An explicitly closed record is inactive, not merely absent; a cancelled
    // one keeps its own status. No cancellation timestamp is invented.
    status: terminal === "canceled" ? "cancelled" : terminal === "closed" ? "inactive" : "active",
    geometry,
    direction: directionFromAnnouncement(ann),
    roads: roadsFromAnnouncement(ann),
    roadState: roadStateFromPhases(ann),
    speedLimitKph,
    restrictions,
    ...(restrictionDetails !== undefined ? { restrictionDetails } : {}),
    regions: regionsFromAnnouncement(ann),
    externalRefs: externalRefsFromAnnouncement(ann),
    // Source working hours are when a crew is on site, not when the event
    // applies. Copying them here made a roadwork look inactive overnight and a
    // phase-scoped limit look as though it switched off; they now travel only
    // as restriction display context.
    headline,
    description: descriptionFromAnnouncement(ann),
    validFrom,
    validTo,
    sourceRaw: props as Record<string, unknown>,
    origin: {
      kind: "feed",
      attribution: {
        provider: src.attribution,
        license: src.license,
        url: src.licenseUrl,
      },
    },
    dataUpdatedAt,
    fetchedAt,
    isStale: false,
  };
}

interface DigitrafficRecordResult {
  record?: RoadSnapshotRecord;
  error?: { code: string; id: string | null; sourcePath: string };
  skippedNoGeometry?: true;
}

/**
 * Account for exactly one source feature. Each feature becomes a disposition,
 * never a silent drop: a feature with no stable identity is an error rather
 * than an index-numbered event, and a valid record whose geometry is missing is
 * `unlocatable` rather than absent.
 */
function digitrafficSnapshotRecord(
  rawFeature: unknown,
  sourcePath: string,
  src: SourceDescriptor,
  fetchedAt: string
): DigitrafficRecordResult {
  let situationId: string | null = null;
  try {
    const feature = rawFeature as DigitrafficFeature;
    const props = feature.properties ?? {};
    situationId = coerceString(props.situationId);
    if (!situationId) {
      return { error: { code: "missing_identity", id: null, sourcePath } };
    }
    const id = `${src.id}:${situationId}`;
    const rawVersion = props["version"];
    const version =
      typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion >= 0
        ? rawVersion
        : null;
    if (rawVersion != null && version === null) {
      return { error: { code: "invalid_version", id, sourcePath: `${sourcePath}.version` } };
    }
    const versionTime = coerceString(props.versionTime);
    if (versionTime !== null && !Number.isFinite(Date.parse(versionTime))) {
      return {
        error: { code: "invalid_version_time", id, sourcePath: `${sourcePath}.versionTime` },
      };
    }

    const ann = firstAnnouncement(props.announcements);
    const terminal = terminalStatusOf(props, ann);
    const geometry = feature.geometry;
    const hasGeometry =
      geometry != null &&
      typeof geometry === "object" &&
      "type" in (geometry as object) &&
      (geometry as { type?: unknown }).type != null;

    if (terminal) {
      // Checked before localization, so an explicitly ended record can still
      // withdraw its predecessor with no geometry of its own.
      return {
        record: {
          id,
          version,
          versionTime,
          fingerprint: canonicalTerminalFingerprint(id, terminal, version, versionTime),
          disposition: "terminal",
        },
      };
    }

    if (!hasGeometry) {
      return {
        record: {
          id,
          version,
          versionTime,
          fingerprint: `unlocatable:${id}`,
          disposition: "unlocatable",
        },
        skippedNoGeometry: true,
      };
    }

    const event = buildDigitrafficEvent(
      props,
      geometry as GeoJsonGeometry,
      situationId,
      src,
      fetchedAt
    );
    return {
      record: {
        id,
        version,
        versionTime,
        fingerprint: snapshotFingerprint(event),
        disposition: "accepted",
        event,
      },
    };
  } catch (err) {
    console.warn("[digitraffic] skipped malformed feature:", situationId, err);
    return {
      error: {
        code: "malformed_record",
        id: situationId === null ? null : `${src.id}:${situationId}`,
        sourcePath,
      },
    };
  }
}

function canonicalTerminalFingerprint(
  id: string,
  terminal: string,
  version: number | null,
  versionTime: string | null
): string {
  return `terminal:${id}:${terminal}:${version ?? ""}:${versionTime ?? ""}`;
}

/**
 * Account for every record of one Digitraffic partition, reporting rather than
 * suppressing errors. The tolerant array-returning `parseDigitraffic` wrapper
 * stays available for sources that do not declare a complete snapshot.
 */
export function parseDigitrafficSnapshot(
  input: unknown,
  src: SourceDescriptor,
  opts: { fetchedAt?: string } = {}
): RoadSnapshotReport {
  const fetchedAt = opts.fetchedAt ?? new Date().toISOString();
  const payload = readFeatureCollection(input as string | Buffer | object);
  if (payload === null || typeof payload !== "object") {
    return {
      inputCount: 0,
      records: [],
      errors: [{ code: "invalid_envelope", id: null, sourcePath: "$" }],
    };
  }
  const features = payload.features;
  if (!Array.isArray(features)) {
    return {
      inputCount: 0,
      records: [],
      errors: [{ code: "missing_records_path", id: null, sourcePath: "features" }],
    };
  }

  const records: RoadSnapshotRecord[] = [];
  const errors: RoadSnapshotReport["errors"] = [];
  let skippedNoGeometry = 0;
  features.forEach((feature, index) => {
    const outcome = digitrafficSnapshotRecord(feature, `features[${index}]`, src, fetchedAt);
    if (outcome.error) errors.push(outcome.error);
    if (outcome.record) records.push(outcome.record);
    if (outcome.skippedNoGeometry) skippedNoGeometry++;
  });
  if (skippedNoGeometry > 0) recordSkippedNoGeometry(src.id, skippedNoGeometry);
  return { inputCount: features.length, records, errors };
}

/**
 * Parse a Digitraffic (Fintraffic) traffic-message Simple GeoJSON feed and
 * return an array of RoadEvent observations. Invalid input yields an empty
 * array; per-feature problems are logged and skipped.
 *
 * Records are reconciled by their own `situationId`, not by proximity: two
 * distinct situations at one coordinate are two facts, and merging them would
 * lose one of them.
 */
export function parseDigitraffic(
  geojson: string | Buffer | object,
  src: SourceDescriptor
): RoadEvent[] {
  const report = parseDigitrafficSnapshot(geojson, src);
  if (report.errors.length > 0) {
    for (const error of report.errors) {
      console.warn(`[digitraffic] ${src.id}: ${error.code} at ${error.sourcePath}`);
    }
  }
  const tolerant: RoadSnapshotReport = {
    inputCount: report.records.length,
    records: report.records,
    errors: [],
  };
  try {
    return reconcileRoadSnapshots([tolerant]).observations as RoadEvent[];
  } catch (err) {
    // The tolerant entry point never fails a whole feed on a version conflict;
    // the reporting entry point is where such a snapshot is rejected.
    console.warn(`[digitraffic] ${src.id}: reconciliation fell back to last-wins:`, err);
    const byId = new Map<string, RoadEvent>();
    for (const record of report.records) {
      if (record.disposition === "accepted" && record.event) {
        byId.set(record.id, record.event as RoadEvent);
      }
    }
    return [...byId.values()];
  }
}
