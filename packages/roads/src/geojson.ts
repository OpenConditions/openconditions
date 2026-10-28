import {
  type Severity,
  type SourceTimes,
  sourceTimestamp,
  validityBound,
} from "@openconditions/core";
import {
  readFeatureCollection,
  recordSkipped,
  reprojectGeometry,
} from "@openconditions/ingest-framework";
import { jcs, sha256Hex } from "@openconditions/model";
import { type RoadClassification, registeredClassification } from "@openconditions/model-roads";
import type { Geometry } from "geojson";
import { dedupeRoadEvents, dropSupersededRoadEvents } from "./dedupe.js";
import {
  type GeoJsonMapping,
  isRoadEventType,
  type RoadEvent,
  type RoadEventType,
} from "./model.js";
import { type CoarseType, coarseOf, coarseType } from "./situation/classes.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Generic reader for plain GeoJSON FeatureCollections and Esri ArcGIS
 * `f=geojson` exports. Driven entirely by the feed's {@link GeoJsonMapping}
 * (which `properties` keys carry id/type/headline/severity/road/timestamp), so
 * adding such a source is a registry entry, not new code. Geometry is taken
 * verbatim (GeoJSON is WGS84 per RFC 7946); the whole `properties` object is
 * preserved in `sourceRaw` so nothing is dropped.
 */

interface Feature {
  id?: string | number;
  geometry?: Geometry | null;
  properties?: Record<string, unknown> | null;
}

/** Dotted-path lookup within a feature's `properties`. */
function get(props: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined;
  if (path in props) return props[path];
  let cur: unknown = props;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * A feature's properties as the mapping reads them: values the feed writes
 * for "nothing" (`nullValues`, e.g. the string `"null"` or `"keine Meldung"`)
 * are absent. The raw properties are kept as published.
 */
function withoutPlaceholders(
  props: Record<string, unknown>,
  mapping: GeoJsonMapping,
): Record<string, unknown> {
  const placeholders = mapping.nullValues;
  if (!placeholders?.length) return props;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string" && placeholders.includes(value.trim())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Whether a feature satisfies every filter clause. A missing value passes an
 * `exclude` clause (there is nothing to exclude) and fails an `include` one
 * (there is nothing to match), so a sparse discriminator narrows rather than
 * silently widening the set.
 */
function passesFilter(props: Record<string, unknown>, mapping: GeoJsonMapping): boolean {
  if (!mapping.filter || mapping.filter.length === 0) return true;
  return mapping.filter.every((clause) => {
    const value = str(get(props, clause.field));
    if (clause.include && (value === undefined || !clause.include.includes(value))) return false;
    if (clause.exclude && value !== undefined && clause.exclude.includes(value)) return false;
    const matches = (patterns: string[]) =>
      value !== undefined && patterns.some((p) => new RegExp(p, "iu").test(value));
    if (clause.includeMatching && !matches(clause.includeMatching)) return false;
    if (clause.excludeMatching && matches(clause.excludeMatching)) return false;
    return true;
  });
}

/**
 * A LineString from four WGS84 lon/lat properties, for feeds that publish a
 * segment's endpoints as columns rather than as geometry (Iceland's line layer
 * ships `geometry: null` beside WGS84 START/END columns while its own geometry
 * is EPSG:3057). Properties are never reprojected — the values must already be
 * WGS84. Returns undefined unless all four parse.
 */
function synthesizeLine(
  props: Record<string, unknown>,
  mapping: GeoJsonMapping,
): Geometry | undefined {
  const { startLonField, startLatField, endLonField, endLatField } = mapping;
  if (!startLonField || !startLatField || !endLonField || !endLatField) return undefined;
  const coords = [
    [Number(get(props, startLonField)), Number(get(props, startLatField))],
    [Number(get(props, endLonField)), Number(get(props, endLatField))],
  ];
  if (coords.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat))) return undefined;
  return { type: "LineString", coordinates: coords };
}

