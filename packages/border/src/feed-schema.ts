import { type CatalogFeed, feedBaseShape } from "@openconditions/ingest-framework";

/**
 * Raw per-field shape of a border feed: the base shape alone. Each border
 * format reads its agency's fixed publication, so a feed needs no mapping
 * block.
 */
export const borderFeedShape = { ...feedBaseShape } as const;

/** A loaded border feed. */
export type BorderCatalogFeed = CatalogFeed;
