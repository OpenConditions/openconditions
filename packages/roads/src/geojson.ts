import { toIsoTimestamp, type Severity, type SourceFormat } from "@openconditions/core";
import type { Geometry } from "geojson";
import { dedupeRoadEvents } from "./dedupe.js";
import type { GeoJsonMapping, RoadEvent, RoadEventType } from "./model.js";
import { reprojectorFor } from "./reproject.js";
import { recordSkippedNoGeometry } from "./skip-metrics.js";
import { mapSourceType, type TypeMapping } from "./taxonomy.js";
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
  geometry?: Geometry | null;
  properties?: Record<string, unknown> | null;
}

/** Plain-incident type → (category, isPlanned) when a feed gives an explicit defaultType. */
const PLANNED_TYPES = new Set<RoadEventType>(["roadworks", "public_event"]);
const INCIDENT_TYPES = new Set<RoadEventType>([
  "accident",
  "road_closure",
  "lane_closure",
  "contraflow",
  "broken_down_vehicle",
  "obstruction",
  "authority",
  "security",
  "transit_disruption",
]);

function mappingForType(type: RoadEventType): TypeMapping {
  if (PLANNED_TYPES.has(type)) return { type, category: "planned", isPlanned: true };
  if (INCIDENT_TYPES.has(type)) return { type, category: "incident", isPlanned: false };
  return { type, category: "conditions", isPlanned: false };
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
  mapping: GeoJsonMapping
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

function resolveType(rawType: string | undefined, mapping: GeoJsonMapping): TypeMapping {
  if (rawType) {
    // Source-specific overrides win over the shared crosswalk.
    const override = mapping.typeMap?.[rawType] ?? mapping.typeMap?.[rawType.toLowerCase()];
    if (override) return mappingForType(override);
    const tm = mapSourceType("geojson", rawType);
    if (tm.type !== "other") return tm;
  }
  if (mapping.defaultType) return mappingForType(mapping.defaultType);
  return rawType
    ? mapSourceType("geojson", rawType)
    : { type: "other", category: "conditions", isPlanned: false };
}

function resolveSeverity(
  raw: string | undefined,
  mapping: GeoJsonMapping
): { severity: Severity; severitySource: "declared" | "derived" } {
  if (raw && mapping.severityMap) {
    const mapped = mapping.severityMap[raw] ?? mapping.severityMap[raw.toLowerCase()];
    if (mapped) return { severity: mapped, severitySource: "declared" };
  }
  return { severity: "unknown", severitySource: "derived" };
}

function defaultHeadline(type: RoadEventType): string {
  return type === "other"
    ? "Traffic information"
    : type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The CRS name on a geometry or FeatureCollection `crs` member, if any. */
function crsName(crs: unknown): string | undefined {
  const name = (crs as { properties?: { name?: unknown } })?.properties?.name;
  return typeof name === "string" ? name : undefined;
}

/** Recursively remap every coordinate pair of a geometry through `fn`, dropping
 * any now-stale `crs` member (coords become WGS84). */
function remapCoords(geometry: Geometry, fn: (p: [number, number]) => [number, number]): Geometry {
  const { crs: _crs, ...geom } = geometry as Geometry & { crs?: unknown };
  if (geom.type === "GeometryCollection") {
    return { ...geom, geometries: geom.geometries.map((g) => remapCoords(g, fn)) };
  }
  const walk = (c: unknown): unknown =>
    Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
      ? fn([c[0], c[1]])
      : Array.isArray(c)
        ? c.map(walk)
        : c;
  return {
    ...geom,
    coordinates: walk((geom as { coordinates: unknown }).coordinates),
  } as Geometry;
}

export function parseGeoJson(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  const text = typeof input === "string" ? input : input.toString("utf8");
  let fc: { features?: unknown; crs?: unknown };
  try {
    fc = JSON.parse(text) as { features?: unknown; crs?: unknown };
  } catch {
    return [];
  }
  const features = Array.isArray(fc.features) ? (fc.features as Feature[]) : [];
  return featuresToRoadEvents(features, crsName(fc.crs), src, "geojson");
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
  format: SourceFormat
): RoadEvent[] {
  const mapping = src.geojson ?? {};
  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;

  features.forEach((feature, index) => {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
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
        const reproject = reprojectorFor(
          crsName((rawGeometry as { crs?: unknown }).crs) ?? collectionCrs
        );
        geometry = reproject ? remapCoords(rawGeometry, reproject) : rawGeometry;
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
    const { type, category, isPlanned } = resolveType(rawType, mapping);
    const localId = str(get(props, mapping.idField)) ?? String(index);
    const headline = str(get(props, mapping.headlineField)) ?? defaultHeadline(type);
    const road = str(get(props, mapping.roadField));
    const updated = str(get(props, mapping.updatedField));

    out.push({
      id: `${src.id}:${localId}`,
      source: src.id,
      sourceFormat: format,
      domain: "roads",
      kind: "event",
      type,
      subtype: rawType,
      category,
      isPlanned,
      ...resolveSeverity(str(get(props, mapping.severityField)), mapping),
      status: "active",
      geometry,
      roads: road ? [{ name: road }] : [],
      headline,
      description: str(get(props, mapping.descriptionField)),
      // Only projected when the mapping declares the fields, so feeds without
      // dates keep emitting no validity at all rather than an explicit null.
      ...(mapping.validFromField
        ? { validFrom: toIsoTimestamp(get(props, mapping.validFromField)) ?? null }
        : {}),
      ...(mapping.validToField
        ? { validTo: toIsoTimestamp(get(props, mapping.validToField)) ?? null }
        : {}),
      sourceRaw: props,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: updated ?? new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      isStale: false,
    });
  });

  if (skippedNoGeometry > 0) {
    console.debug(
      `[geojson] ${src.id}: skipped ${skippedNoGeometry} feature(s) with no usable geometry`
    );
    recordSkippedNoGeometry(src.id, skippedNoGeometry);
  }

  return dedupeRoadEvents(out);
}
