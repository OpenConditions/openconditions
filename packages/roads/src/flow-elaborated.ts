/**
 * Buffered parser for a DATEX II ElaboratedDataPublication as published by the
 * Autobahn GmbH BAB detector feeds: per-minute speed (v), volume (q) and
 * traffic status, one `elaboratedData` item per basicData type, vehicle class
 * and (for the fahrstreifenfein variant) lane, joined to geometry from a
 * companion PredefinedLocations table or an inline location. Items are
 * grouped by their `predefinedLocationReference` id into one site reading;
 * a value stated for one vehicle class is also kept as a channel of the site.
 */
import type { Point } from "geojson";
import type { FlowContext, FlowSites } from "./flow-output.js";
import {
  type ChannelReading,
  type ChannelSpec,
  datexVehicleClass,
  type FlowParse,
  type FlowReading,
  laneIndex,
  measuredReading,
  plausibleSpeed,
  SPEED,
  siteSpeed,
  siteVolume,
  VOLUME,
} from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";
import type { XmlObject } from "./xml.js";
import {
  getXmlChild,
  getXmlChildText,
  isXmlObject,
  parseXmlDocument,
  stripXmlNamespace,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

/** Per-site accumulator across the elaboratedData items that share a location. */
interface SiteAcc {
  siteId: string;
  speeds: { speed: number; count?: number; vehicleClass?: string }[];
  flows: { rate: number; vehicleClass?: string }[];
  /** The class streams the document carries, whether or not their value counts this interval. */
  streams: Map<string, { property: string; vehicleClass: string }>;
  trafficStatus?: string;
  inlineGeom?: Point;
  measuredAt?: string;
}

/** The xsi:type / type attribute of a basicData node, namespace-stripped. */
function basicDataType(basic: XmlObject): string | undefined {
  const raw =
    (basic["@_xsi:type"] as string | undefined) ??
    (basic["@_type"] as string | undefined) ??
    (basic["@_targetClass"] as string | undefined);
  return raw != null ? stripXmlNamespace(raw) : undefined;
}

/** Descend arbitrary envelopes to the node holding `elaboratedData`. */
function findElaboratedPublication(root: unknown): XmlObject | null {
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findElaboratedPublication(item);
      if (found) return found;
    }
    return null;
  }
  if (!isXmlObject(root)) return null;
  if ("elaboratedData" in root) return root;
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith("@_")) continue;
    const found = findElaboratedPublication(value);
    if (found) return found;
  }
  return null;
}

/** The `predefinedLocationReference id` a basicData/elaboratedData item points at. */
function locationRefId(node: XmlObject): string | undefined {
  const found = (n: unknown): string | undefined => {
    if (Array.isArray(n)) {
      for (const it of n) {
        const r = found(it);
        if (r) return r;
      }
      return undefined;
    }
    if (!isXmlObject(n)) return undefined;
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_")) continue;
      if (stripXmlNamespace(key) === "predefinedLocationReference") {
        const ref = xmlNodeToArray(value)[0];
        const id = isXmlObject(ref) ? (ref["@_id"] as string | undefined) : undefined;
        if (id) return id;
      }
      const nested = found(value);
      if (nested) return nested;
    }
    return undefined;
  };
  return found(node);
}

/** Inline point geometry directly on an item (Bayern), if present. WGS84 lat/lon. */
function inlinePoint(node: XmlObject): Point | undefined {
  const find = (n: unknown): Point | undefined => {
    if (Array.isArray(n)) {
      for (const it of n) {
        const r = find(it);
        if (r) return r;
      }
      return undefined;
    }
    if (!isXmlObject(n)) return undefined;
    if ("latitude" in n && "longitude" in n) {
      const lat = Number(xmlText(n["latitude"]));
      const lon = Number(xmlText(n["longitude"]));
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { type: "Point", coordinates: [lon, lat] };
      }
    }
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_")) continue;
      const r = find(value);
      if (r) return r;
    }
    return undefined;
  };
  return find(node);
}

