import { toIsoTimestamp } from "@openconditions/core";
import { dedupeRoadEvents } from "./dedupe.js";
import { recordSkippedNoGeometry } from "./skip-metrics.js";
import type { RoadEvent, RoadEventType } from "./model.js";
import type { TypeMapping } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Parser for the iPeloton / IBI Group ("Transnomis") 511 platform — the shared
 * `/api/v2/get/event` JSON shape behind ~18 US/Canada state and provincial 511
 * sites (Ontario, 511NY, Idaho, …). One parser covers the whole fleet; each
 * jurisdiction is a feed-registry entry (host + key). Mirrors the camera-side
 * IBI511 adapter already shipped in OpenMapX.
 *
 * The response is a JSON array of event objects with a fixed field set. Geometry
 * comes from `EncodedPolyline` (Google polyline → LineString) when present, else
 * the `Latitude`/`Longitude` point (with `LatitudeSecondary`/`LongitudeSecondary`
 * forming a 2-point line when both ends are given).
 */

interface IbiEvent {
  ID?: string | number;
  RoadwayName?: string;
  DirectionOfTravel?: string;
  Description?: string;
  // The live feed sends these as Unix epoch seconds (numbers), despite older
  // docs implying date strings; `toIsoTimestamp` normalises either shape.
  LastUpdated?: string | number;
  StartDate?: string | number;
  PlannedEndDate?: string | number;
  EventType?: string;
  EventSubType?: string;
  IsFullClosure?: boolean;
  Severity?: string;
  EncodedPolyline?: string;
  Latitude?: number;
  Longitude?: number;
  LatitudeSecondary?: number;
  LongitudeSecondary?: number;
}

const TYPE_BY_EVENTTYPE: Record<string, TypeMapping> = {
  roadwork: { type: "roadworks", category: "planned", isPlanned: true },
  closures: { type: "road_closure", category: "incident", isPlanned: false },
  accidentsandincidents: { type: "accident", category: "incident", isPlanned: false },
};

const SEVERITY_MAP: Record<string, RoadEvent["severity"]> = {
  minor: "low",
  low: "low",
  moderate: "medium",
  medium: "medium",
  major: "high",
  high: "high",
  severe: "critical",
  critical: "critical",
};

/** Decode a Google-encoded polyline (precision 5) to [lng,lat] pairs. */
function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

