import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseContext, readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { borderDomain } from "../../domain.js";
import type { BorderCatalogFeed } from "../../feed-schema.js";

const FEEDS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "..", "feeds");

let catalogue: Map<string, BorderCatalogFeed> | undefined;

/** Every feed of `feeds/border/`, derived as the loader derives it. */
export function borderCatalogue(): ReadonlyMap<string, BorderCatalogFeed> {
  catalogue ??= new Map(
    readCatalogDir(FEEDS_DIR, [borderDomain], { otherDomains: "ignore" }).files.flatMap((file) =>
      file.feeds.map((definition) => {
        const feed = toCatalogFeed(definition, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        });
        return [feed.id, feed] as const;
      }),
    ),
  );
  return catalogue;
}

/** One border feed as its region file writes it. */
export function catalogFeed(id: string): BorderCatalogFeed {
  const feed = borderCatalogue().get(id);
  if (feed === undefined) throw new Error(`no feed ${id} in feeds/border`);
  return structuredClone(feed);
}

export const cbpFeed = (): BorderCatalogFeed => catalogFeed("us-cbp-waits");
export const cbsaFeed = (): BorderCatalogFeed => catalogFeed("ca-cbsa-waits");

export const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name));

export const parseContext = (fetchedAt: string): ParseContext => ({
  fetchedAt,
  cadenceSec: 900,
  reference: {},
});
