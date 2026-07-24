/**
 * Buffered parser for a DATEX II ElaboratedDataPublication as published by the
 * Autobahn GmbH BAB detector feeds: dynamic per-minute speed (v), volume (q) and
 * traffic status, one `elaboratedData` item per basicData type (and per lane for
 * the fahrstreifenfein variant), joined to geometry from a companion
 * PredefinedLocations siteMap (see predefined-locations.ts) or an inline
 * location. Items are grouped by their `predefinedLocationReference` id and one
 * RoadFlow is emitted per site, reusing the shared los/speed-ratio rules in
 * buildMeasuredSiteFlow.
 */
import type { LineString, Point } from "geojson";
import type { RoadEvent, RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import {
  ABSURD_SPEED_KPH,
  buildMeasuredSiteFlow,
  makeOrigin,
  type FlowGeometry,
  type FlowParseResult,
} from "./flow.js";
import {
  getXmlChild,
  getXmlChildText,
  isXmlObject,
  parseXmlDocument,
  stripXmlNamespace,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";
import type { XmlObject } from "./xml.js";

/** Per-site accumulator across the elaboratedData items that share a location. */
interface SiteAcc {
  siteId: string;
  bestSpeed?: number;
  bestSpeedInputs: number;
  volume?: number;
  trafficStatus?: string;
  inlineGeom?: FlowGeometry;
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
function inlinePoint(node: XmlObject): Point | LineString | undefined {
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

export function parseElaboratedFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, FlowGeometry>
): FlowParseResult {
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
    return { flows: [], events: [], failed: true };
  }

  const publication = findElaboratedPublication(doc);
  if (!publication) return { flows: [], events: [], failed: true };

  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const items = xmlNodeToArray(publication["elaboratedData"]);
  const acc = new Map<string, SiteAcc>();

  for (const item of items) {
    if (!isXmlObject(item)) continue;
    const basics = xmlNodeToArray(item["basicData"]).filter(isXmlObject);
    for (const basic of basics) {
      const siteId = locationRefId(item) ?? locationRefId(basic);
      if (!siteId) continue;
      const cur = acc.get(siteId) ?? { siteId, bestSpeedInputs: -1 };

      const type = basicDataType(basic);
      const measuredAt =
        getXmlChildText(basic, "measurementOrCalculationTime") ??
        getXmlChildText(item, "measurementOrCalculationTime");
      if (measuredAt) cur.measuredAt ??= measuredAt;

      if (type === "TrafficSpeed" || getXmlChild(basic, "averageVehicleSpeed")) {
        const sp = getXmlChild(basic, "averageVehicleSpeed");
        if (sp) {
          const dataError = xmlText(sp["dataError"]);
          const speed = num(sp["speed"]);
          // Default to 1 when the attribute is absent; a count EXPLICITLY <= 0
          // means "no vehicles observed this interval" (a no-data zero) and must
          // never win — mirrors parseDatexMeasuredData's guard in flow.ts.
          const inputRaw = sp["@_numberOfInputValuesUsed"];
          const inputCount = inputRaw != null ? Number(xmlText(inputRaw) ?? inputRaw) : 1;
          const usableCount = Number.isFinite(inputCount) ? inputCount : 1;
          if (
            dataError !== "true" &&
            speed != null &&
            speed >= 0 &&
            speed < ABSURD_SPEED_KPH &&
            usableCount > 0 &&
            usableCount > cur.bestSpeedInputs
          ) {
            cur.bestSpeed = speed;
            cur.bestSpeedInputs = usableCount;
          }
        }
      }
      if (type === "TrafficFlow" || getXmlChild(basic, "vehicleFlow")) {
        const vf = getXmlChild(basic, "vehicleFlow");
        // Prefer the mainCarriageway/aggregate rate; summing every TrafficFlow
        // item risks double-counting per-lane + carriageway totals. Task 12
        // validates the real shape; provisional behavior: take the first rate
        // seen per site (do not sum).
        const rate = vf
          ? num(vf["vehicleFlowRate"])
          : num(getXmlChildText(basic, "vehicleFlowRate"));
        if (rate != null) cur.volume ??= rate;
      }
      if (type === "TrafficStatus" || getXmlChild(basic, "trafficStatus")) {
        const ts = getXmlChild(basic, "trafficStatus");
        cur.trafficStatus ??= xmlText(ts?.["trafficStatusValue"]) ?? xmlText(ts);
      }
      cur.inlineGeom ??= inlinePoint(basic) ?? inlinePoint(item);
      acc.set(siteId, cur);
    }
  }

  const flows: RoadFlow[] = [];
  const events: RoadEvent[] = [];
  for (const site of acc.values()) {
    const geom = site.inlineGeom ?? siteMap?.get(site.siteId) ?? null;
    const built = buildMeasuredSiteFlow(
      {
        siteId: site.siteId,
        measuredAt: site.measuredAt ?? now,
        geom,
        ...(site.bestSpeed != null ? { speedKph: site.bestSpeed } : {}),
        ...(site.trafficStatus != null ? { trafficStatus: site.trafficStatus } : {}),
      },
      src,
      origin,
      now
    );
    if (!built) continue;
    const flow: RoadFlow = {
      ...built.flow,
      sourceFormat: "datex-elaborated",
      ...(site.volume != null ? { volume: site.volume } : {}),
    };
    flows.push(flow);
    if (built.event) events.push({ ...built.event, sourceFormat: "datex-elaborated" });
  }

  return { flows, events };
}
