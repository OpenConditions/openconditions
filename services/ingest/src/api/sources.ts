import {
  type Catalog,
  type CatalogFeed,
  type CrowdCredit,
  captureLicensing,
  type EffectiveRights,
  effectiveRights,
  resolveAttribution,
} from "@openconditions/ingest-framework";

/** One feed the instance serves, as a consumer credits and discloses it. */
export interface Source {
  id: string;
  name: string;
  domain: string;
  product: string;
  /** The source format its parser reads, such as `cap` or `firms`. */
  format: string;
  /** What sets the feed apart from the publisher's other feeds of the same product, such as `firms-viirs`. */
  qualifier?: string;
  operator: string;
  region: string;
  country?: string;
  subdivision?: string;
  accessMode: "bulk" | "on_demand";
  /** Its records are withheld from the public scope; this entry is metadata only. */
  restricted: boolean;
  /** The licence id: SPDX where SPDX lists it, else `LicenseRef-<name>`, or `NOASSERTION`. */
  license: string;
  /** Captured source-scoped display definitions; `license` remains the permission selector. */
  licensing: import("@openconditions/model").Licensing;
  attribution: string;
  homepage: string;
  privacyUrl: string;
  /** The terms page, when they were last reviewed, and what they condition beyond the licence. */
  terms?: { url?: string; reviewedAt?: string; note?: string };
  /** A notice the publisher requires to accompany any display of its data, verbatim. */
  notice?: string;
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

function sourceOf(feed: CatalogFeed, at: Date): Source {
  const imageHosts = imageHostsOf(feed);
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
    format: feed.format,
    ...(feed.qualifier ? { qualifier: feed.qualifier } : {}),
    operator: feed.operator,
    region: feed.region,
    ...(feed.country ? { country: feed.country } : {}),
    ...(feed.subdivision ? { subdivision: feed.subdivision } : {}),
    accessMode: feed.accessMode ?? "bulk",
    restricted: feed.restricted,
    license: feed.license,
    licensing: captureLicensing(feed),
    attribution: resolveAttribution(feed.attribution, at),
    homepage: feed.homepage,
    privacyUrl: feed.privacyUrl,
    ...(Object.keys(terms).length > 0 ? { terms } : {}),
    ...(feed.terms?.notice ? { notice: feed.terms.notice } : {}),
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
 * through their parent and left out. An attribution's `{year}` is the
 * year of `at`.
 */
export function sourcesOf(catalog: Pick<Catalog, "sources">, at: Date = new Date()): Source[] {
  return catalog.sources
    .filter((feed) => feed.parentSourceId === undefined && feed.disabled === undefined)
    .map((feed) => sourceOf(feed, at))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The instance's crowd reports as a consumer credits them. They are no feed,
 * so `sources` does not list them; a reading or record whose source is
 * `crowd` is credited with this entry.
 */
export interface CrowdSource {
  id: "crowd";
  name: string;
  /** The licence id, as `Source.license`. */
  license: string;
  licensing: import("@openconditions/model").Licensing;
  /** The link the credit carries, when the operator configured one. */
  url?: string;
  rights: EffectiveRights;
}

export function crowdSourceOf(credit: CrowdCredit): CrowdSource {
  return {
    id: "crowd",
    name: credit.name,
    license: credit.license,
    licensing: captureLicensing({ id: "crowd", name: credit.name, license: credit.license }),
    ...(credit.url ? { url: credit.url } : {}),
    rights: effectiveRights(credit.license),
  };
}
