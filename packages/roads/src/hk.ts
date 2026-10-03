import { localTimestamp } from "./flow.js";
import type { FlowContext, FlowSite, FlowSites } from "./flow-output.js";
import {
  type ChannelReading,
  type ChannelSpec,
  type FlowParse,
  type FlowReading,
  mean,
  OCCUPANCY,
  plausibleSpeed,
  SPEED,
  VOLUME,
} from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";
import { getXmlChild, getXmlChildren, isXmlObject, parseXmlDocument, xmlText } from "./xml.js";

function num(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the detector sites (point and road name) from the HK TD detector-locations CSV
 * (`traffic_speed_volume_occ_info.csv`). The id column is `AID_ID_Number` and
 * geometry is the WGS84 `Latitude`/`Longitude` columns. The file carries a UTF-8
 * BOM and unquoted road-name fields; coordinates are validated to Hong Kong's
 * bounds so a stray comma that shifts columns drops the row rather than placing
 * it wrongly.
 */
export function parseHkDetectors(input: string | Buffer): FlowSites {
  const map = new Map<string, FlowSite>();
  const text = (Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return map;

  const header = lines[0]!.split(",").map((h) => h.trim());
  const iId = header.indexOf("AID_ID_Number");
  const iLat = header.indexOf("Latitude");
  const iLon = header.indexOf("Longitude");
  const iRoad = header.indexOf("Road_EN");
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
    const road = iRoad >= 0 ? cells[iRoad]?.trim() : undefined;
    map.set(id, {
      geometry: { type: "Point", coordinates: [lon, lat] },
      ...(road ? { name: road, nameLang: "en" } : {}),
    });
  }
  return map;
}

/** A lane's channel key stem: its label, lower-case, words joined by underscores. */
const laneKey = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");

/**
 * Parse the HK TD raw traffic speed/volume/occupancy feed
 * (`rawSpeedVol-all.xml`), one reading per detector. The document holds
 * successive 30-second `<period>`s; the most recent is used. Each lane is
 * kept as channels (speed, volume, occupancy) under its label; the
 * detector's speed is the volume-weighted mean of its valid lanes (`valid=Y`),
 * falling back to an unweighted mean when no lane counts vehicles, its volume
 * the sum of the lanes' counts as an hourly rate, its occupancy their mean.
 * Geometry comes from the detector registry, joined on `detector_id`.
 * Detectors with no geometry or no valid lane are skipped; the level of
 * service is left to the baseline enrichment.
 */
export function parseHkRawFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: true,
      isArray: (n) => n === "period" || n === "detector" || n === "lane",
    });
  } catch {
    return { readings: [], failed: true };
  }
  const root = isXmlObject(doc) ? (getXmlChild(doc, "raw_speed_volume_list") ?? doc) : null;
  if (!root) return { readings: [], failed: true };

  const periods = getXmlChildren(getXmlChild(root, "periods") ?? root, "period");
  const period = periods[periods.length - 1];
  if (!period) return { readings: [] };
  // The document carries the day once (`<date>`); each period only a Hong Kong time of day.
  const date = xmlText(root["date"]);
  const local = (time: string | undefined) =>
    date && time ? localTimestamp(`${date}T${time}`, "Asia/Hong_Kong") : undefined;
  const from = local(xmlText(period["period_from"]));
  const to = local(xmlText(period["period_to"]));
  const periodSec =
    from !== undefined && to !== undefined && Date.parse(to) > Date.parse(from)
      ? (Date.parse(to) - Date.parse(from)) / 1000
      : undefined;
  const perHour = periodSec !== undefined ? 3600 / periodSec : undefined;

  const readings: FlowReading[] = [];
  for (const det of getXmlChildren(getXmlChild(period, "detectors") ?? period, "detector")) {
    try {
      const id = xmlText(det["detector_id"]);
      if (!id) continue;
      const site = sites?.get(id);
      if (!site) continue;

      let sumSV = 0; // Σ speed·volume
      let sumV = 0; // Σ volume
      const speeds: number[] = [];
      const occupancies: number[] = [];
      let volume = 0;
      const declaredChannels: ChannelSpec[] = [];
      const channels: ChannelReading[] = [];
      for (const lane of getXmlChildren(getXmlChild(det, "lanes") ?? det, "lane")) {
        const label = xmlText(lane["lane_id"]);
        const stem = label ? laneKey(label) : undefined;
        if (stem) {
          for (const [property, short] of [
            [SPEED, "speed"],
            [VOLUME, "volume"],
            [OCCUPANCY, "occupancy"],
          ] as const) {
            declaredChannels.push({ key: `${stem}:${short}`, property });
          }
        }
        if (xmlText(lane["valid"]) !== "Y") continue;
        const s = num(xmlText(lane["speed"]));
        if (!plausibleSpeed(s)) continue;
        const v = num(xmlText(lane["volume"])) ?? 0;
        const occ = num(xmlText(lane["occupancy"]));
        speeds.push(s);
        if (v > 0) {
          sumSV += s * v;
          sumV += v;
        }
        volume += v;
        if (occ !== undefined && occ >= 0 && occ <= 100) occupancies.push(occ);
        if (stem) {
          channels.push({ key: `${stem}:speed`, property: SPEED, value: s });
          if (perHour !== undefined) {
            channels.push({ key: `${stem}:volume`, property: VOLUME, value: v * perHour });
          }
          if (occ !== undefined && occ >= 0 && occ <= 100) {
            channels.push({ key: `${stem}:occupancy`, property: OCCUPANCY, value: occ });
          }
        }
      }
      if (speeds.length === 0) continue;
      const speedKph = sumV > 0 ? sumSV / sumV : mean(speeds)!;
      const occupancy = mean(occupancies);

      readings.push({
        site: id,
        geometry: site.geometry,
        ...(to !== undefined ? { at: to } : {}),
        ...(periodSec !== undefined ? { periodSec } : {}),
        los: "unknown",
        speedKph,
        ...(perHour !== undefined ? { volume: volume * perHour } : {}),
        ...(occupancy !== undefined ? { occupancy } : {}),
        channels,
        declaredChannels,
        ...(site.name !== undefined ? { name: site.name } : {}),
        ...(site.nameLang !== undefined ? { nameLang: site.nameLang } : {}),
      });
    } catch (err) {
      console.warn("[hk-flow] skipped malformed detector:", err);
    }
  }

  return { readings };
}
