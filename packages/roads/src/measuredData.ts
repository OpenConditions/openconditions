/**
 * Streaming parser for a DATEX II MeasuredDataPublication — the recurring
 * traffic-speed/flow feed that pairs with a MeasurementSiteTablePublication.
 *
 * The production NDW trafficspeed feed is ~50 MB uncompressed and is fetched
 * every ~60 s; parsing it into a full DOM balloons to several hundred MB and
 * OOMs a memory-capped ingest. This parser scans the document with a
 * streaming SAX reader instead: peak memory is the output readings plus a
 * small per-site accumulator, regardless of input size. A whole buffered
 * document goes through the same scanner ({@link parseDatexMeasuredData}), so
 * the two paths cannot drift apart.
 *
 * Every `measuredValue` index of a site is kept: speeds, flow rates and
 * occupancies, each as a channel reading carrying the lane, vehicle class and
 * period the site table states for that index. The site speed is the mean of
 * the speed indexes weighted by `numberOfInputValuesUsed`, the site volume
 * the sum of the all-vehicle flow indexes, the site occupancy the mean of the
 * occupancy indexes.
 *
 * Geometry per site, in priority order: an inline `locationReference`
 * `gml:posList` on a measurement, then the site table entry joined by
 * `measurementSiteReference id` (the NDW layout).
 */
import { flattenString, stripXmlNamespace } from "@openconditions/datex2";
import type { LineString } from "geojson";
import { SaxesParser } from "saxes";
import type { FlowContext, FlowSites } from "./flow-output.js";
import {
  type ChannelReading,
  type ChannelSpec,
  type FlowParse,
  type FlowReading,
  laneIndex,
  mean,
  measuredReading,
  OCCUPANCY,
  plausibleSpeed,
  SPEED,
  siteSpeed,
  siteVolume,
  VOLUME,
} from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

/** Incremental, streaming DATEX MeasuredData parser. */
export interface MeasuredDataParser {
  /** Feed a chunk of decoded XML text. Chunks may split mid-element. */
  write(chunk: string): void;
  /** Finalise parsing and return the accumulated readings. */
  close(): FlowParse;
}

/** What one `measuredValue` index of the open site carried. */
interface ValueState {
  key: string;
  speed?: number;
  /** `numberOfInputValuesUsed`, when the feed publishes it. */
  count?: number;
  speedError: boolean;
  flow?: number;
  flowError: boolean;
  occupancy?: number;
  periodSec?: number;
  /** The streams the index carries, whether or not their value counts this interval. */
  streams: Set<string>;
}

/** Per-site accumulator; the surrounding subtree streams past and is discarded. */
interface SiteState {
  siteId?: string;
  timeDefault?: string;
  obsTime?: string;
  trafficStatus?: string;
  freeFlowKph?: number;
  posListCoords: [number, number][];
  values: Map<string, ValueState>;
}

type TextTarget =
  | "avgspeed"
  | "avgspeedDirect"
  | "freeflow"
  | "flowRate"
  | "flowDirect"
  | "occupancy"
  | "period"
  | "trafficStatus"
  | "timeDefault"
  | "obsTime"
  | "dataError"
  | "posList"
  | "siteRef"
  | null;

const num = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw.trim()));

/**
 * Creates a streaming DATEX MeasuredData parser. The returned object accepts
 * decoded XML in arbitrary chunks (which may split mid-element) and, on
 * `close()`, returns the readings. Malformed input is tolerated: a SAX error
 * stops further accumulation and `close()` reports the parse `failed` with
 * whatever resolved before the error.
 */
