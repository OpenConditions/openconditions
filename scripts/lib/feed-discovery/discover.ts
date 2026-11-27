import { acquire, CATALOGS, isMetadataRequestUrl } from "./acquire.js";
import { readInventory } from "./inventory.js";
import type { CatalogId, CatalogResult, Distribution, InventoryFeed, Report } from "./model.js";
import { redactUrl } from "./normalize.js";
import { buildReport } from "./rank.js";

export interface DiscoverOptions {
  catalogs?: CatalogId[];
  /** Inject a metadata response transport for offline fixtures. No metadata-derived requests occur. */
  fetchFn?: typeof fetch;
  clock?: () => Date;
  inventory?: InventoryFeed[];
  feedsDir?: string;
}
export async function discoverFeeds(options: DiscoverOptions = {}): Promise<Report> {
  const inventory = options.inventory ?? (await readInventory(options.feedsDir));
  const catalogs = options.catalogs ?? (Object.keys(CATALOGS) as CatalogId[]);
  if (
    new Set(catalogs).size !== catalogs.length ||
    catalogs.some((id) => !Object.hasOwn(CATALOGS, id))
  )
    throw new Error("invalid_catalog");
  const generatedAt = (options.clock ?? (() => new Date()))();
  const results: CatalogResult[] = [],
    distributions: Distribution[] = [];
  for (const catalog of catalogs) {
    const acquired = await acquire(catalog, options.fetchFn);
    results.push({
      ...acquired.result,
      metadataUrls: acquired.result.metadataUrls.map((url) =>
        isMetadataRequestUrl(url) ? url : redactUrl(url),
      ),
    });
    distributions.push(...acquired.distributions);
  }
  const report = buildReport(distributions, inventory, generatedAt);
  report.catalogs = results;
  report.complete = results.every((result) => result.complete);
  return report;
}
