import { type CatalogFeed, feedBaseShape } from "@openconditions/ingest-framework";
import { z } from "zod";

/**
 * Raw per-field shape of a hazards feed, including the RFS qualification gate.
 * Formats read fixed publisher shapes rather than configurable mappings.
 */
export const hazardsFeedShape = {
  ...feedBaseShape,
  rfsCurrentSnapshotQualified: z
    .boolean()
    .optional()
    .describe(
      "Enable only after independently qualifying the RFS complete current snapshot contract, including empty/withdrawal behavior",
    ),
} as const;

/** A loaded hazards feed. */
export type HazardsCatalogFeed = CatalogFeed & { rfsCurrentSnapshotQualified?: boolean };
