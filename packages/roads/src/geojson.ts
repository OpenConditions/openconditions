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

export function parseGeoJson(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  const text = typeof input === "string" ? input : input.toString("utf8");
  let fc: { features?: unknown };
  try {
    fc = JSON.parse(text) as { features?: unknown };
  } catch {
    return [];
  }
  const features = Array.isArray(fc.features) ? (fc.features as Feature[]) : [];
  const mapping = src.geojson ?? {};
  const out: RoadEvent[] = [];

  features.forEach((feature, index) => {
    const geometry = feature.geometry;
    if (!geometry || !geometry.type || !("coordinates" in geometry)) return;
    const props = (feature.properties ?? {}) as Record<string, unknown>;

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
