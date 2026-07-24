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
import type { LineString, Point } from "geojson";
import type {
  LineStringGeometry,
  Observation,
  PointGeometry,
  Severity,
} from "@openconditions/core";
import type { BaselineMethod, RoadEvent, RoadFlow } from "./model.js";
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
import type { XmlObject } from "./xml.js";

export type FlowParseResult = {
  flows: RoadFlow[];
  events: RoadEvent[];
  /**
   * Set when the document could not be read at all (JSON/XML parse threw, or
   * no recognizable publication/root was found) — a HARD parse failure, as
   * opposed to a well-formed document that legitimately carries zero
   * measurements this cycle. Absent (or false) in every other case, including
   * a genuinely empty document. Callers (see `runSource`) must treat a
   * `failed` result exactly like a fetch failure — skip the swap rather than
   * handing an empty/partial set to `atomicSwap`, which would otherwise wipe
   * the source's last-good rows.
   */
  failed?: boolean;
};

/** Geometry shapes a flow measurement can carry (point sensors or segments). */
type FlowGeometry = Point | LineString;

export type { FlowGeometry };

type LosValue = RoadFlow["los"];

const QUEUING_LOS = new Set<LosValue>(["queuing", "stationary", "blocked"]);

/**
 * Upper plausibility bound for a DATEX speed reading, in kph. A reading at or
 * above this is a sensor/feed glitch, not a real vehicle speed — rejected as
 * no usable speed everywhere a speed is extracted or persisted (parsers here
 * and the baseline history in baseline-store.ts).
 */
export const ABSURD_SPEED_KPH = 250;

/**
 * The single free-flow-ratio → level-of-service threshold ladder, shared by
 * buildMeasuredSiteFlow and reclassifyFlow so there is exactly one thresholds
 * definition.
 */
function losFromSpeedRatio(ratio: number): LosValue {
  if (ratio >= 0.85) return "free_flow";
  if (ratio >= 0.5) return "heavy";
  if (ratio >= 0.15) return "queuing";
  return "stationary";
}

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
    validFrom: flow.dataUpdatedAt,
    ...(flow.direction ? { direction: flow.direction } : {}),
    ...(flow.freeFlowSource ? { freeFlowSource: flow.freeFlowSource } : {}),
  };
}

export function makeOrigin(src: SourceDescriptor) {
  return {
    kind: "feed" as const,
    attribution: {
      provider: src.attribution,
      license: src.license,
      url: src.licenseUrl,
    },
  };
}

/**
 * A single representative [lon, lat] for a flow's geometry: a Point's own
 * coordinates, or a LineString's middle vertex. Used to store a sensor's
 * location as a Point in sensor_speed_sample.
 */
export function representativePoint(geom: PointGeometry | LineStringGeometry): [number, number] {
  if (geom.type === "Point") {
    return [geom.coordinates[0]!, geom.coordinates[1]!];
  }
  const coords = geom.coordinates;
  const mid = coords[Math.floor(coords.length / 2)] ?? coords[0]!;
  return [mid[0]!, mid[1]!];
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
  // safeParse returns null on a hard failure: JSON.parse threw, or the top-level
  // value isn't an object at all — an error page or other garbage body, not a
  // legitimately empty feed. Flag it so `runSource` skips the swap instead of
  // wiping last-good rows with this empty result.
  if (!payload) return { flows: [], events: [], failed: true };

  const features = payload["features"];
  // A well-formed document with no (or an empty) features array is a real "0
  // measurements this cycle" — not flagged as failed; see the shrink tripwire
  // in runSource for how a flow feed's own "never legitimately empty" rule
  // handles this instead.
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

      if (!geometry || typeof geometry !== "object" || !Array.isArray(geometry["coordinates"])) {
        continue;
      }

      const geomType = geometry["type"];
      if (geomType !== "LineString" && geomType !== "MultiLineString") {
        continue;
      }

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

      // For MultiLineString, emit one RoadFlow per member line so each
      // observation carries a plain LineString geometry (model constraint).
      const lineStrings: LineString[] =
        geomType === "MultiLineString"
          ? (geometry["coordinates"] as [number, number][][]).map((ring) => ({
              type: "LineString",
              coordinates: ring,
            }))
          : [
              {
                type: "LineString",
                coordinates: geometry["coordinates"] as [number, number][],
              } satisfies LineString,
            ];

      lineStrings.forEach((geom, lineIndex) => {
        const lineId = lineStrings.length > 1 ? `${featureId}:${lineIndex}` : featureId;
        const flow: RoadFlow = {
          id: `${src.id}:${lineId}`,
          source: src.id,
          sourceFormat: "digitraffic",
          domain: "roads",
          kind: "measurement",
          metric: "flow",
          aggregation: "live",
          status: "active",
          geometry: geom,
          los,
          ...(avgSpeed != null ? { speedKph: avgSpeed } : {}),
          ...(freeFlowSpeed != null
            ? { freeFlowKph: freeFlowSpeed, freeFlowSource: "native" as const }
            : {}),
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
          events.push(derivedCongestionEvent(flow, src, lineId));
        }
      });
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
  if (lower === "queuing" || lower === "congested") return "queuing";
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
  // n >= 0 rejects NDW's -1 no-data sentinel while keeping a genuine 0 (a real
  // standstill survives to the numberOfInputValuesUsed gate at the call site,
  // see readMeasuredSpeedSample/the best-sample loop in parseDatexMeasuredData
  // below); n < ABSURD_SPEED_KPH rejects implausible sensor-glitch readings.
  return Number.isFinite(n) && n >= 0 && n < ABSURD_SPEED_KPH ? n : undefined;
}

