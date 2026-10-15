import { type CatalogFeed, feedBaseShape } from "@openconditions/ingest-framework";

/**
 * Raw per-field shape of a vehicles feed: the base shape alone. Every
 * vehicles format reads a fixed publisher shape, so a feed needs no mapping
 * block.
 */
export const vehiclesFeedShape = { ...feedBaseShape } as const;

/** A loaded vehicles feed. */
export type VehiclesCatalogFeed = CatalogFeed;
