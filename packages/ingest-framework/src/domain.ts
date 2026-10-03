import type { FeedSourceBase } from "./feed-source.js";
import type { ParseOutput } from "./parse-output.js";

/**
 * A domain plugin: its loaded feed instances and the parse entry for its
 * event feeds. Generalized from services/ingest's DomainPlugin so
 * transit/places reuse it.
 */
export interface IngestDomain {
  name: string;
  feeds: FeedSourceBase[];
  /** Catalogue children visible to operators but never handed to the scheduler. */
  discoveredFeeds?: FeedSourceBase[];
  /**
   * One poll of an event feed as record drafts, dated by `fetchedAt` (the
   * instant the poll fetched them); throws when a payload cannot be read.
   */
  parse(
    feed: FeedSourceBase,
    buffers: readonly Buffer[],
    opts?: { fetchedAt?: string },
  ): ParseOutput;
}

export type DomainRegistry = Record<string, IngestDomain>;
