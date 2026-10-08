import {
  type Catalog,
  type CatalogFeed,
  type EffectiveRights,
  licenseInfo,
} from "@openconditions/ingest-framework";

/** One feed the instance serves, as a consumer credits and discloses it. */
export interface Source {
  id: string;
  name: string;
  domain: string;
  product: string;
  operator: string;
  region: string;
  country?: string;
  subdivision?: string;
  accessMode: "bulk" | "on_demand";
  /** Its records are withheld from the public scope; this entry is metadata only. */
  restricted: boolean;
  /** The licence id: SPDX where SPDX lists it, else `LicenseRef-<name>`, or `NOASSERTION`. */
  license: string;
  /** The licence's readable name, from the licence registry, for showing to people. */
  licenseName?: string;
  licenseUrl?: string;
  attribution: string;
  homepage: string;
  privacyUrl: string;
  /** The terms page, when they were last reviewed, and what they condition beyond the licence. */
  terms?: { url?: string; reviewedAt?: string; note?: string };
  rights: EffectiveRights;
  /**
   * Where the feed answers: ISO 3166 codes, or the box an on-demand feed
   * covers (a global one covers the world). Absent for a feed that names
   * neither, such as an `eu` feed without written coverage.
   */
  coverage?: { countries?: string[]; bbox?: [number, number, number, number] };
  /**
   * The hosts the feed's camera stills are fetched from, as its `cameras`
   * block declares them: an exact host, `*.domain`, or `host/path/`. A
   * consumer's image proxy admits exactly these for the feed's images.
   */
  imageHosts?: string[];
}

/**
 * The image hosts a feed's `cameras` block declares, read from the
 * catalogue entry as written: the block belongs to the cameras domain's feed
 * shape, which this generic listing does not import.
 */
function imageHostsOf(feed: CatalogFeed): string[] | undefined {
  const block = (feed as CatalogFeed & { cameras?: { imageHosts?: unknown } }).cameras;
  const hosts = block?.imageHosts;
  return Array.isArray(hosts) && hosts.every((h) => typeof h === "string")
    ? [...(hosts as string[])]
    : undefined;
}

function sourceOf(feed: CatalogFeed): Source {
  const imageHosts = imageHostsOf(feed);
  const licenseName = licenseInfo(feed.license)?.name;
  const terms = {
    ...(feed.terms?.url ? { url: feed.terms.url } : {}),
    ...(feed.terms?.reviewedAt ? { reviewedAt: feed.terms.reviewedAt } : {}),
    ...(feed.terms?.note ? { note: feed.terms.note } : {}),
  };
  return {
    id: feed.id,
    name: feed.name,
    domain: feed.domain,
    product: feed.product,
    operator: feed.operator,
    region: feed.region,
    ...(feed.country ? { country: feed.country } : {}),
    ...(feed.subdivision ? { subdivision: feed.subdivision } : {}),
    accessMode: feed.accessMode ?? "bulk",
    restricted: feed.restricted,
    license: feed.license,
    ...(licenseName ? { licenseName } : {}),
    ...(feed.licenseUrl ? { licenseUrl: feed.licenseUrl } : {}),
    attribution: feed.attribution,
    homepage: feed.homepage,
    privacyUrl: feed.privacyUrl,
    ...(Object.keys(terms).length > 0 ? { terms } : {}),
    rights: feed.rights,
    ...(feed.coverage.countries === undefined && feed.coverage.bbox === undefined
      ? {}
      : {
          coverage: {
            ...(feed.coverage.countries ? { countries: [...feed.coverage.countries] } : {}),
            ...(feed.coverage.bbox ? { bbox: feed.coverage.bbox } : {}),
          },
        }),
    ...(imageHosts === undefined ? {} : { imageHosts }),
  };
}

/**
 * The feeds the instance serves, sorted by id: the enabled feeds of the
 * catalogue, scheduled and on demand. A catalogue's children are credited
 * through their parent and left out.
 */
export function sourcesOf(catalog: Pick<Catalog, "sources">): Source[] {
  return catalog.sources
    .filter((feed) => feed.parentSourceId === undefined && feed.disabled === undefined)
    .map(sourceOf)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
