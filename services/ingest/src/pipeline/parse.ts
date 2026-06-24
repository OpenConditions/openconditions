import type { Observation } from "@openconditions/core";
import type { FeedSource, SiteGeometry, UnresolvedRoadEvent } from "@openconditions/roads";
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
 * flow parser are flattened so the rest of the pipeline treats them uniformly.
 * `siteMap`, when supplied, gives the flow parser external geometry keyed by
 * measurement-site id (the NDW site-table join).
 *
 * The return type is `(Observation | UnresolvedRoadEvent)[]` because some
 * parsers (currently datex2) emit OpenLR-only records without geometry. These
 * are narrowed to real Observation (geometry guaranteed) by resolveOpenLr
 * before reaching write-postgis.
 */
export function parseFor(
  src: FeedSource & { domain: string },
  buf: Buffer,
  siteMap?: Map<string, SiteGeometry>
): (Observation | UnresolvedRoadEvent)[] {
  const plugin = DOMAIN_REGISTRY[src.domain];
  if (!plugin) {
    throw new Error(`No domain plugin registered for domain: ${src.domain}`);
  }

  if (src.produces === "flow") {
    const flowParserFn = flowParserFor(src.format);
    const descriptor = feedToSourceDescriptor(src);
    const { flows, events } = flowParserFn(buf, descriptor, siteMap);
    return [...flows, ...events] as Observation[];
  }

  const parserFn = plugin.parserFor(src.format);
  const descriptor = feedToSourceDescriptor(src);
  return parserFn(buf, descriptor) as (Observation | UnresolvedRoadEvent)[];
}
