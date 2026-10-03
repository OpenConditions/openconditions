import { fileURLToPath } from "node:url";
import { defineIngestDomain, type FeedFormat, type IngestDomain } from "../../catalog/domain.js";
import type { CatalogResolver } from "../../catalog/resolvers.js";
import { feedBaseShape } from "../../catalog/schema.js";
import { emptyParseOutput } from "../../parse-output.js";

const datex2 = (products: string[]): FeedFormat => ({
  id: "datex2",
  kind: "situations",
  products,
  endpoints: {
    main: { required: true },
    sites: { required: false, decoders: ["datex2-sites"] },
  },
  parse: () => emptyParseOutput(),
});

/** A roads-shaped domain for catalogue tests: three products, one format. */
export function testDomainWith(resolvers: readonly CatalogResolver[] = []): IngestDomain {
  return defineIngestDomain({
    id: "roads",
    products: ["events", "conditions", "flow"],
    feedShape: feedBaseShape,
    formats: { datex2: datex2(["events", "flow"]) },
    resolvers,
  });
}

export const testDomain = testDomainWith();

/** A second domain, to show ids are unique across domains. */
export const otherDomain = defineIngestDomain({
  id: "other",
  products: ["events"],
  feedShape: feedBaseShape,
  formats: { datex2: datex2(["events"]) },
  resolvers: [],
});

/** A fixture tree under `__tests__/fixtures/catalog/`. */
export function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/catalog/${name}`, import.meta.url));
}
