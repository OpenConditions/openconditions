/**
 * Catalogue feeds for the ingest suites: the repo catalogue as the service
 * loads it, and minimal feeds resolved the way the loader resolves them.
 */
import {
  type CatalogFeed,
  type FeedDefinition,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { loadIngestCatalog } from "../../domains.js";

/** The repo catalogue, with no operator mount and no remote layer. */
export const REPO_CATALOG = await loadIngestCatalog({});

/** A feed of the repo catalogue by id; throws when there is none. */
export function repoFeed(id: string): CatalogFeed {
  const feed = [...REPO_CATALOG.feeds, ...REPO_CATALOG.discovered, ...REPO_CATALOG.disabled].find(
    (f) => f.id === id,
  );
  if (!feed) throw new Error(`no feed ${id} in the repo catalogue`);
  return feed;
}

const DEFINITION: FeedDefinition = {
  operator: "test",
  product: "events",
  name: "Test feed",
  format: "datex2",
  tier: "authoritative",
  endpoints: { main: { url: "https://example.test/feed", cadenceSec: 300 } },
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "test",
  privacyUrl: "https://example.test/privacy",
};

/**
 * A roads feed resolved as the loader resolves one, from the given fields over
 * a minimal definition. A derived field given in `over` (`id`, `rights`, …)
 * wins over the derived value, so a test can name the source its records carry.
 */
export function testFeed(over: Partial<CatalogFeed> & Record<string, unknown> = {}): CatalogFeed {
  const derived = toCatalogFeed({ ...DEFINITION, ...over } as FeedDefinition, {
    domain: "roads",
    region: "lu",
    file: "feeds/roads/lu.jsonc",
    maintainers: [],
  });
  return { ...derived, ...over } as CatalogFeed;
}
