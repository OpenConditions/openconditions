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
}
