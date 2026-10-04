import type { Catalog, CatalogFeed, EffectiveRights } from "@openconditions/ingest-framework";

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
  license: string;
  licenseUrl?: string;
  attribution: string;
  homepage: string;
  privacyUrl: string;
  /** The terms page, when they were last reviewed, and what they condition beyond the licence. */
  terms?: { url?: string; reviewedAt?: string; note?: string };
  rights: EffectiveRights;
}

function sourceOf(feed: CatalogFeed): Source {
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
    ...(feed.licenseUrl ? { licenseUrl: feed.licenseUrl } : {}),
    attribution: feed.attribution,
    homepage: feed.homepage,
    privacyUrl: feed.privacyUrl,
    ...(Object.keys(terms).length > 0 ? { terms } : {}),
    rights: feed.rights,
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
