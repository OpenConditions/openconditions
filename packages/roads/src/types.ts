import type { GeoJsonMapping } from "./model.js";

/**
 * Field mapping for the generic GeoJSON flow parser. Drives one parser across
 * every `FeatureCollection` traffic feed (OpenDataSoft exports for Rennes /
 * Bordeaux, Azure-APIM GeoJSON for Victoria, …) whose features carry a
 * per-segment average speed and/or a categorical traffic status in flat
 * `properties`. Only `idField` is required; a feed supplies whichever of the
 * value fields it publishes.
 */
export interface GeojsonFlowMapping {
  /** Stable per-record id, e.g. "predefinedlocationreference" or "ident". */
  idField: string;
  /** Average vehicle speed in km/h, when the feed measures one. */
  speedField?: string;
  /** Native free-flow / posted-max speed in km/h, when present. */
  freeFlowField?: string;
  /** Categorical traffic-status field (e.g. "trafficstatus", "etat"). */
  statusField?: string;
  /**
   * Maps raw status values to a canonical DATEX status token
   * (freeFlow | heavy | slowTraffic | congested | queuing | stationary | blocked).
   * Omit when the feed already emits DATEX tokens (e.g. Rennes "freeFlow").
   */
  statusMap?: Record<string, string>;
  /** Measurement timestamp field, when the feed carries one per record. */
  updatedField?: string;
}

/**
 * Minimal descriptor for the data source a parser needs at call time.
 * Subset of the full FeedSource; keeps parsers decoupled from the ingest layer.
 */
export interface SourceDescriptor {
  id: string;
  attribution: string;
  country: string;
  license: string;
  licenseUrl?: string;
  /** Field mapping for the generic GeoJSON parser (only set for geojson feeds). */
  geojson?: GeoJsonMapping;
  /** Field mapping for the GeoJSON flow parser (only set for geojson-flow feeds). */
  flowMap?: GeojsonFlowMapping;
  /**
   * The DATEX feed publishes GML `posList` coordinates in "lon lat" order rather
   * than the WGS84/DATEX "lat lon" default (e.g. Trafikverket). Only affects
   * `posList`/`pos`; elements with explicit latitude/longitude leaves are
   * unaffected.
   */
  posListLonLat?: boolean;
}
