import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseContext, readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { vehiclesDomain } from "../../domain.js";
import type { VehiclesCatalogFeed } from "../../feed-schema.js";

export const FEEDS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "..", "feeds");

let catalogue: Map<string, VehiclesCatalogFeed> | undefined;

/** Every feed of `feeds/vehicles/`, disabled ones included, derived as the loader derives it. */
export function vehiclesCatalogue(): ReadonlyMap<string, VehiclesCatalogFeed> {
  catalogue ??= new Map(
    readCatalogDir(FEEDS_DIR, [vehiclesDomain], { otherDomains: "ignore" }).files.flatMap((file) =>
      file.feeds.map((definition) => {
        const feed = toCatalogFeed(definition, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }) as VehiclesCatalogFeed;
        return [feed.id, feed] as const;
      }),
    ),
  );
  return catalogue;
}

/** One vehicles feed as its region file writes it. */
export function catalogFeed(id: string): VehiclesCatalogFeed {
  const feed = vehiclesCatalogue().get(id);
  if (feed === undefined) throw new Error(`no feed ${id} in feeds/vehicles`);
  return structuredClone(feed);
}

export const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name));

export const parseContext = (fetchedAt: string, cadenceSec = 60): ParseContext => ({
  fetchedAt,
  cadenceSec,
  reference: {},
});