/**
 * What a feature's type value means under the feed's mapping: its `typeMap`
 * entry, else the feed's `defaultType`. A situation-code entry is the
 * classification, and the coarse type follows from it. `unmapped` is set
 * when the mapping has a `typeMap` and the value names nothing it reads.
 */
function resolveType(
  rawType: string | undefined,
  mapping: GeoJsonMapping,
): CoarseType & { classification?: RoadClassification; unmapped?: true } {
  const mapped = rawType
    ? (mapping.typeMap?.[rawType] ?? mapping.typeMap?.[rawType.toLowerCase()])
    : undefined;
  if (mapped !== undefined && isRoadEventType(mapped)) return coarseType(mapped);
  const classification = mapped !== undefined ? registeredClassification(mapped) : undefined;
  if (classification !== undefined) return { ...coarseOf(classification), classification };
  const fallback = coarseType(mapping.defaultType ?? "other");
  return rawType !== undefined && mapping.typeMap !== undefined
    ? { ...fallback, unmapped: true }
    : fallback;
}

/** A feature's severity under the feed's `severityMap`; `unmapped` when the map does not hold the value. */
function resolveSeverity(
  raw: string | undefined,
  mapping: GeoJsonMapping,
): { severity: Severity; severitySource: "declared" | "derived"; unmapped?: true } {
  if (raw && (mapping.severityMap || mapping.severityPatterns)) {
    const mapped = mapping.severityMap?.[raw] ?? mapping.severityMap?.[raw.toLowerCase()];
    if (mapped) return { severity: mapped, severitySource: "declared" };
    const matched = mapping.severityPatterns?.find((p) => new RegExp(p.match, "iu").test(raw));
    if (matched) return { severity: matched.severity, severitySource: "declared" };
    return { severity: "unknown", severitySource: "derived", unmapped: true };
  }
  return { severity: "unknown", severitySource: "derived" };
}

/** Whether the feed marks a feature as a follow-up of an earlier record (see `followUp`). */
function isFollowUp(props: Record<string, unknown>, mapping: GeoJsonMapping): boolean {
  if (!mapping.followUp) return false;
  const marker = str(get(props, mapping.followUp.field));
  return marker !== undefined && mapping.followUp.prefixes.some((p) => marker.startsWith(p));
}

/** How the feed writes its validity's times: its zone, its UTC marks, its days. */
const timesOf = (src: SourceDescriptor, mapping: GeoJsonMapping): SourceTimes => ({
  ...(src.timeZone ? { timeZone: src.timeZone } : {}),
  ...(src.localTimesMarkedUtc ? { localTimesMarkedUtc: true } : {}),
  ...(mapping.validityDaysAtMidnight ? { daysAtMidnight: true } : {}),
});

/** One bound of a feature's validity ({@link validityBound}), null when it reads as none. */
const boundOf = (value: unknown, bound: "start" | "end", times: SourceTimes): string | null =>
  validityBound(value, bound, times) ?? null;

/**
 * One event per id. A publisher that exports a record in several parts (one
 * closure as several lines) repeats its id on each; the parts become one
 * event whose geometry holds them all, read as the first part says.
 */
function mergeParts(events: RoadEvent[]): RoadEvent[] {
  const byId = new Map<string, RoadEvent[]>();
  for (const e of events) {
    const parts = byId.get(e.id);
    if (parts) parts.push(e);
    else byId.set(e.id, [e]);
  }
  if (byId.size === events.length) return events;
  return [...byId.values()].map(([first, ...rest]) =>
    rest.length === 0
      ? (first as RoadEvent)
      : {
          ...(first as RoadEvent),
          geometry: joinGeometries([first, ...rest].map((p) => (p as RoadEvent).geometry)),
        },
  );
}