function num(v: unknown): number | undefined {
  const n = v != null ? Number(xmlText(v) ?? v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** The vehicle class an item states (`forVehiclesWithCharacteristicsOf`), as a model class. */
function vehicleClassOf(basic: XmlObject): string | undefined {
  const of = getXmlChild(basic, "forVehiclesWithCharacteristicsOf");
  return of ? datexVehicleClass(getXmlChildText(of, "vehicleType")) : undefined;
}

const SHORT: Record<string, string> = { [SPEED]: "speed", [VOLUME]: "volume" };

export function parseElaboratedFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      validate: false,
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) => n === "elaboratedData" || n === "basicData",
    });
  } catch (err) {
    console.warn("[datex-elaborated] failed to parse XML:", err);
    return { readings: [], failed: true };
  }

  const publication = findElaboratedPublication(doc);
  if (!publication) return { readings: [], failed: true };

  const items = xmlNodeToArray(publication["elaboratedData"]);
  const acc = new Map<string, SiteAcc>();

  for (const item of items) {
    if (!isXmlObject(item)) continue;
    const basics = xmlNodeToArray(item["basicData"]).filter(isXmlObject);
    for (const basic of basics) {
      const siteId = locationRefId(item) ?? locationRefId(basic);
      if (!siteId) continue;
      const cur: SiteAcc = acc.get(siteId) ?? { siteId, speeds: [], flows: [], streams: new Map() };
      const type = basicDataType(basic);
      const vehicleClass = vehicleClassOf(basic);
      const classed = vehicleClass !== undefined ? { vehicleClass } : {};
      const stream = (property: string) => {
        if (vehicleClass !== undefined) {
          cur.streams.set(`${SHORT[property]}:${vehicleClass}`, { property, vehicleClass });
        }
      };
      const measuredAt =
        getXmlChildText(basic, "measurementOrCalculationTime") ??
        getXmlChildText(item, "measurementOrCalculationTime");
      if (measuredAt) cur.measuredAt ??= measuredAt;

      if (type === "TrafficSpeed" || getXmlChild(basic, "averageVehicleSpeed")) {
        const sp = getXmlChild(basic, "averageVehicleSpeed");
        if (sp) {
          stream(SPEED);
          const speed = num(sp["speed"]);
          // An absent count is "not published"; a count stated as <= 0 means
          // no vehicles this interval, and its speed is no reading.
          const inputRaw = sp["@_numberOfInputValuesUsed"];
          const count = inputRaw != null ? Number(xmlText(inputRaw) ?? inputRaw) : undefined;
          if (
            xmlText(sp["dataError"]) !== "true" &&
            plausibleSpeed(speed) &&
            (count === undefined || !Number.isFinite(count) || count > 0)
          ) {
            cur.speeds.push({
              speed,
              ...(count !== undefined && Number.isFinite(count) ? { count } : {}),
              ...classed,
            });
          }
        }
      }
      if (type === "TrafficFlow" || getXmlChild(basic, "vehicleFlow")) {
        const vf = getXmlChild(basic, "vehicleFlow");
        stream(VOLUME);
        const rate = vf
          ? num(vf["vehicleFlowRate"])
          : num(getXmlChildText(basic, "vehicleFlowRate"));
        // A publisher-flagged invalid rate is no reading.
        if (xmlText(vf?.["dataError"]) !== "true" && rate != null && rate >= 0) {
          cur.flows.push({ rate, ...classed });
        }
      }
      // trafficStatus arrives nested (`<trafficStatus><trafficStatusValue>`)
      // or as a plain-text leaf, the DATEX v2 enum-member form.
      const statusValue =
        xmlText(getXmlChild(basic, "trafficStatus")?.["trafficStatusValue"]) ??
        getXmlChildText(basic, "trafficStatus");
      if (type === "TrafficStatus" || statusValue != null) cur.trafficStatus ??= statusValue;
      cur.inlineGeom ??= inlinePoint(basic) ?? inlinePoint(item);
      acc.set(siteId, cur);
    }
  }

  const readings: FlowReading[] = [];
  for (const site of acc.values()) {
    const meta = sites?.get(site.siteId);
    const lane = laneIndex(meta?.lane, src, meta?.laneCount);
    const channels: ChannelReading[] = [];
    const add = (property: string, value: number, vehicleClass: string | undefined) => {
      if (vehicleClass === undefined) return;
      channels.push({
        key: `${SHORT[property]}:${vehicleClass}`,
        property,
        value,
        vehicleClass,
        ...(lane !== undefined ? { lane } : {}),
      });
    };
    for (const s of site.speeds) add(SPEED, s.speed, s.vehicleClass);
    for (const f of site.flows) add(VOLUME, f.rate, f.vehicleClass);
    // Every class stream the document carries is a channel of the site, also
    // one with no vehicles this interval: the site stays the same feature.
    const declaredChannels: ChannelSpec[] = [...site.streams].map(([key, s]) => ({
      key,
      property: s.property,
      vehicleClass: s.vehicleClass,
      ...(lane !== undefined ? { lane } : {}),
    }));
    const speed = siteSpeed(site.speeds);
    const volume = siteVolume(site.flows);
    const reading = measuredReading({
      site: site.siteId,
      geometry: site.inlineGeom ?? meta?.geometry,
      ...(site.measuredAt !== undefined ? { at: site.measuredAt } : {}),
      ...(speed !== undefined ? { speedKph: speed.speedKph } : {}),
      ...(speed?.sampleCount !== undefined ? { sampleCount: speed.sampleCount } : {}),
      ...(site.trafficStatus !== undefined ? { trafficStatus: site.trafficStatus } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(channels.length > 0 ? { channels } : {}),
      ...(declaredChannels.length > 0 ? { declaredChannels } : {}),
      ...(meta?.name !== undefined ? { name: meta.name } : {}),
      ...(meta?.nameLang !== undefined ? { nameLang: meta.nameLang } : {}),
    });
    if (reading) readings.push(reading);
  }
  return { readings };
}
