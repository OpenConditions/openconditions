import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseContext, readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { weatherDomain } from "../../domain.js";
import type { WeatherCatalogFeed } from "../../feed-schema.js";

const FEEDS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "..", "feeds");

let catalogue: Map<string, WeatherCatalogFeed> | undefined;

/** Every feed of `feeds/weather/`, disabled ones included, derived as the loader derives it. */
export function weatherCatalogue(): ReadonlyMap<string, WeatherCatalogFeed> {
  catalogue ??= new Map(
    readCatalogDir(FEEDS_DIR, [weatherDomain], { otherDomains: "ignore" }).files.flatMap((file) =>
      file.feeds.map((definition) => {
        const feed = toCatalogFeed(definition, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }) as WeatherCatalogFeed;
        return [feed.id, feed] as const;
      }),
    ),
  );
  return catalogue;
}

/** One weather feed as its region file writes it. */
export function catalogFeed(id: string): WeatherCatalogFeed {
  const feed = weatherCatalogue().get(id);
  if (feed === undefined) throw new Error(`no feed ${id} in feeds/weather`);
  return structuredClone(feed);
}

export const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name));

export const parseContext = (fetchedAt: string, cadenceSec = 300): ParseContext => ({
  fetchedAt,
  cadenceSec,
  reference: {},
});