/** Several geometries as one: a Multi- geometry of one kind, else a collection. */
function joinGeometries(geometries: Geometry[]): Geometry {
  const flat = geometries.flatMap((g) => (g.type === "GeometryCollection" ? g.geometries : [g]));
  const kinds = new Set(flat.map((g) => g.type.replace(/^Multi/, "")));
  const [kind] = kinds;
  if (kinds.size === 1) {
    const coordinates = flat.flatMap((g) =>
      g.type.startsWith("Multi")
        ? (g as { coordinates: unknown[] }).coordinates
        : [(g as { coordinates: unknown }).coordinates],
    );
    if (kind === "Point") return { type: "MultiPoint", coordinates } as Geometry;
    if (kind === "LineString") return { type: "MultiLineString", coordinates } as Geometry;
    if (kind === "Polygon") return { type: "MultiPolygon", coordinates } as Geometry;
  }
  return { type: "GeometryCollection", geometries: flat } as Geometry;
}

/**
 * Both ends of a validity a feed writes in one field (`13.04.26 - 30.10.26`),
 * split at a dash between spaces. A dotted date with a two-digit year is of
 * this century. An end that does not parse is null, and so is a value that is
 * no range.
 */
function validityRange(
  value: unknown,
  times: SourceTimes,
): { validFrom: string | null; validTo: string | null } {
  // A dash with whitespace on both sides; one character of lookaround each
  // keeps the split linear on a long run of spaces.
  const ends =
    typeof value === "string" ? value.split(/(?<=\s)[-–](?=\s)/u).map((end) => end.trim()) : [];
  const [from, to] = ends;
  if (ends.length !== 2 || from === undefined || to === undefined) {
    return { validFrom: null, validTo: null };
  }
  const fullYear = (end: string) => end.replace(/^(\d{1,2}\.\d{1,2}\.)(\d{2})$/, "$120$2");
  return {
    validFrom: boundOf(fullYear(from), "start", times),
    validTo: boundOf(fullYear(to), "end", times),
  };
}

