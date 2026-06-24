/**
 * Flow measurement parsers for Digitraffic (JSON) and DATEX II MeasuredData
 * (XML) feeds. Each parser returns a set of RoadFlow measurements plus any
 * derived congestion RoadEvents (emitted when los >= queuing so the overlay
 * shows congestion without a separate render path).
 *
 * Generating Valhalla traffic.tar or OSRM segment-speed files from this data
 * (the heavy realtime-speeds pipeline) is explicitly out of scope here and
 * tracked separately in routing-improvements.md §8/§9.
 * conditions.observations is the data foundation that pipeline will consume.
 */
import type { LineString } from "geojson";
import type { Severity } from "@openconditions/core";
import type { RoadEvent, RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import {
  getXmlChild,
  getXmlChildren,
  isXmlObject,
  parseXmlDocument,
  stripXmlNamespace,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

export type FlowParseResult = {
  flows: RoadFlow[];
  events: RoadEvent[];
};

type LosValue = RoadFlow["los"];

const QUEUING_LOS = new Set<LosValue>(["queuing", "stationary", "blocked"]);

function losSeverity(los: LosValue): Severity {
  if (los === "blocked" || los === "stationary") return "critical";
  if (los === "queuing") return "high";
  return "medium";
}

function derivedCongestionEvent(
  flow: RoadFlow,
  src: SourceDescriptor,
  idSuffix: string
): RoadEvent {
  const severity = losSeverity(flow.los);
  return {
    id: `${flow.id}:congestion`,
    source: src.id,
    sourceFormat: flow.sourceFormat,
    domain: "roads",
    kind: "event",
    type: "congestion",
    category: "conditions",
    isPlanned: false,
    severity,
    severitySource: "derived",
    headline: `Traffic congestion (${idSuffix})`,
    status: "active",
    geometry: flow.geometry,
    roads: [],
    origin: flow.origin,
    dataUpdatedAt: flow.dataUpdatedAt,
    fetchedAt: flow.fetchedAt,
    isStale: false,
  };
}

function makeOrigin(src: SourceDescriptor) {
  return {
    kind: "feed" as const,
    attribution: {
      provider: src.attribution,
      license: src.license,
      url: src.licenseUrl,
    },
  };
}

function safeParse(input: string | Buffer | object): Record<string, unknown> | null {
  try {
    const str = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    const parsed = typeof str === "string" ? JSON.parse(str) : str;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function mapDigitrafficCongestionLevel(raw: unknown): LosValue {
  switch (typeof raw === "string" ? raw.toUpperCase() : "") {
    case "FREE_FLOW":
      return "free_flow";
    case "LIGHT":
      return "free_flow";
    case "HEAVY":
      return "heavy";
    case "QUEUING":
      return "queuing";
    case "STATIONARY":
      return "stationary";
    case "BLOCKED":
      return "blocked";
    default:
      return "unknown";
  }
}

/**
 * Parse a Digitraffic traffic-measurement GeoJSON feed into RoadFlow
 * measurements. Features that carry no LineString geometry are skipped.
 * A derived congestion RoadEvent is also emitted for every segment whose
 * level-of-service is queuing, stationary, or blocked.
 */
export function parseDigitrafficFlow(
  input: string | Buffer | object,
  src: SourceDescriptor
): FlowParseResult {
  const payload = safeParse(input);
  if (!payload) return { flows: [], events: [] };

  const features = payload["features"];
  if (!Array.isArray(features) || features.length === 0) return { flows: [], events: [] };

  const flows: RoadFlow[] = [];
  const events: RoadEvent[] = [];
  const now = new Date().toISOString();
  const origin = makeOrigin(src);

  for (const rawFeature of features) {
    try {
      if (!rawFeature || typeof rawFeature !== "object") continue;
      const feature = rawFeature as Record<string, unknown>;
      const geometry = feature["geometry"] as Record<string, unknown> | null | undefined;

      if (
        !geometry ||
        typeof geometry !== "object" ||
        geometry["type"] !== "LineString" ||
        !Array.isArray(geometry["coordinates"])
      ) {
        continue;
      }

      const geom: LineString = {
        type: "LineString",
        coordinates: geometry["coordinates"] as [number, number][],
      };

      const props = (feature["properties"] ?? {}) as Record<string, unknown>;
      const featureId = typeof props["id"] === "string" ? props["id"] : `flow-${flows.length + 1}`;

      const los = mapDigitrafficCongestionLevel(props["congestionLevel"]);

      const avgSpeed =
        typeof props["averageSpeed"] === "number" ? props["averageSpeed"] : undefined;
      const freeFlowSpeed =
        typeof props["freeFlowSpeed"] === "number" ? props["freeFlowSpeed"] : undefined;
      const speedRatio =
        avgSpeed != null && freeFlowSpeed != null && freeFlowSpeed > 0
          ? avgSpeed / freeFlowSpeed
          : undefined;
      const delaySeconds =
        typeof props["delaySeconds"] === "number" ? props["delaySeconds"] : undefined;
      const jamFactor = typeof props["jamFactor"] === "number" ? props["jamFactor"] : undefined;

      const measuredAt = typeof props["measuredTime"] === "string" ? props["measuredTime"] : now;

      const flow: RoadFlow = {
        id: `${src.id}:${featureId}`,
        source: src.id,
        sourceFormat: "digitraffic-json",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        aggregation: "live",
        status: "active",
        geometry: geom,
        los,
        ...(avgSpeed != null ? { speedKph: avgSpeed } : {}),
        ...(freeFlowSpeed != null ? { freeFlowKph: freeFlowSpeed } : {}),
        ...(speedRatio != null ? { speedRatio } : {}),
        ...(delaySeconds != null ? { delaySeconds } : {}),
        ...(jamFactor != null ? { jamFactor } : {}),
        origin,
        dataUpdatedAt: measuredAt,
        fetchedAt: now,
        isStale: false,
      };

      flows.push(flow);

      if (QUEUING_LOS.has(los)) {
        events.push(derivedCongestionEvent(flow, src, featureId));
      }
    } catch (err) {
      console.warn("[digitraffic-flow] skipped malformed feature:", err);
    }
  }

  return { flows, events };
}

function mapDatexTrafficStatus(raw: string | undefined): LosValue {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase().trim();
  if (lower === "freeflow" || lower === "free_flow" || lower === "normaltraffic") {
    return "free_flow";
  }
  if (lower === "heavy" || lower === "heavy_traffic" || lower === "slowtraffic") {
    return "heavy";
  }
  if (lower === "queuing") return "queuing";
  if (lower === "stationary" || lower === "standstill") return "stationary";
  if (lower === "blocked" || lower === "impossible") return "blocked";
  return "unknown";
}

function extractDatexSpeed(node: unknown): number | undefined {
  if (!isXmlObject(node)) return undefined;

  const speedNode = getXmlChild(node, "averageVehicleSpeed");
  if (!speedNode) return undefined;

  const dataError = xmlText(speedNode["dataError"]);
  if (dataError === "true") return undefined;

  const speedRaw = xmlText(speedNode["speed"]);
  const n = speedRaw != null ? Number(speedRaw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function extractDatexFreeFlowSpeed(node: unknown): number | undefined {
  if (!isXmlObject(node)) return undefined;
  const ffNode = getXmlChild(node, "freeFlowSpeed");
  if (!ffNode) return undefined;
  const raw = xmlText(ffNode["speed"]);
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function resolveLineStringFromLocRef(locRef: unknown): LineString | null {
  if (!isXmlObject(locRef)) return null;

  const visit = (node: unknown): [number, number][] | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const result = visit(item);
        if (result) return result;
      }
      return null;
    }
    if (!isXmlObject(node)) return null;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@_")) continue;
      const localKey = stripXmlNamespace(key);
      if (localKey === "posList") {
        for (const posNode of xmlNodeToArray(value)) {
          const raw = xmlText(posNode);
          if (!raw) continue;
          const nums = raw.trim().split(/\s+/).map(Number);
          const coords: [number, number][] = [];
          for (let i = 0; i + 1 < nums.length; i += 2) {
            const lat = nums[i]!;
            const lon = nums[i + 1]!;
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              coords.push([lon, lat]);
            }
          }
          if (coords.length >= 2) return coords;
        }
      }
      const nested = visit(value);
      if (nested) return nested;
    }
    return null;
  };

  const coords = visit(locRef);
  if (!coords || coords.length < 2) return null;
  return { type: "LineString", coordinates: coords };
}

/**
 * Parse a DATEX II MeasuredDataPublication (or similarly structured
 * ElaboratedData) XML document into RoadFlow measurements. Only site
 * measurements that carry a LineString (posList) geometry are emitted;
 * point-only records are skipped. A derived congestion RoadEvent is emitted
 * for every segment with los >= queuing.
 */
export function parseDatexMeasuredData(
  input: string | Buffer,
  src: SourceDescriptor
): FlowParseResult {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) => n === "siteMeasurements" || n === "measuredValue" || n === "value",
    });
  } catch (err) {
    console.warn("[datex-flow] failed to parse XML:", err);
    return { flows: [], events: [] };
  }

  const root = doc;
  const flows: RoadFlow[] = [];
  const events: RoadEvent[] = [];
  const now = new Date().toISOString();
  const origin = makeOrigin(src);

  const publication = findMeasuredPublication(root);
  if (!publication) return { flows: [], events: [] };

  const sitesMeasurements = getXmlChildren(publication, "siteMeasurements");

  for (const siteM of sitesMeasurements) {
    try {
      const siteRefNode = getXmlChild(siteM, "measurementSiteReference");
      const siteId =
        (siteRefNode?.["@_id"] as string | undefined) ??
        (siteRefNode?.["@_targetClass"] as string | undefined) ??
        `site-${flows.length + 1}`;

      const measuredAt =
        xmlText(siteM["measurementTimeDefault"]) ?? xmlText(siteM["observationTime"]) ?? now;

      const measuredValues = getXmlChildren(siteM, "measuredValue");

      for (const mv of measuredValues) {
        const locRef = getXmlChild(mv, "locationReference");
        if (!locRef) continue;

        const geom = resolveLineStringFromLocRef(locRef);
        if (!geom) continue;

        const basicDataValue =
          getXmlChild(mv, "basicDataValue") ?? getXmlChild(mv, "elaboratedDataValue");
        if (!basicDataValue) continue;

        const trafficStatusRaw = xmlText(basicDataValue["trafficStatus"]);
        const speedKph = extractDatexSpeed(basicDataValue);
        const freeFlowKph = extractDatexFreeFlowSpeed(basicDataValue);

        let los: LosValue = mapDatexTrafficStatus(trafficStatusRaw);
        if (los === "unknown" && speedKph != null && freeFlowKph != null && freeFlowKph > 0) {
          const ratio = speedKph / freeFlowKph;
          if (ratio >= 0.85) los = "free_flow";
          else if (ratio >= 0.5) los = "heavy";
          else if (ratio >= 0.15) los = "queuing";
          else los = "stationary";
        }

        const speedRatio =
          speedKph != null && freeFlowKph != null && freeFlowKph > 0
            ? speedKph / freeFlowKph
            : undefined;

        const mvIndex = xmlText(mv["@_index"]) ?? String(flows.length + 1);
        const flowId = `${src.id}:${siteId}:${mvIndex}`;

        const flow: RoadFlow = {
          id: flowId,
          source: src.id,
          sourceFormat: "datex2",
          domain: "roads",
          kind: "measurement",
          metric: "flow",
          aggregation: "live",
          status: "active",
          geometry: geom,
          los,
          ...(speedKph != null ? { speedKph } : {}),
          ...(freeFlowKph != null ? { freeFlowKph } : {}),
          ...(speedRatio != null ? { speedRatio } : {}),
          origin,
          dataUpdatedAt: measuredAt,
          fetchedAt: now,
          isStale: false,
        };

        flows.push(flow);

        if (QUEUING_LOS.has(los)) {
          events.push(derivedCongestionEvent(flow, src, siteId));
        }
      }
    } catch (err) {
      console.warn("[datex-flow] skipped malformed siteMeasurements:", err);
    }
  }

  return { flows, events };
}

