import type { Observation } from "@openconditions/core";
import type { FeedSourceBase } from "./feed-source.js";
import type { ParseOutput } from "./parse-output.js";

/**
 * A domain plugin: its loaded feed instances, the parse entry for its event
 * feeds, and the mapper from a domain measurement to the JSONB attributes
 * column. Generalized from services/ingest's DomainPlugin so transit/places reuse it.
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
  attributes(obs: Observation): Record<string, unknown>;
}

export type DomainRegistry = Record<string, IngestDomain>;
