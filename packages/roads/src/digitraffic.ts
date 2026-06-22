import { deriveSeverity } from "@openconditions/core";
import type { GeoJsonGeometry } from "@openconditions/core";
import type { RoadEvent } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
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

      const severity = deriveSeverity({});

      const dataUpdatedAt =
        coerceString(props.dataUpdatedTime) ??
        coerceString(props.releaseTime) ??
        new Date().toISOString();

      out.push({
        id: `${src.id}:${situationId}`,
        source: src.id,
        sourceFormat: "digitraffic-json",
        domain: "roads",
        kind: "event",
        type,
        subtype: codeForMapping || undefined,
        category,
        isPlanned,
        severity,
        severitySource: "derived",
        status: "active",
        geometry: geometry as GeoJsonGeometry,
        roads: [],
        headline,
        validFrom,
        validTo,
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
