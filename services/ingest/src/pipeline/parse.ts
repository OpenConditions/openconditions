import type { CatalogFeed, ParseOutput } from "@openconditions/ingest-framework";
import { formatOf } from "../domains.js";

/**
 * One archived or freshly fetched snapshot of a feed's main endpoint as
 * record drafts, through the feed's format, with no reference data. Every
 * payload is one snapshot. Throws when a payload cannot be read; drafts are
 * dated by `fetchedAt`, the instant the payloads were fetched.
 */
export function parseMainPayloads(
  feed: CatalogFeed,
  buffers: readonly Buffer[],
  fetchedAt: string,
): ParseOutput {
  return formatOf(feed).parse(
    feed,
    { main: buffers },
    { fetchedAt, cadenceSec: feed.cadenceSec, reference: {} },
  );
}
