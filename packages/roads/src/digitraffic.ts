import { deriveSeverity } from "@openconditions/core";
import type { GeoJsonGeometry, Severity } from "@openconditions/core";
import type { Restriction, RoadEvent, RoadRef } from "./model.js";
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

interface DigitrafficPrimaryPoint {
  roadName?: unknown;
  roadAddress?: { road?: unknown };
}

interface DtWorkType {
  type?: unknown;
}

interface DtRestriction {
  type?: unknown;
}

interface DtRoadWorkPhase {
  severity?: unknown;
  workTypes?: DtWorkType[];
  restrictions?: DtRestriction[];
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
      if (typeof r?.type === "string") out.push({ type: r.type });
    }
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
  const details = ann?.["locationDetails"] as
    | { roadAddressLocation?: { primaryPoint?: DigitrafficPrimaryPoint } }
    | undefined;
  const primary = details?.roadAddressLocation?.primaryPoint;
  if (!primary) return [];
  const name = coerceString(primary.roadName);
  const road = primary.roadAddress?.road;
  const ref = typeof road === "number" ? String(road) : coerceString(road);
  if (!name && !ref) return [];
  return [{ name: name ?? ref!, ...(ref ? { ref } : {}) }];
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
        subtype: subtypeFromAnnouncement(ann) ?? (codeForMapping || undefined),
        category,
        isPlanned,
        severity,
        severitySource: phaseSeverity ? "declared" : "derived",
        status: "active",
        geometry: geometry as GeoJsonGeometry,
        direction: directionFromAnnouncement(ann),
        roads: roadsFromAnnouncement(ann),
        restrictions: restrictionsFromPhases(ann),
        headline,
        description: coerceString(ann?.["comment"]) ?? undefined,
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
