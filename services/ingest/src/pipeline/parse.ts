import type { ParseOutput } from "@openconditions/ingest-framework";
import {
  type FeedSource,
  type FlowParse,
  parseFlows,
  type SiteGeometry,
} from "@openconditions/roads";
import { DOMAIN_REGISTRY } from "../domains.js";

/**
 * One poll of an event feed as record drafts, through its domain's parse
 * entry. Every payload of the poll is one snapshot. Throws when a payload
 * cannot be read, or a complete snapshot cannot be accounted for; the caller
 * then keeps the last good publication. Drafts are dated by `fetchedAt`, the
 * instant the poll fetched the payloads.
 */
export function parseEventFeed(
  src: FeedSource & { domain: string },
  buffers: readonly Buffer[],
  opts: { fetchedAt?: string } = {},
): ParseOutput {
  const plugin = DOMAIN_REGISTRY[src.domain];
  if (!plugin) throw new Error(`No domain plugin registered for domain: ${src.domain}`);
  return plugin.parse(src, buffers, opts);
}

/**
 * One poll of a flow feed: the readings of every payload and the congestion
 * situations derived from them. `siteMap` gives sites keyed only by id their
 * geometry (the NDW site-table join). A hard parse failure throws, so it can
 * never read as "no readings this cycle".
 */
export function parseFlowFeed(
  src: FeedSource,
  buffers: readonly Buffer[],
  siteMap?: Map<string, SiteGeometry>,
): FlowParse {
  const out: FlowParse = { flows: [], situations: [] };
  for (const buffer of buffers) {
    const parsed = parseFlows(src, buffer, siteMap);
    out.flows.push(...parsed.flows);
    out.situations.push(...parsed.situations);
  }
  return out;
}
