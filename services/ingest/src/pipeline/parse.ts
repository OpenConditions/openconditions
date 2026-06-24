import type { Observation } from "@openconditions/core";
import type { FeedSource } from "@openconditions/roads";
import { flowParserFor } from "@openconditions/roads";
import { feedToSourceDescriptor } from "../domains.js";
import { DOMAIN_REGISTRY } from "../domains.js";

/**
 * Dispatches a single buffer to the correct domain parser based on
 * `src.domain` (looked up in the registry) and `src.format`.
 *
 * When `src.produces === "flow"` the feed is routed to the matching flow
 * parser (e.g. parseDigitrafficFlow or parseDatexMeasuredData). Both the
 * RoadFlow measurements and the derived congestion RoadEvents returned by the
 * flow parser are flattened into a single Observation[] so the rest of the
 * pipeline treats them uniformly.
 *
 * Returns the parsed observations (typed as `Observation[]` for
 * domain-agnostic pipeline use; domain-specific callers may narrow further).
 */
export function parseFor(src: FeedSource & { domain: string }, buf: Buffer): Observation[] {
  const plugin = DOMAIN_REGISTRY[src.domain];
  if (!plugin) {
    throw new Error(`No domain plugin registered for domain: ${src.domain}`);
  }

  if (src.produces === "flow") {
    const flowParserFn = flowParserFor(src.format);
    const descriptor = feedToSourceDescriptor(src);
    const { flows, events } = flowParserFn(buf, descriptor);
    return [...flows, ...events] as Observation[];
  }

  const parserFn = plugin.parserFor(src.format);
  const descriptor = feedToSourceDescriptor(src);
  return parserFn(buf, descriptor) as Observation[];
}
