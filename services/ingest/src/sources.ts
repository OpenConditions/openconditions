import type { DomainRegistry } from "@openconditions/ingest-framework";
import type { SourceEntry } from "@openconditions/storage";

/** Every source the scheduler polls, tagged with its domain, as `conditions.source` holds it. */
export function catalogueSources(registry: DomainRegistry): SourceEntry[] {
  return Object.entries(registry).flatMap(([domain, plugin]) =>
    plugin.feeds.map((feed) => ({ ...feed, domain })),
  );
}