export function createMeasuredDataParser(
  src: SourceDescriptor,
  sites: FlowSites | undefined,
): MeasuredDataParser {
  const readings: FlowReading[] = [];

  const stack: string[] = [];
  let site: SiteState | null = null;
  // The measuredValue index open, and the stack depth of the element that opened it.
  let current: ValueState | null = null;
  let currentDepth = -1;
  let ordinal = 0;
  let textTarget: TextTarget = null;
  let textBuffer = "";
  let parseError = false;
  // Did the document ever contain the DATEX publication, however few records it held.
  let sawPublication = false;

  // No namespace resolution: tag names arrive verbatim (e.g. `gml:posList`) and
  // are normalised with stripXmlNamespace.
  const parser = new SaxesParser({ position: false });

  // Entity-bomb safety: a feed shipping a DOCTYPE/internal subset is rejected.
  parser.on("doctype", () => {
    throw new Error("XML DOCTYPE/entity declarations are not allowed");
  });
  parser.on("error", () => {
    parseError = true;
  });

  const capture = (target: TextTarget) => {
    textTarget = target;
    textBuffer = "";
  };

  const valueFor = (key: string): ValueState => {
    let v = site!.values.get(key);
    if (v === undefined) {
      v = { key, speedError: false, flowError: false, streams: new Set() };
      site!.values.set(key, v);
    }
    return v;
  };

  parser.on("opentag", (tag) => {
    const local = stripXmlNamespace(tag.name);
    stack.push(local);

    if (local === "siteMeasurements") {
      sawPublication = true;
      site = { posListCoords: [], values: new Map() };
      current = null;
      ordinal = 0;
      capture(null);
      return;
    }
    if (site == null) return;

    const attrs = tag.attributes as Record<string, string>;
    switch (local) {
      case "measurementSiteReference": {
        // Flattened: the id outlives the chunk it came from. Some DATEX v1
        // feeds carry it as text rather than an attribute.
        const ref = attrs["id"] ?? attrs["targetClass"];
        if (ref != null) site.siteId ??= flattenString(ref);
        else capture("siteRef");
        break;
      }
      case "measuredValue": {
        const index = attrs["index"];
        if (index != null) {
          current = valueFor(flattenString(index));
          currentDepth = stack.length;
        } else if (current == null) {
          ordinal += 1;
          current = valueFor(String(ordinal));
          currentDepth = stack.length;
        }
        break;
      }
      case "averageVehicleSpeed": {
        if (current == null) break;
        // An absent count is "not published", not zero: only a count stated
        // as <= 0 ("no vehicles this interval") rejects the speed.
        const rawCount = attrs["numberOfInputValuesUsed"];
        current.streams.add(SPEED);
        current.count = rawCount != null ? Number(rawCount) || 0 : undefined;
        current.speed = undefined;
        current.speedError = false;
        // Some DATEX v1 feeds put the speed as this element's text rather than a nested <speed>.
        capture("avgspeedDirect");
        break;
      }
      case "speed": {
        const parent = stack[stack.length - 2];
        if (parent === "averageVehicleSpeed") capture("avgspeed");
        else if (parent === "freeFlowSpeed") capture("freeflow");
        break;
      }
      case "vehicleFlow":
        // DATEX v1 states the rate as this element's text, v2 nests a <vehicleFlowRate>.
        current?.streams.add(VOLUME);
        capture("flowDirect");
        break;
      case "vehicleFlowRate":
        capture("flowRate");
        break;
      case "percentage":
        if (stack[stack.length - 2] === "occupancy") {
          current?.streams.add(OCCUPANCY);
          capture("occupancy");
        }
        break;
      case "measurementOrCalculationPeriod":
        capture("period");
        break;
      case "dataError":
        capture("dataError");
        break;
      case "trafficStatus":
      case "trafficStatusValue":
        capture("trafficStatus");
        break;
      case "measurementTimeDefault":
        capture("timeDefault");
        break;
      case "observationTime":
        capture("obsTime");
        break;
      case "posList":
        capture("posList");
        break;
    }
  });

  parser.on("text", (t) => {
    if (textTarget != null) textBuffer += t;
  });
  parser.on("cdata", (t) => {
    if (textTarget != null) textBuffer += t;
  });

  parser.on("closetag", (tag) => {
    const local = stripXmlNamespace(tag.name);

    if (site != null) {
      switch (local) {
        case "speed": {
          const v = num(textBuffer);
          if (textTarget === "avgspeed" && current != null) {
            // Negative speeds are no-data sentinels (NDW's -1); speeds at or
            // above the glitch bound are sensor faults. A genuine 0 survives
            // and is gated on the input count instead.
            current.speed = plausibleSpeed(v) ? v : undefined;
          } else if (textTarget === "freeflow" && Number.isFinite(v) && v > 0) {
            site.freeFlowKph ??= v;
          }
          textTarget = null;
          break;
        }
        case "averageVehicleSpeed":
          if (current != null && current.speed == null && textTarget === "avgspeedDirect") {
            const v = num(textBuffer);
            current.speed = plausibleSpeed(v) ? v : undefined;
          }
          if (textTarget === "avgspeedDirect") textTarget = null;
          break;
        case "vehicleFlowRate": {
          const v = num(textBuffer);
          if (current != null && Number.isFinite(v) && v >= 0) current.flow = v;
          textTarget = null;
          break;
        }
        case "vehicleFlow": {
          if (textTarget === "flowDirect") {
            const v = num(textBuffer);
            if (current != null && current.flow == null && Number.isFinite(v) && v >= 0) {
              current.flow = v;
            }
            textTarget = null;
          }
          break;
        }
        case "percentage": {
          const v = num(textBuffer);
          if (
            textTarget === "occupancy" &&
            current != null &&
            Number.isFinite(v) &&
            v >= 0 &&
            v <= 100
          ) {
            current.occupancy = v;
          }
          textTarget = null;
          break;
        }
        case "measurementOrCalculationPeriod": {
          const v = num(textBuffer);
          if (current != null && Number.isFinite(v) && v > 0) current.periodSec = v;
          textTarget = null;
          break;
        }
        case "dataError":
          if (textBuffer.trim() === "true" && current != null) {
            const parent = stack[stack.length - 2];
            if (parent === "vehicleFlow") current.flowError = true;
            else current.speedError = true;
          }
          textTarget = null;
          break;
        case "measurementSiteReference":
          if (textTarget === "siteRef") {
            const t = textBuffer.trim();
            if (t) site.siteId ??= flattenString(t);
            textTarget = null;
          }
          break;
        case "trafficStatus":
        case "trafficStatusValue": {
          const t = textBuffer.trim();
          if (t) site.trafficStatus ??= flattenString(t);
          textTarget = null;
          break;
        }
        case "measurementTimeDefault":
          site.timeDefault = flattenString(textBuffer.trim());
          textTarget = null;
          break;
        case "observationTime":
          site.obsTime = flattenString(textBuffer.trim());
          textTarget = null;
          break;
        case "posList": {
          const nums = textBuffer.trim().split(/\s+/).map(Number);
          for (let i = 0; i + 1 < nums.length; i += 2) {
            const lat = nums[i]!;
            const lon = nums[i + 1]!;
            if (Number.isFinite(lat) && Number.isFinite(lon)) site.posListCoords.push([lon, lat]);
          }
          textTarget = null;
          break;
        }
        case "measuredValue":
          if (stack.length === currentDepth) {
            current = null;
            currentDepth = -1;
          }
          break;
        case "siteMeasurements": {
          const reading = siteReading(site, readings.length, src, sites);
          if (reading) readings.push(reading);
          site = null;
          current = null;
          textTarget = null;
          break;
        }
      }
    }

    stack.pop();
  });

  return {
    write(chunk: string): void {
      if (parseError) return;
      try {
        parser.write(chunk);
      } catch {
        parseError = true;
      }
    },
    close(): FlowParse {
      if (!parseError) {
        try {
          parser.close();
        } catch {
          parseError = true;
        }
      }
      // A SAX error, or a document that never entered the publication (an
      // error page or a wrong-shape body), is a hard failure, never "no readings".
      const failed = parseError || !sawPublication;
      return { readings, ...(failed ? { failed: true } : {}) };
    },
  };
}

