import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseContext, readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { chargingDomain } from "../../domain.js";
import type { ChargingCatalogFeed } from "../../feed-schema.js";

const FEEDS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "..", "feeds");

let catalogue: Map<string, ChargingCatalogFeed> | undefined;

/**
 * Every feed of `feeds/charging/`, disabled ones included, derived as the
 * loader derives it. The parser tests read their feeds from here, so a
 * mapping the tests pass is the mapping the catalogue ships.
 */
export function chargingCatalogue(): ReadonlyMap<string, ChargingCatalogFeed> {
  catalogue ??= new Map(
    readCatalogDir(FEEDS_DIR, [chargingDomain], { otherDomains: "ignore" }).files.flatMap((file) =>
      file.feeds.map((definition) => {
        const feed = toCatalogFeed(definition, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }) as ChargingCatalogFeed;
        return [feed.id, feed] as const;
      }),
    ),
  );
  return catalogue;
}

/** One charging feed as its region file writes it. */
export function catalogFeed(id: string): ChargingCatalogFeed {
  const feed = chargingCatalogue().get(id);
  if (feed === undefined) throw new Error(`no feed ${id} in feeds/charging`);
  return structuredClone(feed);
}

/** Flanders' public charge points, the MOW WFS, one row per charge point. */
export const flandersFeed = () => catalogFeed("be-vlg-mow-charging");
/** Wallonia's charging infrastructure, a Lambert 72 CSV, one row per connector. */
export const walloniaFeed = () => catalogFeed("be-wal-spw-charging");
/** Hong Kong's public chargers, counts by standard per car park. */
export const hongKongFeed = () => catalogFeed("hk-epd-charging");
/** Transport for NSW's charging locations, a CSV of rating groups. */
export const nswFeed = () => catalogFeed("au-nsw-tfnsw-charging");
/** Victoria's government-funded chargers, a WFS with plug lists. */
export const victoriaFeed = () => catalogFeed("au-vic-deeca-charging");

export const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name));

const PACKAGES = join(import.meta.dirname, "..", "..", "..", "..");

/** A capture of the OCPI decoders' fixtures, read where that package keeps it. */
export const ocpiFixture = (name: string): Buffer =>
  readFileSync(join(PACKAGES, "ocpi", "src", "__tests__", "fixtures", name));

/** A capture of the DATEX II decoders' fixtures, read where that package keeps it. */
export const datexFixture = (name: string): Buffer =>
  readFileSync(join(PACKAGES, "datex2", "src", "__tests__", "fixtures", name));

export const parseContext = (fetchedAt: string, cadenceSec = 300): ParseContext => ({
  fetchedAt,
  cadenceSec,
  reference: {},
});