function extractDatexFreeFlowSpeed(node: unknown): number | undefined {
  if (!isXmlObject(node)) return undefined;
  const ffNode = getXmlChild(node, "freeFlowSpeed");
  if (!ffNode) return undefined;
  const raw = xmlText(ffNode["speed"]);
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function resolveLineStringFromLocRef(locRef: unknown): LineString | null {
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
 * Builds an id→LineString map from a DATEX II measurementSiteTable element.
 * Many real-world feeds place geometry on the site record rather than inline
 * on each measuredValue; this map lets measurements fall back to the site's
 * geometry when no inline locationReference is present.
 */
function buildSiteGeometryMap(
  root: ReturnType<typeof parseXmlDocument>
): Map<string, FlowGeometry> {
  const map = new Map<string, FlowGeometry>();

  const visitSiteTable = (node: unknown): void => {
    if (!isXmlObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@_")) continue;
      const local = stripXmlNamespace(key);
      if (local === "measurementSiteTable") {
        for (const tableNode of xmlNodeToArray(value)) {
          if (!isXmlObject(tableNode)) continue;
          for (const [k2, v2] of Object.entries(tableNode)) {
            if (k2.startsWith("@_")) continue;
            const local2 = stripXmlNamespace(k2);
            if (local2 === "measurementSite") {
              for (const site of xmlNodeToArray(v2)) {
                if (!isXmlObject(site)) continue;
                const siteId =
                  (site["@_id"] as string | undefined) ??
                  (site["@_targetClass"] as string | undefined);
                if (!siteId) continue;
                const locRef = getXmlChild(site, "measurementSiteLocation");
                if (locRef) {
                  const geom = resolveLineStringFromLocRef(locRef);
                  if (geom) map.set(siteId, geom);
                }
              }
            }
          }
        }
      } else {
        visitSiteTable(value);
      }
    }
  };

  visitSiteTable(root);
  return map;
}

/**
 * Reads a single measuredValue's `basicData`/`basicDataValue` payload for a
 * representative average speed. Returns the speed plus the
 * `numberOfInputValuesUsed` weight so the caller can pick the best-supported
 * sample per site, and any `trafficStatus`/`freeFlowSpeed` carried alongside.
 *
 * Handles two real shapes: NDW's `<basicData xsi:type="TrafficSpeed">` with the
 * vehicle count as an `averageVehicleSpeed` attribute, and the older
 * `<basicDataValue>`/`<trafficStatus>` layout. A speed < 0 (NDW's -1 no-data
 * sentinel) or >= ABSURD_SPEED_KPH yields a null speed. `inputCount` defaults
 * to 1 (not 0) when the feed never publishes `numberOfInputValuesUsed` at all
 * (the older layout) — the zero-input gate at the call site must only reject a
 * count that is explicitly reported as <= 0 (NDW's "no vehicles observed this
 * interval" shape), not a feed that simply doesn't report a count.
 */
function firstDataNode(node: XmlObject): XmlObject | undefined {
  const direct =
    getXmlChild(node, "basicData") ??
    getXmlChild(node, "basicDataValue") ??
    getXmlChild(node, "elaboratedDataValue");
  if (direct) return direct;
  // The Autobahn GmbH BAB feeds wrap basicData two layers deeper than NDW:
  // `measuredValue > measuredValueExtension > measuredValues > basicData`.
  // Descend through those before giving up (the streaming SAX parser reaches
  // the leaf regardless of nesting; this keeps the buffered parser in step).
  const values = getXmlChild(node, "measuredValueExtension") ?? undefined;
  const inner = values ? getXmlChild(values, "measuredValues") : undefined;
  return inner ? firstDataNode(inner) : undefined;
}

function readMeasuredSpeedSample(mv: XmlObject): {
  speedKph?: number;
  inputCount: number;
  trafficStatus?: string;
  freeFlowKph?: number;
} {
  // The basicData may sit directly on the outer measuredValue (older feeds) or
  // one level down inside a nested `measuredValue` (the real NDW layout, where
  // the inner element parses to an array because measuredValue is array-marked).
  let dataNode = firstDataNode(mv);
  if (!dataNode) {
    for (const inner of xmlNodeToArray(mv["measuredValue"])) {
      if (!isXmlObject(inner)) continue;
      dataNode = firstDataNode(inner);
      if (dataNode) break;
    }
  }
  if (!dataNode) return { inputCount: 0 };

  const speedNode = getXmlChild(dataNode, "averageVehicleSpeed");
  const inputRaw = speedNode?.["@_numberOfInputValuesUsed"];
  const inputCount = inputRaw != null ? Number(xmlText(inputRaw) ?? inputRaw) : 1;

  const speedKph = extractDatexSpeed(dataNode);
  const trafficStatus = xmlText(dataNode["trafficStatus"]);
  const freeFlowKph = extractDatexFreeFlowSpeed(dataNode);

  return {
    ...(speedKph != null ? { speedKph } : {}),
    inputCount: Number.isFinite(inputCount) ? inputCount : 0,
    ...(trafficStatus != null ? { trafficStatus } : {}),
    ...(freeFlowKph != null ? { freeFlowKph } : {}),
  };
}

/** The per-site fields a MeasuredData parser extracts before building a flow. */
export interface MeasuredSiteFields {
  siteId: string;
  measuredAt: string;
  geom: FlowGeometry | null;
  speedKph?: number;
  trafficStatus?: string;
  freeFlowKph?: number;
}

/**
 * Builds the RoadFlow (and any derived congestion RoadEvent) for one measurement
 * site from the fields a parser extracted, applying the shared level-of-service,
 * speed-ratio and skip rules. Returns null when the site has no resolvable
 * geometry, or carries neither a valid speed nor a resolvable level-of-service.
 * When the feed itself carries an inline free-flow speed, stamps
 * freeFlowSource:"native" alongside freeFlowKph; a site with no inline
 * free-flow leaves freeFlowSource absent so a later DB-baseline pass
 * ({@link reclassifyFlow}) can stamp its own provenance.
 *
 * Shared by the buffered DOM parser ({@link parseDatexMeasuredData}) and the
 * streaming parser ({@link createMeasuredDataParser}) so both emit identical
 * observations regardless of how the document was read.
 */
export function buildMeasuredSiteFlow(
  fields: MeasuredSiteFields,
  src: SourceDescriptor,
  origin: RoadFlow["origin"],
  now: string
): { flow: RoadFlow; event?: RoadEvent } | null {
  const { siteId, measuredAt, geom, speedKph, trafficStatus, freeFlowKph } = fields;

  let los: LosValue = mapDatexTrafficStatus(trafficStatus);
  if (los === "unknown" && speedKph != null && freeFlowKph != null && freeFlowKph > 0) {
    los = losFromSpeedRatio(speedKph / freeFlowKph);
  }

  // Skip sites with no geometry, or with neither a valid speed nor a resolvable
  // level-of-service (a flow row with nothing to say).
  if (!geom || (speedKph == null && los === "unknown")) return null;

  const speedRatio =
    speedKph != null && freeFlowKph != null && freeFlowKph > 0 ? speedKph / freeFlowKph : undefined;

  const flow: RoadFlow = {
    id: `${src.id}:${siteId}`,
    source: src.id,
    sourceFormat: "datex2",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    ...(speedKph != null ? { value: speedKph, unit: "km/h" } : {}),
    level: los,
    aggregation: "live",
    status: "active",
    geometry: geom,
    los,
    ...(speedKph != null ? { speedKph } : {}),
    ...(freeFlowKph != null ? { freeFlowKph, freeFlowSource: "native" as const } : {}),
    ...(speedRatio != null ? { speedRatio } : {}),
    origin,
    dataUpdatedAt: measuredAt,
    fetchedAt: now,
    isStale: false,
  };

  if (QUEUING_LOS.has(los)) {
    return { flow, event: derivedCongestionEvent(flow, src, siteId) };
  }
  return { flow };
}

/**
 * Applies a resolved free-flow baseline to a flow that lacks one, recomputing
 * los from the shared threshold ladder and stamping the baseline provenance
 * (freeFlowSource), appending a derived congestion event when los reaches queuing
 * or worse. Reuses mapDatexTrafficStatus precedence via the caller's guard: a
 * flow that already has a non-"unknown" los (from a trafficStatus) or already
 * carries a freeFlowKph is returned untouched, as is a flow with no speed or a
 * non-positive baseline.
 */
export function reclassifyFlow(
  flow: RoadFlow,
  freeFlowKph: number,
  freeFlowSource: BaselineMethod,
  src: SourceDescriptor
): { flow: RoadFlow; event?: RoadEvent } {
  if (
    flow.los !== "unknown" ||
    flow.freeFlowKph != null ||
    flow.speedKph == null ||
    freeFlowKph <= 0
  ) {
    return { flow };
  }
  const ratio = flow.speedKph / freeFlowKph;
  const los = losFromSpeedRatio(ratio);
  const next: RoadFlow = {
    ...flow,
    freeFlowKph,
    freeFlowSource,
    speedRatio: ratio,
    los,
    level: los,
  };
  const suffix = next.id.startsWith(`${src.id}:`) ? next.id.slice(src.id.length + 1) : next.id;
  if (QUEUING_LOS.has(los)) {
    return { flow: next, event: derivedCongestionEvent(next, src, suffix) };
  }
  return { flow: next };
}

/**
 * Single post-parse enrichment seam covering every flow format. For each
 * measurement flow that carries a speed but no freeFlowKph, applies the
 * baseline from baselineMap (keyed by flow.id) via reclassifyFlow, replacing
 * the flow and appending any derived congestion event. The baseline's method
 * is threaded into reclassifyFlow so the flow's freeFlowSource records its
 * provenance. Non-flow observations, and flows with no matching baseline
 * entry, pass through unchanged.
 */
export function enrichFlowsWithBaseline(
  observations: Observation[],
  baselineMap: Map<string, { kph: number; method: BaselineMethod }>,
  src: SourceDescriptor
): Observation[] {
  const out: Observation[] = [];
  for (const obs of observations) {
    const isFlow = obs.kind === "measurement" && (obs as RoadFlow).metric === "flow";
    if (!isFlow) {
      out.push(obs);
      continue;
    }
    const flow = obs as RoadFlow;
    const baseline = baselineMap.get(flow.id);
    if (baseline == null) {
      out.push(obs);
      continue;
    }
    const { flow: next, event } = reclassifyFlow(flow, baseline.kph, baseline.method, src);
    out.push(next as unknown as Observation);
    if (event) out.push(event as unknown as Observation);
  }
  return out;
}

/**
 * Parse a DATEX II MeasuredDataPublication into RoadFlow measurements, one per
 * measurement site. The representative average speed for a site is the
 * `TrafficSpeed`/`averageVehicleSpeed` sample with the highest
 * `numberOfInputValuesUsed`, ignoring no-data samples: a speed < 0 (NDW's -1
 * sentinel) or >= ABSURD_SPEED_KPH is never a usable speed, and a sample whose
 * `numberOfInputValuesUsed` is explicitly <= 0 is rejected regardless of its
 * speed value — this is what distinguishes a no-data zero ("no vehicles
 * observed this interval", speed reported as 0 alongside a 0 count) from a
 * genuine standstill (speed 0 with a positive count), which is kept and still
 * classifies as congestion.
 *
 * Geometry is resolved by priority: an inline `locationReference` on a
 * measuredValue, then an inline `measurementSiteTable` entry, then the external
 * `siteMap` keyed by `measurementSiteReference id` (the NDW layout, where the
 * site geometry lives in a separate site-table document). Sites with no
 * resolvable geometry or no valid speed are skipped.
 *
 * `los` is left "unknown" unless the source carries a `trafficStatus` or a
 * free-flow baseline to compare against: absolute speed alone is not a reliable
 * congestion signal (it is road-class–dependent). No derived congestion event
 * is emitted while los is "unknown" — only feeds that supply a status/baseline
 * (so los reaches queuing or worse) produce one.
 */
export function parseDatexMeasuredData(
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, FlowGeometry>
): FlowParseResult {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      // The recurring (~60 s) trafficspeed feed is ~50 MB; re-validating it on
      // every run is wasted CPU on the hot path. The entity-bomb guard in
      // parseXmlDocument still runs regardless of `validate`.
      validate: false,
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) =>
        n === "siteMeasurements" ||
        n === "measuredValue" ||
        n === "value" ||
        n === "measurementSite",
    });
  } catch (err) {
    console.warn("[datex-flow] failed to parse XML:", err);
    return { flows: [], events: [], failed: true };
  }

  const root = doc;
  const flows: RoadFlow[] = [];
  const events: RoadEvent[] = [];
  const now = new Date().toISOString();
  const origin = makeOrigin(src);

  const siteGeometryMap = buildSiteGeometryMap(root);

  const publication = findMeasuredPublication(root);
  // No siteMeasurements-bearing node anywhere in the document: the XML parsed,
  // but this isn't a recognizable MeasuredDataPublication at all (wrong feed
  // shape, HTML error page, truncated envelope) — a hard failure, not a
  // legitimately empty publication.
  if (!publication) return { flows: [], events: [], failed: true };

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

      let geom: FlowGeometry | null = null;
      // The best speed sample is the one with the highest input-value count
      // (most-supported reading), ignoring no-data samples. trafficStatus and a
      // free-flow baseline are captured even from speed-less samples so a
      // status-only feed still yields a level-of-service.
      let best: ReturnType<typeof readMeasuredSpeedSample> | null = null;
      let trafficStatus: string | undefined;
      let freeFlowKph: number | undefined;

      for (const mv of measuredValues) {
        if (geom == null) {
          const locRef = getXmlChild(mv, "locationReference");
          geom = locRef ? resolveLineStringFromLocRef(locRef) : null;
        }

        const sample = readMeasuredSpeedSample(mv);
        trafficStatus ??= sample.trafficStatus;
        freeFlowKph ??= sample.freeFlowKph;
        if (sample.speedKph == null) continue;
        // A count explicitly reported as <= 0 means "no vehicles observed this
        // interval" — a speed of 0 alongside it is a no-data zero, not a
        // genuine standstill, and must never become `best` (it would otherwise
        // masquerade as a real stationary reading). A speed > 0 with count <= 0
        // is equally untrustworthy. inputCount defaults to 1 when a feed never
        // reports the attribute at all, so this only rejects an explicit zero.
        if (sample.inputCount <= 0) continue;
        if (best == null || sample.inputCount > best.inputCount) {
          best = sample;
        }
      }

      if (geom == null) {
        geom = siteGeometryMap.get(siteId) ?? siteMap?.get(siteId) ?? null;
      }

      const built = buildMeasuredSiteFlow(
        {
          siteId,
          measuredAt,
          geom,
          ...(best?.speedKph != null ? { speedKph: best.speedKph } : {}),
          ...(trafficStatus != null ? { trafficStatus } : {}),
          ...(freeFlowKph != null ? { freeFlowKph } : {}),
        },
        src,
        origin,
        now
      );
      if (built) {
        flows.push(built.flow);
        if (built.event) events.push(built.event);
      }
    } catch (err) {
      console.warn("[datex-flow] skipped malformed siteMeasurements:", err);
    }
  }

  return { flows, events };
}

/**
 * Find the publication object that carries `siteMeasurements`, descending
 * through whatever envelope wraps it (SOAP Envelope/Body, d2LogicalModel,
 * messageContainer/payload). Returns the first node containing siteMeasurements.
 */
function findMeasuredPublication(root: unknown): XmlObject | null {
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findMeasuredPublication(item);
      if (found) return found;
    }
    return null;
  }
  if (!isXmlObject(root)) return null;
  if ("siteMeasurements" in root) return root;
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith("@_")) continue;
    const found = findMeasuredPublication(value);
    if (found) return found;
  }
  return null;
}
