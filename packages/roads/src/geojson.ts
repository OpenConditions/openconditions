import type { Severity } from "@openconditions/core";
import type { Geometry } from "geojson";
import { dedupeRoadEvents } from "./dedupe.js";
import type { GeoJsonMapping, RoadEvent, RoadEventType } from "./model.js";
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

const WEB_MERCATOR_R = 6_378_137;

/** Web Mercator (EPSG:3857) [x,y] metres → WGS84 [lon,lat] (closed form, no deps). */
function mercToWgs84([x, y]: [number, number]): [number, number] {
  const lon = (x / WEB_MERCATOR_R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / WEB_MERCATOR_R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/** True when a GeoJSON `crs` member declares Web Mercator (some WFS/ArcGIS exports). */
function isWebMercator(crs: unknown): boolean {
  const name = (crs as { properties?: { name?: unknown } })?.properties?.name;
  return typeof name === "string" && /(?:^|[:/])(3857|900913|102100)\b/.test(name);
}

/** Recursively remap every coordinate pair of a geometry through `fn`. */
function remapCoords(geometry: Geometry, fn: (p: [number, number]) => [number, number]): Geometry {
  if (geometry.type === "GeometryCollection") {
    return { ...geometry, geometries: geometry.geometries.map((g) => remapCoords(g, fn)) };
  }
  const walk = (c: unknown): unknown =>
    Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
      ? fn([c[0], c[1]])
      : Array.isArray(c)
        ? c.map(walk)
        : c;
  return {
    ...geometry,
    coordinates: walk((geometry as { coordinates: unknown }).coordinates),
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
  const mapping = src.geojson ?? {};
  const mercator = isWebMercator(fc.crs);
  const out: RoadEvent[] = [];

  features.forEach((feature, index) => {
    const props = (feature.properties ?? {}) as Record<string, unknown>;

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
      if (!hasShape) return;
      geometry = mercator ? remapCoords(rawGeometry, mercToWgs84) : rawGeometry;
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
      sourceFormat: "geojson",
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

  return dedupeRoadEvents(out);
}
