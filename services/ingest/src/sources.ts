import type { Catalog } from "@openconditions/ingest-framework";
import type { SourceEntry } from "@openconditions/storage";

/** Scheduled sources plus the parents their captured display credits name. */
export function catalogueSources(catalog: Catalog): SourceEntry[] {
  const sources = new Map(catalog.feeds.map((feed) => [feed.id, feed]));
  const parents = new Map(catalog.sources.map((feed) => [feed.id, feed]));
  for (const feed of sources.values()) {
    const parent = feed.parentSourceId ? parents.get(feed.parentSourceId) : undefined;
    if (parent) sources.set(parent.id, parent);
  }
  const scheduled = new Set(catalog.feeds.map((feed) => feed.id));
  return [...sources.values()].map((feed) => ({ ...feed, active: scheduled.has(feed.id) }));
}
