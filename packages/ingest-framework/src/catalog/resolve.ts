import { deriveFeedId, type Region } from "./ids.js";
import { effectiveRights } from "./terms.js";
import type { CatalogFeed, FeedDefinition, Maintainer } from "./types.js";

/** Where a feed definition was written: its domain, its region file and that file's maintainers. */
export interface FeedOrigin {
  domain: string;
  region: Region;
  file: string;
  maintainers: Maintainer[];
}

/** The smallest cadence over a feed's endpoints that are not reference data. */
function dataCadenceSec(feed: FeedDefinition, id: string): number {
  const cadences = Object.values(feed.endpoints)
    .filter((endpoint) => endpoint.decoder === undefined)
    .map((endpoint) => endpoint.cadenceSec);
  if (cadences.length === 0) throw new Error(`feed ${id} has no data endpoint`);
  return Math.min(...cadences);
}

/**
 * A written feed definition as the catalogue hands it out: the id derived from
 * its region and tokens, the country of a country region, the rights its licence
 * and terms grant, its coverage (the country when unwritten) and its cadence.
 * Throws on an unknown licence or a feed whose every endpoint is reference data.
 */
export function toCatalogFeed(def: FeedDefinition, origin: FeedOrigin): CatalogFeed {
  const id = deriveFeedId({
    region: origin.region,
    subdivision: def.subdivision,
    operator: def.operator,
    qualifier: def.qualifier,
    product: def.product,
  });
  const country =
    origin.region === "eu" || origin.region === "global" ? undefined : origin.region.toUpperCase();
  const feed: CatalogFeed = {
    ...def,
    id,
    domain: origin.domain,
    region: origin.region,
    file: origin.file,
    maintainers: origin.maintainers,
    rights: effectiveRights(def.license, def.terms),
    coverage: def.coverage ?? (country ? { countries: [country] } : {}),
    cadenceSec: dataCadenceSec(def, id),
  };
  if (country) feed.country = country;
  else delete feed.country;
  return feed;
}
