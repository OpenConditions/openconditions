import { type CatalogFeed, feedBaseShape } from "@openconditions/ingest-framework";

/**
 * Raw per-field shape of a weather feed: the base shape alone. Every weather
 * format reads a fixed publisher shape, so a feed needs no mapping block.
 */
export const weatherFeedShape = { ...feedBaseShape } as const;

/** A loaded weather feed. */
export type WeatherCatalogFeed = CatalogFeed;
