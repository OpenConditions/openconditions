import { type CatalogFeed, feedBaseShape } from "@openconditions/ingest-framework";
import { z } from "zod";

/**
 * Raw per-field shape of a hazards feed, including the RFS bounded-publication qualification gate.
 * Formats read fixed publisher shapes rather than configurable mappings.
 */
export const hazardsFeedShape = {
  ...feedBaseShape,
  rfsCurrentSnapshotQualified: z
    .boolean()
    .optional()
    .describe(
      "Enable qualified RFS incident/text/anchor publication with finite source expiry; never grants absence-based withdrawal",
    ),
} as const;

/** A loaded hazards feed. */
export type HazardsCatalogFeed = CatalogFeed & { rfsCurrentSnapshotQualified?: boolean };