function findMeasuredPublication(root: ReturnType<typeof parseXmlDocument>) {
  const candidates = [root];

  const logicalModel = getXmlChild(root, "D2LogicalModel") ?? getXmlChild(root, "d2LogicalModel");
  if (logicalModel) candidates.push(logicalModel);

  const msgContainer =
    getXmlChild(root, "messageContainer") ?? getXmlChild(root, "mc:messageContainer");
  if (msgContainer) {
    const payload =
      getXmlChild(msgContainer, "payload") ?? getXmlChild(msgContainer, "payloadPublication");
    if (payload) candidates.push(payload);
  }

  for (const candidate of candidates) {
    if (!isXmlObject(candidate)) continue;
    for (const [key, value] of Object.entries(candidate)) {
      if (key.startsWith("@_")) continue;
      const local = stripXmlNamespace(key);
      if (local === "payloadPublication" || local === "payload") {
        const pub = xmlNodeToArray(value).find(isXmlObject);
        if (pub && "siteMeasurements" in pub) return pub;
      }
      if (local.endsWith("Publication") || local.endsWith("Data")) {
        const pub = xmlNodeToArray(value).find(isXmlObject);
        if (pub && "siteMeasurements" in pub) return pub;
      }
    }
    if ("siteMeasurements" in candidate) return candidate;
  }

  return null;
}
