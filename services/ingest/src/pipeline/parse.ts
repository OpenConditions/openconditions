import type { Observation } from "@openconditions/core";
import type { FeedSource } from "@openconditions/roads";
import { feedToSourceDescriptor } from "../domains.js";
import { DOMAIN_REGISTRY } from "../domains.js";

/**
 * Dispatches a single buffer to the correct domain parser based on
 * `src.domain` (looked up in the registry) and `src.format`.
 * Returns the parsed observations (typed as `Observation[]` for
 * domain-agnostic pipeline use; domain-specific callers may narrow further).
 */
export function parseFor(src: FeedSource & { domain: string }, buf: Buffer): Observation[] {
  const plugin = DOMAIN_REGISTRY[src.domain];
  if (!plugin) {
    throw new Error(`No domain plugin registered for domain: ${src.domain}`);
  }

  const parserFn = plugin.parserFor(src.format);
  const descriptor = feedToSourceDescriptor(src);
  return parserFn(buf, descriptor) as Observation[];
}
