/**
 * The parse-local intermediate of the flow parsers: what one source record
 * says about one measurement site, before the assembler turns a poll's worth
 * of them into `measurement_site` features, `traffic.*` readings and derived
 * congestion situations. Nothing outside this package sees it.
 */
import { type DirectionRef, datexLaneToIndex } from "@openconditions/model";
import type { LineString, MultiLineString, Point } from "geojson";
import type { FlowContext, FlowSites } from "./flow-output.js";
import type { BaselineMethod } from "./model.js";
import type { SourceDescriptor } from "./types.js";

export type Los = "free_flow" | "heavy" | "queuing" | "stationary" | "blocked" | "unknown";

/** Geometry shapes a measurement site can carry. */
export type FlowGeometry = Point | LineString | MultiLineString;

export const SPEED = "traffic.speed";
export const VOLUME = "traffic.volume";
export const OCCUPANCY = "traffic.occupancy";
export const LOS = "traffic.los";
export const CLASS_SPEED = "traffic.vehicle_class_speed";

/** A stream within a site, as the site's `sensor_channel` component describes it. */
export interface ChannelSpec {
  key: string;
  property: string;
  /** The model's left-first lane index. */
  lane?: number;
  vehicleClass?: string;
  direction?: DirectionRef;
}

/** One value of one channel. */
export interface ChannelReading extends ChannelSpec {
  value: number;
  periodSec?: number;
  sampleCount?: number;
}

/** What one source record says about one site. */
export interface FlowReading {
  /** The site's source-local id; every reading of one site shares it. */
  site: string;
  /**
   * The local id of the record when the source splits one site into several
   * lines; a derived congestion situation is drafted per line.
   */
  line?: string;
  geometry: FlowGeometry;
  /** The source's time of the reading: the end of its period when it states one. */
  at?: string;
  periodSec?: number;
  speedKph?: number;
  /** Vehicles behind the speed, when the source counts them. */
  sampleCount?: number;
  /** The source's confidence in the reading, 0–1. */
  confidence?: number;
  los: Los;
  /** Set when `los` was computed from speed and free-flow speed rather than stated. */
  losDerived?: true;
  freeFlowKph?: number;
  freeFlowSource?: BaselineMethod;
  speedRatio?: number;
  /** Vehicles per hour. */
  volume?: number;
  /** Percent of the period a detector was occupied. */
  occupancy?: number;
  /** Average speed per model vehicle class. */
  classSpeeds?: Record<string, number>;
  /** The direction as the source writes it. */
  direction?: string;
  /** The direction as a model reference, when the parser knows it exactly. */
  directionRef?: DirectionRef;
  /** Values of the site's channels. */
  channels?: ChannelReading[];
  /** Channels the site declares whether or not they report this poll. */
  declaredChannels?: ChannelSpec[];
  name?: string;
  nameLang?: string;
  laneCount?: number;
  equipment?: string;
}

/** One payload of a flow feed, read. */
export interface FlowParse {
  readings: FlowReading[];
  /**
   * Set when the document could not be read at all (an unreadable body, or no
   * recognisable publication), as opposed to a well-formed document with no
   * readings this cycle. A failed parse must never read as "no readings".
   */
  failed?: boolean;
}

export type FlowParser = (
  input: string | Buffer,
  src: SourceDescriptor,
  sites: FlowSites | undefined,
  ctx: FlowContext,
) => FlowParse;

/**
 * Upper plausibility bound for a speed reading, in km/h. A reading at or
 * above it is a sensor or feed glitch, never a vehicle speed.
 */
export const ABSURD_SPEED_KPH = 250;

/** A speed a parser keeps: finite, not negative (no-data sentinels), below the glitch bound. */
export function plausibleSpeed(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v) && v >= 0 && v < ABSURD_SPEED_KPH;
}

/** The single free-flow ratio to level-of-service ladder. */
export function losFromSpeedRatio(ratio: number): Los {
  if (ratio >= 0.85) return "free_flow";
  if (ratio >= 0.5) return "heavy";
  if (ratio >= 0.15) return "queuing";
  return "stationary";
}

/** Levels of service a derived congestion situation is drafted for. */
export const QUEUING_LOS: ReadonlySet<Los> = new Set(["queuing", "stationary", "blocked"]);

/** A DATEX traffic status token (or a feed's mapping onto one) as a level of service. */
export function mapDatexTrafficStatus(raw: string | undefined): Los {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase().trim();
  if (lower === "freeflow" || lower === "free_flow" || lower === "normaltraffic")
    return "free_flow";
  if (lower === "heavy" || lower === "heavy_traffic" || lower === "slowtraffic") return "heavy";
  if (lower === "queuing" || lower === "congested") return "queuing";
  if (lower === "stationary" || lower === "standstill") return "stationary";
  if (lower === "blocked" || lower === "impossible") return "blocked";
  return "unknown";
}

/**
 * The shared level-of-service rules of a measured site: a stated status wins;
 * otherwise a speed against a free-flow speed the feed carries gives a
 * computed level. Returns null when the site has no geometry or nothing to
 * say (neither a speed nor a level, nor any other value).
 */
