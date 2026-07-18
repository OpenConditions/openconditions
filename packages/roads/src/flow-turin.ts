import type { Point } from "geojson";
import type { RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";
import { getXmlChild, getXmlChildren, isXmlObject, parseXmlDocument, xmlText } from "./xml.js";

const ABSURD_SPEED_KPH = 250;

function num(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the Turin 5T real-time traffic-flow feed (`opendata.5t.torino.it/get_fdt`)
 * into RoadFlow point measurements. Each `<FDT_data>` is a detector carrying
 * inline WGS84 `lat`/`lng`, an `accuracy` confidence, and a child
 * `<speedflow speed=.. flow=..>` (speed in km/h). Detectors with no confidence
 * (`accuracy=0`, published with a placeholder `speed=0`) or no coordinate are
 * skipped. los is left "unknown" for baseline enrichment.
 */
export function parseTurinFlow(input: string | Buffer, src: SourceDescriptor): FlowParseResult {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) => n === "FDT_data",
    });
  } catch {
    return { flows: [], events: [], failed: true };
  }
  const root = isXmlObject(doc) ? (getXmlChild(doc, "traffic_data") ?? doc) : null;
  if (!root) return { flows: [], events: [], failed: true };

  const detectors = getXmlChildren(root, "FDT_data");
  const genTime = xmlText(root["@_generation_time"]);
  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];

  for (const fdt of detectors) {
    try {
      const id = xmlText(fdt["@_lcd1"]);
      if (!id) continue;
      const accuracy = num(xmlText(fdt["@_accuracy"]));
      if (accuracy == null || accuracy <= 0) continue; // no confident measurement this cycle
      const lon = num(xmlText(fdt["@_lng"]));
      const lat = num(xmlText(fdt["@_lat"]));
      if (lon == null || lat == null) continue;

      const sf = getXmlChild(fdt, "speedflow");
      const speedKph = num(xmlText(sf?.["@_speed"]));
      if (speedKph == null || speedKph < 0 || speedKph >= ABSURD_SPEED_KPH) continue;

      const geometry: Point = { type: "Point", coordinates: [lon, lat] };
      const direction = xmlText(fdt["@_direction"]);
      flows.push({
        id: `${src.id}:${id}`,
        source: src.id,
        sourceFormat: "fdt",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        value: speedKph,
        unit: "km/h",
        level: "unknown",
        aggregation: "live",
        status: "active",
        geometry,
        los: "unknown",
        speedKph,
        ...(direction ? { direction } : {}),
        origin,
        dataUpdatedAt: genTime ?? now,
        fetchedAt: now,
        isStale: false,
      });
    } catch (err) {
      console.warn("[turin-flow] skipped malformed FDT_data:", err);
    }
  }

  return { flows, events: [] };
}
