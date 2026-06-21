import {
  FEED_SOURCES,
  parserFor,
  feedToSourceDescriptor,
  roadAttributes,
} from "@openconditions/roads";
import type { FeedSource } from "@openconditions/roads";
import type { RoadEvent } from "@openconditions/roads";
import type { Observation } from "@openconditions/core";

/**
 * A domain plugin bundles together a set of feed sources, the parser dispatch
 * function, and the domain-specific attributes mapper. New domains (transit,
 * places) are added here once their packages are ready.
 */
export interface DomainPlugin {
  /** Feed sources registered for this domain. */
  feeds: FeedSource[];
  /** Returns the parser function for a given source format. */
  parserFor: typeof parserFor;
  /** Maps a domain-specific observation to the attributes JSONB payload. */
  attributes: (obs: Observation) => Record<string, unknown>;
}

/**
 * Registry of all active domain plugins keyed by domain name.
 * The ingest scheduler iterates over all registered domains to schedule jobs.
 */
export const DOMAIN_REGISTRY: Record<string, DomainPlugin> = {
  roads: {
    feeds: FEED_SOURCES,
    parserFor,
    attributes: (obs) => roadAttributes(obs as RoadEvent),
  },
};

export { feedToSourceDescriptor };
