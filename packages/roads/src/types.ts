import type { GeoJsonMapping } from "./model.js";

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
}
