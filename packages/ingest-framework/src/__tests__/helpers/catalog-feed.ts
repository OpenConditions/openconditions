import { toCatalogFeed } from "../../catalog/resolve.js";
import type { CatalogFeed, FeedDefinition } from "../../catalog/types.js";

const DEFINITION: FeedDefinition = {
  operator: "test",
  product: "events",
  name: "Test feed",
  format: "test",
  tier: "authoritative",
  endpoints: { main: { url: "https://example.test/feed", cadenceSec: 300 } },
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "test",
  privacyUrl: "https://example.test/privacy",
};

/**
 * A loaded feed for tests: the given fields over a minimal definition, with
 * everything derived as the loader derives it. A derived field given in
 * `partial` (`id`, `rights`, …) wins over the derived value.
 */
export function catalogFeed(partial: Partial<CatalogFeed> = {}): CatalogFeed {
  const derived = toCatalogFeed(
    { ...DEFINITION, ...partial },
    {
      domain: partial.domain ?? "test",
      region: partial.region ?? "xx",
      file: partial.file ?? "feeds/test/xx.jsonc",
      maintainers: partial.maintainers ?? [],
    },
  );
  return { ...derived, ...partial };
}