function defaultHeadline(type: RoadEventType): string {
  return type === "other"
    ? "Traffic information"
    : type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function parseGeoJson(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const collection = readFeatureCollection(text);
  if (!collection) return [];
  return featuresToRoadEvents(collection.features as Feature[], collection.crs, src, "geojson");
}

/**
 * Map an array of (GeoJSON or pseudo) features to RoadEvents via the feed's
 * GeoJsonMapping. Shared by the GeoJSON reader and the flat-JSON reader (which
 * passes records as `{ geometry: null, properties }` and relies on
 * lonField/latField for geometry). `format` is stamped as the sourceFormat.
 */
export function featuresToRoadEvents(
  features: Feature[],
  collectionCrs: string | undefined,
  src: SourceDescriptor,
  format: "geojson" | "flatjson",
): RoadEvent[] {
  const mapping = src.geojson ?? {};
  const out: RoadEvent[] = [];
  const followUps = new Set<RoadEvent>();
  let skippedNoGeometry = 0;
  let malformed = 0;
  let unknownValues = 0;
  // One instant for the whole payload: duplicates the dedupe folds tie on it.
  const now = new Date().toISOString();

  features.forEach((feature, index) => {
    // A feature, or its properties, that is no object has no fields to map.
    if (
      feature === null ||
      typeof feature !== "object" ||
      (feature.properties != null && typeof feature.properties !== "object")
    ) {
      malformed++;
      return;
    }
    const raw = (feature.properties ?? {}) as Record<string, unknown>;
    const props = withoutPlaceholders(raw, mapping);
    if (!passesFilter(props, mapping)) return;

    // Prefer explicit WGS84 lon/lat property fields when configured (for feeds
    // whose `geometry` is in a national grid we can't reproject in closed form).
    let geometry: Geometry | undefined;
    if (mapping.lonField && mapping.latField) {
      const lon = Number(get(props, mapping.lonField));
      const lat = Number(get(props, mapping.latField));
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        geometry = { type: "Point", coordinates: [lon, lat] };
      }
    }
    if (!geometry) {
      const rawGeometry = feature.geometry;
      // Accept any geometry that carries shape: coordinates, or a
      // GeometryCollection's nested geometries (Berlin VIZ mixes Point+LineString).
      const hasShape =
        rawGeometry &&
        rawGeometry.type &&
        ("coordinates" in rawGeometry ||
          (rawGeometry.type === "GeometryCollection" && "geometries" in rawGeometry));
      if (hasShape) {
        // CRS may be declared on the collection (ArcGIS/WFS) or per-geometry
        // (Brussels OGC API). Reproject to WGS84 when it's a known projected grid.
        geometry = reprojectGeometry(rawGeometry, collectionCrs);
      } else {
        // Last resort before dropping the record: endpoints published as WGS84
        // columns rather than as geometry.
        geometry = synthesizeLine(props, mapping);
        if (!geometry) {
          skippedNoGeometry++;
          return;
        }
      }
    }

    const rawType = str(get(props, mapping.typeField));
    const { type, category, isPlanned, classification, unmapped } = resolveType(rawType, mapping);
    const ownId = mapping.featureId ? str(feature.id) : undefined;
    const localId =
      ownId ??
      (mapping.idFields !== undefined
        ? sha256Hex(jcs(mapping.idFields.map((field) => get(props, field) ?? null))).slice(0, 16)
        : (str(get(props, mapping.idField)) ?? String(index)));
    const sourceHeadline = str(get(props, mapping.headlineField));
    const headline = sourceHeadline ?? defaultHeadline(type);
    const road = str(get(props, mapping.roadField));
    const updated = str(get(props, mapping.updatedField));
    const times = timesOf(src, mapping);
    const recordTime = sourceTimestamp(updated, times);
    const severityToken = str(get(props, mapping.severityField))?.trim();
    const { unmapped: severityUnmapped, ...severity } = resolveSeverity(severityToken, mapping);
    if (unmapped) unknownValues++;
    if (severityUnmapped) unknownValues++;
    const followUp = isFollowUp(props, mapping);

    const event: RoadEvent = {
      id: `${src.id}:${localId}`,
      source: src.id,
      sourceFormat: format,
      domain: "roads",
      kind: "event",
      situation: {
        ...(classification !== undefined ? { classification } : {}),
        ...(recordTime !== undefined ? { sourceUpdatedAt: recordTime } : {}),
        ...(sourceHeadline === undefined ? { headlineFromSource: false as const } : {}),
        ...(severityToken ? { severityRaw: severityToken } : {}),
      },
      type,
      subtype: rawType,
      category,
      isPlanned,
      ...severity,
      status: "active",
      geometry,
      roads: road ? [{ name: road }] : [],
      headline,
      description: str(get(props, mapping.descriptionField)),
      // Only projected when the mapping declares the fields, so feeds without
      // dates keep emitting no validity at all rather than an explicit null.
      ...(mapping.validityRangeField
        ? validityRange(get(props, mapping.validityRangeField), times)
        : {}),
      ...(mapping.validFromField
        ? { validFrom: boundOf(get(props, mapping.validFromField), "start", times) }
        : {}),
      ...(mapping.validToField
        ? { validTo: boundOf(get(props, mapping.validToField), "end", times) }
        : {}),
      sourceRaw: raw,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: updated ?? now,
      fetchedAt: now,
      isStale: false,
    };
    out.push(event);
    if (followUp) followUps.add(event);
  });

  if (skippedNoGeometry > 0) {
    console.debug(
      `[geojson] ${src.id}: skipped ${skippedNoGeometry} feature(s) with no usable geometry`,
    );
    recordSkipped(src.id, "no_geometry", skippedNoGeometry);
  }
  recordSkipped(src.id, "malformed", malformed);
  recordSkipped(src.id, "unknown_value", unknownValues);

  return dedupeRoadEvents(mergeParts(dropSupersededRoadEvents(out, (e) => followUps.has(e))));
}
