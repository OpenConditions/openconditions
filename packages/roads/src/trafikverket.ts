import type { Geometry } from "geojson";
import { dedupeRoadEvents } from "./dedupe.js";
import type { RoadEvent, RoadEventType } from "./model.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Parser for Sweden's Trafikverket "Situation" API (POST JSON query). The
 * response is `{ RESPONSE: { RESULT: [ { Situation: [ { Deviation: [ … ] } ] } ] } }`;
 * each Deviation is one event with WKT geometry in `Geometry.Point.WGS84` /
 * `Geometry.Line.WGS84` (lon-lat order). MessageType (Swedish) maps to the
 * canonical taxonomy. The feed is keyed (key embedded in the POST body), so this
 * is built from the documented schema — verify field shapes against a live
 * keyed response.
 */

interface Deviation {
  Id?: string;
  Message?: string;
  MessageType?: string;
  SeverityText?: string;
  SeverityCode?: number;
  RoadName?: string;
  StartTime?: string;
  EndTime?: string;
  Geometry?: { Point?: { WGS84?: string }; Line?: { WGS84?: string } };
}

const TYPE_MAP: Record<string, RoadEventType> = {
  olycka: "accident",
  vägarbete: "roadworks",
  hinder: "obstruction",
  avstängning: "road_closure",
  "avstängd väg": "road_closure",
  vägförhållande: "road_condition",
  restriktion: "speed_restriction",
};

const PLANNED = new Set<RoadEventType>(["roadworks"]);
const INCIDENT = new Set<RoadEventType>(["accident", "road_closure", "obstruction"]);

function categoryOf(type: RoadEventType): RoadEvent["category"] {
  if (PLANNED.has(type)) return "planned";
  if (INCIDENT.has(type)) return "incident";
  return "conditions";
}

/** Parse a WKT "POINT (lon lat)" / "LINESTRING (lon lat, …)" to a geometry. */
function wktToGeometry(wkt: string | undefined): Geometry | null {
  if (typeof wkt !== "string") return null;
  const pt = wkt.match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i);
  if (pt) {
    const c: [number, number] = [Number(pt[1]), Number(pt[2])];
    return Number.isFinite(c[0]) && Number.isFinite(c[1])
      ? { type: "Point", coordinates: c }
      : null;
  }
  const line = wkt.match(/LINESTRING\s*\(([^)]+)\)/i);
  if (line) {
    const coords = line[1]!
      .split(",")
      .map((p) => p.trim().split(/\s+/).map(Number))
      .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c) => [c[0]!, c[1]!] as [number, number]);
    if (coords.length >= 2) return { type: "LineString", coordinates: coords };
  }
  return null;
}

function severityOf(code: number | undefined): RoadEvent["severity"] {
  switch (code) {
    case 5:
      return "critical";
    case 4:
      return "high";
    case 3:
      return "medium";
    case 1:
    case 2:
      return "low";
    default:
      return "unknown";
  }
}

export function parseTrafikverket(
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
  const results = (data as { RESPONSE?: { RESULT?: unknown[] } })?.RESPONSE?.RESULT;
  if (!Array.isArray(results)) return [];

  const out: RoadEvent[] = [];
  for (const result of results) {
    const situations = (result as { Situation?: unknown[] })?.Situation;
    if (!Array.isArray(situations)) continue;
    for (const sit of situations) {
      const deviations = (sit as { Deviation?: Deviation[] })?.Deviation;
      if (!Array.isArray(deviations)) continue;
      for (const dev of deviations) {
        const geometry =
          wktToGeometry(dev.Geometry?.Point?.WGS84) ?? wktToGeometry(dev.Geometry?.Line?.WGS84);
        if (!geometry) continue;
        const rawType = (dev.MessageType ?? "").trim();
        const type = TYPE_MAP[rawType.toLowerCase()] ?? "other";
        const road = typeof dev.RoadName === "string" && dev.RoadName ? dev.RoadName : undefined;
        const severity = severityOf(dev.SeverityCode);

        out.push({
          id: `${src.id}:${dev.Id ?? out.length}`,
          source: src.id,
          sourceFormat: "trafikverket-json",
          domain: "roads",
          kind: "event",
          type,
          subtype: rawType || undefined,
          category: categoryOf(type),
          isPlanned: PLANNED.has(type),
          severity,
          severitySource: severity === "unknown" ? "derived" : "declared",
          status: "active",
          geometry,
          roads: road ? [{ name: road }] : [],
          headline: typeof dev.Message === "string" && dev.Message ? dev.Message : rawType || type,
          description: typeof dev.Message === "string" ? dev.Message : undefined,
          validFrom: dev.StartTime ?? null,
          validTo: dev.EndTime ?? null,
          sourceRaw: dev as Record<string, unknown>,
          origin: {
            kind: "feed",
            attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
          },
          dataUpdatedAt: dev.StartTime ?? new Date().toISOString(),
          fetchedAt: new Date().toISOString(),
          isStale: false,
        });
      }
    }
  }

  return dedupeRoadEvents(out);
}
