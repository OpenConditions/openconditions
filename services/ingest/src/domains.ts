import {
  FEED_SOURCES,
  parserFor,
  flowParserFor,
  feedToSourceDescriptor,
  roadAttributes,
  roadFlowAttributes,
} from "@openconditions/roads";
import type { RoadEvent, RoadFlow } from "@openconditions/roads";
import type { Observation } from "@openconditions/core";
import type { DomainRegistry, IngestDomain } from "@openconditions/ingest-framework";

const roads: IngestDomain = {
  name: "roads",
  // Roads' FeedSource intersects FeedSourceBase with road-specific mapping
  // fields (see packages/roads/src/feeds.ts), so it is not a strict structural
  // subtype of the generic FeedSourceBase[] the registry declares. The runtime
  // values are the same objects the roads pipeline consumes directly.
  feeds: FEED_SOURCES as unknown as IngestDomain["feeds"],
  parserFor: parserFor as IngestDomain["parserFor"],
  flowParserFor: flowParserFor as IngestDomain["flowParserFor"],
  attributes: (obs: Observation) =>
    obs.kind === "measurement"
      ? roadFlowAttributes(obs as RoadFlow)
      : roadAttributes(obs as RoadEvent),
};

/**
 * Registry of all active domain plugins keyed by domain name.
 * The ingest scheduler iterates over all registered domains to schedule jobs.
 */
export const DOMAIN_REGISTRY: DomainRegistry = { roads };

export { feedToSourceDescriptor };
