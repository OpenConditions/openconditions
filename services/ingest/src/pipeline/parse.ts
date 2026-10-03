import type { ParseOutput } from "@openconditions/ingest-framework";
import {
  type FeedSource,
  type FlowContext,
  type FlowOutput,
  type FlowSites,
  parseFlows,
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
 * One poll of a flow feed: the measurement sites, readings and derived
 * congestion situations of every payload. `sites` is the feed's site table or
 * station registry, for sites a payload names only by id. A hard parse
 * failure throws, so it can never read as "no readings this cycle".
 */
export function parseFlowFeed(
  src: FeedSource,
  buffers: readonly Buffer[],
  sites: FlowSites | undefined,
  ctx: FlowContext,
): FlowOutput {
  const out: FlowOutput = { features: [], observations: [], situations: [] };
  for (const buffer of buffers) {
    const parsed = parseFlows(src, buffer, sites, ctx);
    out.features.push(...parsed.features);
    out.observations.push(...parsed.observations);
    out.situations.push(...parsed.situations);
  }
  return out;
}
