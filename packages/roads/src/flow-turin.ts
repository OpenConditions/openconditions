import {
  getXmlChild,
  getXmlChildren,
  isXmlObject,
  parseXmlDocument,
  xmlText,
} from "@openconditions/datex2";
import type { Point } from "geojson";
import type { FlowContext, FlowSites } from "./flow-output.js";
import { type FlowParse, type FlowReading, plausibleSpeed } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

function num(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the Turin 5T real-time traffic-flow feed (`opendata.5t.torino.it/get_fdt`).
 * Each `<FDT_data>` is a detector carrying inline WGS84 `lat`/`lng`, an
 * `accuracy` confidence in percent, its averaging `period` in minutes, and a
 * child `<speedflow speed=.. flow=..>` (km/h, vehicles per hour). The period
 * is taken to end at the document's generation time. Detectors with no
 * confidence (`accuracy=0`, published with a placeholder `speed=0`) or no
 * coordinate are skipped. The level of service is left to the baseline
 * enrichment.
 */
export function parseTurinFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) => n === "FDT_data",
    });
  } catch {
    return { readings: [], failed: true };
  }
  const root = isXmlObject(doc) ? (getXmlChild(doc, "traffic_data") ?? doc) : null;
  if (!root) return { readings: [], failed: true };

  const genTime = xmlText(root["@_generation_time"]);
  const readings: FlowReading[] = [];
  for (const fdt of getXmlChildren(root, "FDT_data")) {
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
      if (!plausibleSpeed(speedKph)) continue;
      const flow = num(xmlText(sf?.["@_flow"]));
      const periodMin = num(xmlText(fdt["@_period"]));

      const geometry: Point = { type: "Point", coordinates: [lon, lat] };
      const direction = xmlText(fdt["@_direction"]);
      const name = xmlText(fdt["@_Road_name"]);
      readings.push({
        site: id,
        geometry,
        ...(genTime !== undefined ? { at: genTime } : {}),
        ...(periodMin !== undefined && periodMin > 0 ? { periodSec: periodMin * 60 } : {}),
        los: "unknown",
        speedKph,
        confidence: Math.min(accuracy, 100) / 100,
        ...(flow !== undefined && flow >= 0 ? { volume: flow } : {}),
        ...(direction ? { direction } : {}),
        ...(name ? { name, nameLang: "it" } : {}),
      });
    } catch (err) {
      console.warn("[turin-flow] skipped malformed FDT_data:", err);
    }
  }

  return { readings };
}
