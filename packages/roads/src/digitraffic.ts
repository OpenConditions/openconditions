import { deriveSeverity } from "@openconditions/core";
import type { GeoJsonGeometry, Severity } from "@openconditions/core";
import type { Restriction, RoadEvent, RoadRef } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
import { buildLocalSchedule, isoDayToICal, type LocalSchedule, withTimezone } from "./schedule.js";

/** Digitraffic is the Finnish national feed → its local times are Europe/Helsinki. */
const HELSINKI_TZ = "Europe/Helsinki";
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

const WEEKDAY: Record<string, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

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
      if (typeof r?.type === "string") types.add(r.type);
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
      if (r?.type === "SPEED_LIMIT" && typeof r.restriction?.quantity === "number") {
        min = min == null ? r.restriction.quantity : Math.min(min, r.restriction.quantity);
      }
    }
  }
  return min;
}

function scheduleFromPhases(ann: DigitrafficAnnouncement | null): LocalSchedule[] | undefined {
  const out: LocalSchedule[] = [];
  for (const p of roadWorkPhases(ann)) {
    for (const wh of p.workingHours ?? []) {
      const isoDay = typeof wh.weekday === "string" ? WEEKDAY[wh.weekday.toUpperCase()] : undefined;
      const iCal = isoDay ? isoDayToICal(isoDay) : undefined;
      const startTime = typeof wh.startTime === "string" ? wh.startTime : undefined;
      const endTime = typeof wh.endTime === "string" ? wh.endTime : undefined;
      if (!iCal && !startTime && !endTime) continue;
      out.push(buildLocalSchedule({ startTime, endTime, byDay: iCal ? [iCal] : undefined }));
    }
  }
  return out.length > 0 ? out : undefined;
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
  switch (typeof raw === "string" ? raw.toUpperCase() : "") {
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
      | { roadAddressLocation?: { direction?: unknown; directionDescription?: unknown } }
      | undefined
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

/**
 * Parse a Digitraffic (Fintraffic) traffic-message Simple GeoJSON feed and
 * return an array of RoadEvent observations. Features lacking geometry are
 * skipped. The result is deduped before return.
 */
export function parseDigitraffic(
  geojson: string | Buffer | object,
  src: SourceDescriptor
): RoadEvent[] {
  let payload: DigitrafficFeatureCollection;
  try {
    const str = Buffer.isBuffer(geojson) ? geojson.toString("utf8") : geojson;
    payload = (typeof str === "string" ? JSON.parse(str) : str) as DigitrafficFeatureCollection;
  } catch (err) {
    console.warn("[digitraffic] failed to parse JSON input:", err);
    return [];
  }

  const features = payload.features;
  if (!Array.isArray(features) || features.length === 0) return [];

  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;
  let localCounter = 0;

  for (const rawFeature of features) {
    try {
      const feature = rawFeature as DigitrafficFeature;
      const geometry = feature.geometry;

      if (
        !geometry ||
        typeof geometry !== "object" ||
        !("type" in (geometry as object)) ||
        (geometry as { type?: unknown }).type == null
      ) {
        skippedNoGeometry++;
        const sid = feature.properties?.situationId ?? "unknown";
        console.debug(`[digitraffic] skipped geometry-less feature: ${String(sid)}`);
        continue;
      }

      localCounter++;
      const props = feature.properties ?? {};

      const situationId = coerceString(props.situationId) ?? `digitraffic-${localCounter}`;
      const situationType = coerceString(props.situationType) ?? "";
      const announcementType = coerceString(props.trafficAnnouncementType);

      const codeForMapping = announcementType ?? situationType;
      const { type, category, isPlanned } = mapSourceType("digitraffic", codeForMapping);

      const ann = firstAnnouncement(props.announcements);
      const headline = coerceString(ann?.title) ?? type;
      const validFrom = coerceString(ann?.timeAndDuration?.startTime) ?? null;
      const validTo = coerceString(ann?.timeAndDuration?.endTime) ?? null;

      const phaseSeverity = severityFromPhases(ann);
      const severity = phaseSeverity ?? deriveSeverity({});

      const restrictions = restrictionsFromPhases(ann) ?? restrictionsFromFeatures(ann);
      const speedLimitKph = speedLimitFromPhases(ann) ?? speedLimitFromFeatures(ann);

      const dataUpdatedAt =
        coerceString(props.dataUpdatedTime) ??
        coerceString(props.releaseTime) ??
        new Date().toISOString();

      out.push({
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
        status: "active",
        geometry: geometry as GeoJsonGeometry,
        direction: directionFromAnnouncement(ann),
        roads: roadsFromAnnouncement(ann),
        roadState: roadStateFromPhases(ann),
        speedLimitKph,
        restrictions,
        regions: regionsFromAnnouncement(ann),
        externalRefs: externalRefsFromAnnouncement(ann),
        schedule: withTimezone(scheduleFromPhases(ann), HELSINKI_TZ),
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
        fetchedAt: new Date().toISOString(),
        isStale: false,
      });
    } catch (err) {
      const sid = (rawFeature as DigitrafficFeature)?.properties?.situationId;
      console.warn("[digitraffic] skipped malformed feature:", sid, err);
    }
  }

  if (skippedNoGeometry > 0) {
    console.debug(`[digitraffic] skipped ${skippedNoGeometry} feature(s) with no usable geometry`);
  }

  return dedupeRoadEvents(out);
}
