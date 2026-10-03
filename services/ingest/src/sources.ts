import type { Catalog } from "@openconditions/ingest-framework";
import type { SourceEntry } from "@openconditions/storage";

/** Every source the scheduler polls, as `conditions.source` holds it. */
export function catalogueSources(catalog: Catalog): SourceEntry[] {
  return catalog.feeds.map((feed) => ({ ...feed }));
}
