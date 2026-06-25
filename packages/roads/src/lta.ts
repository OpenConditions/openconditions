import { dedupeRoadEvents } from "./dedupe.js";
import type { RoadEvent, RoadEventType } from "./model.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Parser for Singapore LTA DataMall's `TrafficIncidents` endpoint (header-key
 * auth). The response is `{ value: [{ Type, Latitude, Longitude, Message }] }`.
 * Each record is a point incident; the LTA `Type` maps to the canonical
 * taxonomy. Records carry no id, so a stable one is derived from the content.
 */

interface LtaIncident {
  Type?: string;
  Latitude?: number;
  Longitude?: number;
  Message?: string;
}

const TYPE_MAP: Record<string, RoadEventType> = {
  accident: "accident",
  roadwork: "roadworks",
  "vehicle breakdown": "broken_down_vehicle",
  "unattended vehicle": "broken_down_vehicle",
  "heavy traffic": "congestion",
  obstacle: "obstruction",
  "road block": "road_closure",
  diversion: "detour",
  flooding: "weather",
  weather: "weather",
  "plant/animal hazards": "hazard",
  "misc.": "other",
  miscellaneous: "other",
};

const PLANNED = new Set<RoadEventType>(["roadworks"]);
const INCIDENT = new Set<RoadEventType>([
  "accident",
  "road_closure",
  "broken_down_vehicle",
  "obstruction",
]);

function categoryOf(type: RoadEventType): RoadEvent["category"] {
  if (PLANNED.has(type)) return "planned";
  if (INCIDENT.has(type)) return "incident";
  return "conditions";
}

/** Deterministic short id from the incident content (LTA gives no id). */
function deriveId(ev: LtaIncident): string {
  const basis = `${ev.Type ?? ""}|${ev.Latitude ?? ""}|${ev.Longitude ?? ""}|${ev.Message ?? ""}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function parseLtaIncidents(
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
  const value = (data as { value?: unknown })?.value;
  const incidents = Array.isArray(value) ? (value as LtaIncident[]) : [];
  const out: RoadEvent[] = [];

  for (const ev of incidents) {
    const lat = ev.Latitude;
    const lng = ev.Longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const rawType = (ev.Type ?? "").trim();
    const type = TYPE_MAP[rawType.toLowerCase()] ?? "other";

    out.push({
      id: `${src.id}:${deriveId(ev)}`,
      source: src.id,
      sourceFormat: "lta-json",
      domain: "roads",
      kind: "event",
      type,
      subtype: rawType || undefined,
      category: categoryOf(type),
      isPlanned: PLANNED.has(type),
      severity: "unknown",
      severitySource: "derived",
      status: "active",
      geometry: { type: "Point", coordinates: [lng as number, lat as number] },
      roads: [],
      headline:
        typeof ev.Message === "string" && ev.Message ? ev.Message : rawType || "Traffic incident",
      description: typeof ev.Message === "string" ? ev.Message : undefined,
      sourceRaw: ev as Record<string, unknown>,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      isStale: false,
    });
  }

  return dedupeRoadEvents(out);
}