function geometryOf(ev: IbiEvent): RoadEvent["geometry"] | null {
  if (typeof ev.EncodedPolyline === "string" && ev.EncodedPolyline.length > 0) {
    const pts = decodePolyline(ev.EncodedPolyline).filter(
      ([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat)
    );
    if (pts.length >= 2) return { type: "LineString", coordinates: pts };
    if (pts.length === 1) return { type: "Point", coordinates: pts[0]! };
  }
  const lat = ev.Latitude;
  const lng = ev.Longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const lat2 = ev.LatitudeSecondary;
  const lng2 = ev.LongitudeSecondary;
  if (Number.isFinite(lat2) && Number.isFinite(lng2) && (lat2 !== lat || lng2 !== lng)) {
    return {
      type: "LineString",
      coordinates: [
        [lng as number, lat as number],
        [lng2 as number, lat2 as number],
      ],
    };
  }
  return { type: "Point", coordinates: [lng as number, lat as number] };
}

function typeOf(ev: IbiEvent): TypeMapping {
  const key = (ev.EventType ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const base = TYPE_BY_EVENTTYPE[key] ?? {
    type: "other" as RoadEventType,
    category: "conditions" as const,
    isPlanned: false,
  };
  // A full closure is a road_closure regardless of the coarse EventType bucket.
  if (ev.IsFullClosure === true) {
    return { type: "road_closure", category: "incident", isPlanned: false };
  }
  return base;
}

export function parseIbi511(input: string | Buffer | unknown, src: SourceDescriptor): RoadEvent[] {
  let data: unknown = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try {
      data = JSON.parse(input.toString("utf8"));
    } catch {
      return [];
    }
  }
  const events = Array.isArray(data) ? (data as IbiEvent[]) : [];
  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;

  events.forEach((ev, index) => {
    const geometry = geometryOf(ev);
    if (!geometry) {
      skippedNoGeometry++;
      return;
    }
    const { type, category, isPlanned } = typeOf(ev);
    const localId = ev.ID != null ? String(ev.ID) : String(index);
    const severity = ev.Severity
      ? (SEVERITY_MAP[ev.Severity.toLowerCase()] ?? "unknown")
      : "unknown";
    const road = typeof ev.RoadwayName === "string" && ev.RoadwayName ? ev.RoadwayName : undefined;
    const headline =
      typeof ev.Description === "string" && ev.Description ? ev.Description : (road ?? type);

    out.push({
      id: `${src.id}:${localId}`,
      source: src.id,
      sourceFormat: "ibi511",
      domain: "roads",
      kind: "event",
      type,
      subtype: ev.EventSubType ?? ev.EventType ?? undefined,
      category,
      isPlanned,
      severity,
      severitySource: severity === "unknown" ? "derived" : "declared",
      status: "active",
      geometry,
      direction: ev.DirectionOfTravel || undefined,
      roads: road ? [{ name: road }] : [],
      headline,
      description: typeof ev.Description === "string" ? ev.Description : undefined,
      validFrom: toIsoTimestamp(ev.StartDate) ?? null,
      validTo: toIsoTimestamp(ev.PlannedEndDate) ?? null,
      sourceRaw: ev as Record<string, unknown>,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: toIsoTimestamp(ev.LastUpdated) ?? new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      isStale: false,
    });
  });

  if (skippedNoGeometry > 0) {
    console.debug(
      `[ibi511] ${src.id}: skipped ${skippedNoGeometry} record(s) with no usable geometry`
    );
    recordSkippedNoGeometry(src.id, skippedNoGeometry);
  }

  return dedupeRoadEvents(out);
}

/**
 * The same platform's road/winter-condition resources (`/get/roadconditions`,
 * `/get/winterroads`). Structurally a sibling of the event resource but with a
 * different field set, so it gets its own parser rather than a branch inside
 * {@link parseIbi511}.
 *
 * Two shape differences between jurisdictions are handled here: v3 sends
 * `EncodedPolyline` as an ARRAY of polylines (→ MultiLineString) where v2 sends
 * a single string, and 511NY names the same field `Polyline`.
 */
interface IbiConditionRecord {
  LocationDescription?: string;
  AreaName?: string;
  Region?: string;
  RoadwayName?: string;
  Condition?: string | string[];
  Visibility?: string | null;
  Drifting?: string | null;
  EncodedPolyline?: string | string[];
  Polyline?: string | string[];
  LastUpdated?: string | number;
}

/**
 * Condition values that report an ABSENCE of anything worth showing: a clear
 * road, or no report at all. A record whose every condition is nominal is
 * skipped, mirroring the Iceland baseline rule — otherwise a whole province of
 * "Bare and Dry" segments would drown the genuinely affected ones.
 */
const NOMINAL_CONDITIONS = new Set([
  "no report",
  "update pending",
  "bare and dry",
  "bare & dry",
  "bare",
  "dry",
  "generally clear & dry",
  "generally clear and dry",
  "clear",
  "bare pavement",
  "good winter driving conditions",
]);

/** Adverse conditions that block or effectively block the road. */
const CLOSED_CONDITIONS = new Set(["closed", "impassable", "road closed", "travel not advised"]);

/**
 * Severity by condition text: a closure is critical, ice/snow cover is high,
 * partly-covered or slushy surfaces are medium, and anything else adverse but
 * unrecognised stays low rather than overstating what the feed said.
 */
function conditionSeverity(conditions: string[]): RoadEvent["severity"] {
  const lower = conditions.map((c) => c.toLowerCase());
  if (lower.some((c) => CLOSED_CONDITIONS.has(c))) return "critical";
  if (lower.some((c) => /ice|icy|snow covered|snow \/ ice|snow packed/.test(c))) return "high";
  if (lower.some((c) => /snow|slush|partly|wet/.test(c))) return "medium";
  return "low";
}

function conditionValues(raw: IbiConditionRecord["Condition"]): string[] {
  if (Array.isArray(raw)) return raw.filter((c): c is string => typeof c === "string" && c !== "");
  return typeof raw === "string" && raw ? [raw] : [];
}

/**
 * Build geometry from the record's polyline field, honouring 511NY's `Polyline`
 * alias and v3's array form (several encoded lines → MultiLineString).
 */
function conditionGeometry(rec: IbiConditionRecord): RoadEvent["geometry"] | undefined {
  const raw = rec.EncodedPolyline ?? rec.Polyline;
  const encoded = (Array.isArray(raw) ? raw : [raw]).filter(
    (p): p is string => typeof p === "string" && p.length > 0
  );
  const lines = encoded
    .map((p) =>
      decodePolyline(p).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
    )
    .filter((pts) => pts.length >= 2);
  if (lines.length === 0) return undefined;
  return lines.length === 1
    ? { type: "LineString", coordinates: lines[0]! }
    : { type: "MultiLineString", coordinates: lines };
}

/**
 * Parse an IBI 511 road/winter-conditions payload into RoadEvents. Records whose
 * conditions are all nominal, or that carry no usable geometry, are skipped;
 * a malformed body yields [].
 */
export function parseIbi511Conditions(
  input: string | Buffer | unknown,
  src: SourceDescriptor
): RoadEvent[] {
  let data: unknown = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try {
      data = JSON.parse(input.toString("utf8"));
    } catch {
      return [];
    }
  }
  const records = Array.isArray(data) ? (data as IbiConditionRecord[]) : [];
  const now = new Date().toISOString();
  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;

  records.forEach((rec, index) => {
    const conditions = conditionValues(rec.Condition);
    if (conditions.length === 0) return;
    if (conditions.every((c) => NOMINAL_CONDITIONS.has(c.toLowerCase()))) return;

    const geometry = conditionGeometry(rec);
    if (!geometry) {
      skippedNoGeometry++;
      return;
    }

    const road = rec.RoadwayName || undefined;
    const where = rec.LocationDescription || rec.AreaName || rec.Region || road;
    const label = conditions.join(", ");
    const severity = conditionSeverity(conditions);
    const closed = conditions.some((c) => CLOSED_CONDITIONS.has(c.toLowerCase()));

    out.push({
      id: `${src.id}:${road ?? "seg"}-${index}`,
      source: src.id,
      sourceFormat: "ibi511",
      domain: "roads",
      kind: "event",
      type: closed ? "road_closure" : "weather",
      subtype: label,
      category: closed ? "incident" : "conditions",
      isPlanned: false,
      severity,
      severitySource: "derived",
      status: "active",
      geometry,
      ...(closed ? { roadState: "closed" as const } : {}),
      roads: road ? [{ name: road }] : [],
      headline: where ? `${label} — ${where}` : label,
      description: rec.LocationDescription || undefined,
      validFrom: null,
      validTo: null,
      sourceRaw: rec as Record<string, unknown>,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: toIsoTimestamp(rec.LastUpdated) ?? now,
      fetchedAt: now,
      isStale: false,
    });
  });

  if (skippedNoGeometry > 0) {
    console.debug(
      `[ibi511] ${src.id}: skipped ${skippedNoGeometry} record(s) with no usable geometry`
    );
    recordSkippedNoGeometry(src.id, skippedNoGeometry);
  }

  return dedupeRoadEvents(out);
}
