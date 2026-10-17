import { type Catalog, resolveAttribution } from "@openconditions/ingest-framework";
import type { SourceEntry } from "@openconditions/storage";

/**
 * Scheduled sources plus the parents their captured display credits name.
 * An attribution's `{year}` is the year of `at`, the boot that syncs them:
 * the stored credit is only the fallback of a reading that carries none.
 */
export function catalogueSources(catalog: Catalog, at: Date = new Date()): SourceEntry[] {
  const sources = new Map(catalog.feeds.map((feed) => [feed.id, feed]));
  const parents = new Map(catalog.sources.map((feed) => [feed.id, feed]));
  for (const feed of sources.values()) {
    const parent = feed.parentSourceId ? parents.get(feed.parentSourceId) : undefined;
    if (parent) sources.set(parent.id, parent);
  }
  const scheduled = new Set(catalog.feeds.map((feed) => feed.id));
  return [...sources.values()].map((feed) => ({
    ...feed,
    attribution: resolveAttribution(feed.attribution, at),
    active: scheduled.has(feed.id),
  }));
}