export function measuredReading(
  fields: Omit<FlowReading, "los" | "losDerived" | "speedRatio" | "freeFlowSource" | "geometry"> & {
    geometry: FlowGeometry | null | undefined;
    trafficStatus?: string;
  },
): FlowReading | null {
  const { trafficStatus, geometry, ...rest } = fields;
  if (!geometry) return null;
  let los = mapDatexTrafficStatus(trafficStatus);
  const { speedKph, freeFlowKph } = rest;
  const ratio =
    speedKph !== undefined && freeFlowKph !== undefined && freeFlowKph > 0
      ? speedKph / freeFlowKph
      : undefined;
  const losDerived = los === "unknown" && ratio !== undefined;
  if (losDerived) los = losFromSpeedRatio(ratio);
  const reading: FlowReading = {
    ...rest,
    geometry,
    los,
    ...(losDerived ? { losDerived: true as const } : {}),
    ...(freeFlowKph !== undefined ? { freeFlowSource: "native" as const } : {}),
    ...(ratio !== undefined ? { speedRatio: ratio } : {}),
  };
  return saysSomething(reading) ? reading : null;
}

/** A reading with any value worth drafting. */
export function saysSomething(r: FlowReading): boolean {
  return (
    r.speedKph !== undefined ||
    r.los !== "unknown" ||
    r.volume !== undefined ||
    r.occupancy !== undefined ||
    (r.classSpeeds !== undefined && Object.keys(r.classSpeeds).length > 0) ||
    (r.channels !== undefined && r.channels.length > 0)
  );
}

/**
 * Countries that drive on the left, of those whose feeds number lanes. A
 * DATEX lane counted from the verge is then already counted from the left.
 */
const LEFT_HAND_TRAFFIC = new Set(["GB", "IE", "HK", "SG", "AU", "NZ", "JP", "IN", "ZA", "MY"]);

/**
 * A source lane number as the model's left-first lane index, using the site's
 * lane count where the source counts from the verge. Undefined when it cannot
 * be converted.
 */
export function laneIndex(
  lane: number | undefined,
  src: SourceDescriptor,
  laneCount: number | undefined,
): number | undefined {
  if (lane === undefined) return undefined;
  const index = datexLaneToIndex(lane, {
    drivingSide: src.country !== undefined && LEFT_HAND_TRAFFIC.has(src.country) ? "left" : "right",
    ...(laneCount !== undefined ? { lanesTotal: laneCount } : {}),
    numbering: src.laneNumbering ?? "standard",
  });
  return index ?? undefined;
}

/** A DATEX `laneN` token as its number. */
export function datexLaneNumber(raw: string | undefined): number | undefined {
  const m = raw === undefined ? null : /^lane(\d+)$/i.exec(raw.trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * DATEX vehicle types as model vehicle classes. A type the model has no
 * class for, and a length band, stay unclassified: such a stream is neither
 * all vehicles nor a class.
 */
const DATEX_VEHICLE_CLASSES: Record<string, string> = {
  anyvehicle: "any",
  car: "car",
  van: "van",
  lorry: "truck",
  heavylorry: "hgv",
  heavygoodsvehicle: "hgv",
  articulatedvehicle: "hgv",
  bus: "bus",
  motorcycle: "motorcycle",
  moped: "moped",
  bicycle: "bicycle",
  caravan: "caravan",
  trailer: "trailer",
  agriculturalvehicle: "agricultural",
};

export function datexVehicleClass(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : DATEX_VEHICLE_CLASSES[raw.trim().toLowerCase()];
}

/** DATEX measured value types as the properties they report. */
const DATEX_VALUE_TYPES: Record<string, string> = {
  trafficspeed: SPEED,
  trafficflow: VOLUME,
  trafficconcentration: OCCUPANCY,
};

export function datexValueProperty(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : DATEX_VALUE_TYPES[raw.trim().toLowerCase()];
}

/**
 * The site speed of several speed streams: the mean weighted by the vehicles
 * behind each when every stream counts them, else the best-supported stream
 * (the most inputs, the first on a tie). Streams of all vehicles are used
 * when the site declares any; otherwise every stream.
 */
export function siteSpeed(
  samples: readonly { speed: number; count?: number; vehicleClass?: string }[],
): { speedKph: number; sampleCount?: number } | undefined {
  const any = samples.filter((s) => s.vehicleClass === "any");
  const used = any.length > 0 ? any : samples;
  if (used.length === 0) return undefined;
  if (used.every((s) => s.count !== undefined)) {
    const n = used.reduce((sum, s) => sum + s.count!, 0);
    const speedKph = used.reduce((sum, s) => sum + s.speed * s.count!, 0) / n;
    return { speedKph, sampleCount: n };
  }
  let best = used[0]!;
  for (const s of used) if ((s.count ?? 1) > (best.count ?? 1)) best = s;
  return { speedKph: best.speed };
}

/**
 * The site volume of several flow streams: the sum of the streams counting
 * all vehicles (one per lane), or of the classified ones when none counts all
 * vehicles (classes partition the traffic), or the single stream of a site
 * that has only one. Undefined when the streams cannot be told apart.
 */
export function siteVolume(
  samples: readonly { rate: number; vehicleClass?: string }[],
): number | undefined {
  const sum = (xs: readonly { rate: number }[]) => xs.reduce((s, x) => s + x.rate, 0);
  const any = samples.filter((s) => s.vehicleClass === "any");
  if (any.length > 0) return sum(any);
  if (samples.length === 1) return samples[0]!.rate;
  if (samples.length > 0 && samples.every((s) => s.vehicleClass !== undefined)) {
    return sum(samples);
  }
  return undefined;
}

/** The mean of a list, undefined when empty. */
export function mean(xs: readonly number[]): number | undefined {
  return xs.length === 0 ? undefined : xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function parseJson(input: string | Buffer): unknown {
  try {
    return JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return undefined;
  }
}