/** One closed `siteMeasurements` as a site reading; null when it has nothing to say. */
function siteReading(
  site: SiteState,
  position: number,
  src: SourceDescriptor,
  sites: FlowSites | undefined,
): FlowReading | null {
  const siteId = site.siteId ?? `site-${position + 1}`;
  const meta = site.siteId !== undefined ? sites?.get(site.siteId) : undefined;
  const specOf = (key: string, property: string): ChannelSpec => {
    const declared = meta?.channels?.get(key);
    const lane = laneIndex(declared?.lane, src, meta?.laneCount);
    return {
      key,
      property: declared?.property ?? property,
      ...(lane !== undefined ? { lane } : {}),
      ...(declared?.vehicleClass !== undefined ? { vehicleClass: declared.vehicleClass } : {}),
    };
  };

  const speeds: { speed: number; count?: number; vehicleClass?: string }[] = [];
  const flows: { rate: number; vehicleClass?: string }[] = [];
  const occupancies: number[] = [];
  const channels: ChannelReading[] = [];
  const periods = new Set<number | undefined>();
  for (const v of site.values.values()) {
    const periodSec = meta?.channels?.get(v.key)?.periodSec ?? v.periodSec;
    const period = periodSec !== undefined ? { periodSec } : {};
    if (v.speed !== undefined && !v.speedError && (v.count === undefined || v.count > 0)) {
      const spec = specOf(v.key, SPEED);
      speeds.push({
        speed: v.speed,
        ...(v.count !== undefined ? { count: v.count } : {}),
        ...(spec.vehicleClass !== undefined ? { vehicleClass: spec.vehicleClass } : {}),
      });
      channels.push({
        ...spec,
        value: v.speed,
        ...period,
        ...(v.count !== undefined ? { sampleCount: v.count } : {}),
      });
      periods.add(periodSec);
    }
    if (v.flow !== undefined && !v.flowError) {
      const spec = specOf(v.key, VOLUME);
      flows.push({
        rate: v.flow,
        ...(spec.vehicleClass !== undefined ? { vehicleClass: spec.vehicleClass } : {}),
      });
      channels.push({ ...spec, value: v.flow, ...period });
      periods.add(periodSec);
    }
    if (v.occupancy !== undefined) {
      occupancies.push(v.occupancy);
      channels.push({ ...specOf(v.key, OCCUPANCY), value: v.occupancy, ...period });
      periods.add(periodSec);
    }
  }

  const declaredChannels: ChannelSpec[] = [];
  for (const [key, declared] of meta?.channels ?? []) {
    if (declared.property !== undefined) declaredChannels.push(specOf(key, declared.property));
  }
  // A site of one stream says it all at site level; channels are kept when
  // the site table declares them or the site reports several streams.
  const keepChannels = declaredChannels.length > 0 || site.values.size > 1;
  // Every stream the document carries is a channel of the site, also one
  // whose value does not count this interval (no vehicles at night): the
  // site stays the same feature from poll to poll.
  if (keepChannels) {
    for (const v of site.values.values()) {
      for (const property of v.streams) declaredChannels.push(specOf(v.key, property));
    }
  }

  const speed = siteSpeed(speeds);
  const volume = siteVolume(flows);
  const occupancy = mean(occupancies);
  const [period] = periods.size === 1 ? [...periods] : [undefined];
  const geometry: FlowReading["geometry"] | undefined =
    site.posListCoords.length >= 2
      ? ({ type: "LineString", coordinates: site.posListCoords } satisfies LineString)
      : meta?.geometry;
  const at = site.timeDefault ?? site.obsTime;

  return measuredReading({
    site: siteId,
    geometry,
    ...(at !== undefined ? { at } : {}),
    ...(period !== undefined ? { periodSec: period } : {}),
    ...(speed !== undefined ? { speedKph: speed.speedKph } : {}),
    ...(speed?.sampleCount !== undefined ? { sampleCount: speed.sampleCount } : {}),
    ...(site.trafficStatus !== undefined ? { trafficStatus: site.trafficStatus } : {}),
    ...(site.freeFlowKph !== undefined ? { freeFlowKph: site.freeFlowKph } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(occupancy !== undefined ? { occupancy } : {}),
    ...(keepChannels && channels.length > 0 ? { channels } : {}),
    ...(declaredChannels.length > 0 ? { declaredChannels } : {}),
    ...(meta?.name !== undefined ? { name: meta.name } : {}),
    ...(meta?.nameLang !== undefined ? { nameLang: meta.nameLang } : {}),
    ...(meta?.laneCount !== undefined ? { laneCount: meta.laneCount } : {}),
    ...(meta?.equipment !== undefined ? { equipment: meta.equipment } : {}),
  });
}

/**
 * A whole DATEX II MeasuredDataPublication, read by the streaming scanner in
 * one write.
 */
export function parseDatexMeasuredData(
  input: string | Buffer,
  src: SourceDescriptor,
  sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const parser = createMeasuredDataParser(src, sites);
  parser.write(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  return parser.close();
}
