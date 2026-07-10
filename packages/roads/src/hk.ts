import type { Point } from "geojson";
import type { RoadFlow } from "./model.js";
import type { SiteGeometry } from "./siteTable.js";
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
 * Build a `detector_id → Point` map from the HK TD detector-locations CSV
 * (`traffic_speed_volume_occ_info.csv`). The id column is `AID_ID_Number` and
 * geometry is the WGS84 `Latitude`/`Longitude` columns. The file carries a UTF-8
 * BOM and unquoted road-name fields; coordinates are validated to Hong Kong's
 * bounds so a stray comma that shifts columns drops the row rather than placing
 * it wrongly.
 */
export function parseHkDetectors(input: string | Buffer): Map<string, SiteGeometry> {
  const map = new Map<string, SiteGeometry>();
  const text = (Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return map;

  const header = lines[0]!.split(",").map((h) => h.trim());
  const iId = header.indexOf("AID_ID_Number");
  const iLat = header.indexOf("Latitude");
  const iLon = header.indexOf("Longitude");
  if (iId < 0 || iLat < 0 || iLon < 0) return map;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "") continue;
    const cells = lines[i]!.split(",");
    const id = cells[iId]?.trim();
    if (!id) continue;
    const lat = num(cells[iLat]);
    const lon = num(cells[iLon]);
    // Hong Kong bounds — guards against a comma-shifted row.
    if (lat == null || lon == null || lat < 22 || lat > 23 || lon < 113 || lon > 115) continue;
    map.set(id, { type: "Point", coordinates: [lon, lat] });
  }
  return map;
}

/**
 * Parse the HK TD raw traffic speed/volume feed (`rawSpeedVol-all.xml`) into
 * RoadFlow point measurements, one per detector. The document holds successive
 * 30-second `<period>`s; the most recent is used. A detector's representative
 * speed is the volume-weighted mean of its valid lanes (`valid=Y`), falling back
 * to an unweighted mean when no lane reports volume. Geometry comes from the
 * detector `siteMap`, joined on `detector_id`. Detectors with no geometry or no
 * valid lane are skipped; los is left "unknown" for baseline enrichment.
 */
export function parseHkRawFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, SiteGeometry>
): FlowParseResult {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: true,
      isArray: (n) => n === "period" || n === "detector" || n === "lane",
    });
  } catch {
    return { flows: [], events: [], failed: true };
  }
  const root = isXmlObject(doc) ? (getXmlChild(doc, "raw_speed_volume_list") ?? doc) : null;
  if (!root) return { flows: [], events: [], failed: true };

  const periods = getXmlChildren(getXmlChild(root, "periods") ?? root, "period");
  const period = periods[periods.length - 1];
  if (!period) return { flows: [], events: [] };
  const measuredAt = xmlText(period["period_to"]) ?? new Date().toISOString();

  const detectors = getXmlChildren(getXmlChild(period, "detectors") ?? period, "detector");
  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];

  for (const det of detectors) {
    try {
      const id = xmlText(det["detector_id"]);
      if (!id) continue;
      const geom = siteMap?.get(id) as Point | undefined;
      if (!geom) continue;

      let sumSV = 0; // Σ speed·volume
      let sumV = 0; // Σ volume
      let sumS = 0; // Σ speed (unweighted fallback)
      let nLanes = 0;
      for (const lane of getXmlChildren(getXmlChild(det, "lanes") ?? det, "lane")) {
        if (xmlText(lane["valid"]) !== "Y") continue;
        const s = num(xmlText(lane["speed"]));
        if (s == null || s < 0 || s >= ABSURD_SPEED_KPH) continue;
        const v = num(xmlText(lane["volume"])) ?? 0;
        sumS += s;
        nLanes += 1;
        if (v > 0) {
          sumSV += s * v;
          sumV += v;
        }
      }
      if (nLanes === 0) continue;
      const speedKph = sumV > 0 ? sumSV / sumV : sumS / nLanes;

      flows.push({
        id: `${src.id}:${id}`,
        source: src.id,
        sourceFormat: "hk-raw-xml",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        value: speedKph,
        unit: "km/h",
        level: "unknown",
        aggregation: "live",
        status: "active",
        geometry: geom,
        los: "unknown",
        speedKph,
        origin,
        dataUpdatedAt: measuredAt,
        fetchedAt: now,
        isStale: false,
      });
    } catch (err) {
      console.warn("[hk-flow] skipped malformed detector:", err);
    }
  }

  return { flows, events: [] };
}
