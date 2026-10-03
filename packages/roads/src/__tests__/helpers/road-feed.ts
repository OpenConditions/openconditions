import { toCatalogFeed } from "@openconditions/ingest-framework";
import type { RoadFeed } from "../../feed-schema.js";

const DEFINITION = {
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
} as const;

/**
 * A loaded roads feed for tests: the given fields over a minimal definition,
 * with everything derived as the catalogue loader derives it. A derived field
 * given in `partial` (`id`, `rights`, …) wins over the derived value, so a test
 * can keep a source id its golden files name.
 */
export function roadFeed(partial: Partial<RoadFeed> = {}): RoadFeed {
  const derived = toCatalogFeed(
    { ...DEFINITION, ...partial },
    {
      domain: "roads",
      region: partial.region ?? "xx",
      file: partial.file ?? `feeds/roads/${partial.region ?? "xx"}.jsonc`,
      maintainers: partial.maintainers ?? [],
    },
  );
  return { ...derived, ...partial } as RoadFeed;
}
