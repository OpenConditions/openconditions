import { type CatalogFeed, feedBaseShape } from "@openconditions/ingest-framework";

/**
 * Raw per-field shape of a hazards feed: the base shape alone. Every hazards
 * format reads a fixed publisher shape, so a feed needs no mapping block.
 */
export const hazardsFeedShape = { ...feedBaseShape } as const;

/** A loaded hazards feed. */
export type HazardsCatalogFeed = CatalogFeed;
