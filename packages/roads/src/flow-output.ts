import type { LineString, MultiLineString, Point } from "geojson";

/** What a site table or station registry says about one measured stream of a site. */
export interface FlowChannel {
  /**
   * The lane the stream measures, numbered as the source numbers it (DATEX
   * `laneN`); parsers convert it to the model's left-first index.
   */
  lane?: number;
  /** The model vehicle class the stream counts, or `any` for every vehicle. */
  vehicleClass?: string;
  /** The measurement period, in seconds. */
  periodSec?: number;
  /** The registered property the stream reports. */
  property?: string;
}

/** Site metadata a site table or station registry provides, by the source's site id. */
export interface FlowSite {
  geometry: Point | LineString | MultiLineString;
  name?: string;
  /** The language of `name`, when the table states it. */
  nameLang?: string;
  /** Lanes of the carriageway the site measures (for DATEX lane conversion). */
  laneCount?: number;
  /** The detector technology, as a `measurement_site` equipment value. */
  equipment?: string;
  /**
   * The lane a lane-level site stands for, numbered as the source numbers it
   * (a DATEX predefined location of one lane).
   */
  lane?: number;
  /** Per measured-value index (DATEX `measuredValue@index`) or per lane/detector key the source uses. */
  channels?: ReadonlyMap<string, FlowChannel>;
}

export type FlowSites = ReadonlyMap<string, FlowSite>;

/** The poll a flow payload belongs to. */
export interface FlowContext {
  /** When the poll fetched the payload (ISO instant). */
  now: string;
  /** The feed's polling cadence; readings without a source time are dated by the poll, floored to it. */
  cadenceSec: number;
}

/** What one flow poll yields. */
export interface FlowOutput {
  /** `measurement_site` drafts, with `sensor_channel` components where lanes or classes exist. */
  features: Record<string, unknown>[];
  /** `traffic.*` observation drafts. */
  observations: Record<string, unknown>[];
  /** Congestion situation drafts derived from the readings' levels of service. */
  situations: Record<string, unknown>[];
}

/** A stored free-flow speed of a site, and how it was obtained. */
export interface FlowBaseline {
  freeFlowKph: number;
  method: "native" | "derived" | "osm_maxspeed";
}
