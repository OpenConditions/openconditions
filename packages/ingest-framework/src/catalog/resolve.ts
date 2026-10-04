import { credentialRefs, isSettingsGroup } from "./credentials.js";
import { deriveFeedId, type Region } from "./ids.js";
import { effectiveRights, isRestricted } from "./terms.js";
import type { CatalogFeed, CredentialField, FeedDefinition, Maintainer } from "./types.js";

/**
 * Where a feed definition was written: its domain, its region file and that
 * file's maintainers, and the catalogue's shared credential groups.
 */
export interface FeedOrigin {
  domain: string;
  region: Region;
  file: string;
  maintainers: Maintainer[];
  shared?: Readonly<Record<string, Readonly<Record<string, CredentialField>>>>;
}

type SharedGroups = NonNullable<FeedOrigin["shared"]>;

/**
 * The shared fields a feed reads that its catalogue declares, by ref, and
 * which of them are settings.
 */
function sharedFieldsOf(
  def: FeedDefinition,
  shared: SharedGroups,
): { fields: Record<string, CredentialField>; settings: string[] } {
  const fields: Record<string, CredentialField> = {};
  const settings: string[] = [];
  for (const { ref } of credentialRefs(def)) {
    const match = /^@([^.]+)\.([^.]+)$/.exec(ref);
    const group = match ? shared[match[1] as string] : undefined;
    const field = group?.[match?.[2] as string];
    if (!group || !field) continue;
    fields[ref] = field;
    if (isSettingsGroup(group)) settings.push(ref);
  }
  return { fields, settings };
}

/** The smallest cadence over a feed's endpoints that are not reference data. */
function dataCadenceSec(feed: FeedDefinition, id: string): number {
  const cadences = Object.values(feed.endpoints)
    .filter((endpoint) => endpoint.decoder === undefined)
    .map((endpoint) => endpoint.cadenceSec);
  if (cadences.length === 0) throw new Error(`feed ${id} has no data endpoint`);
  return Math.min(...cadences);
}

/** `https://host` and nothing more: https, the default port, no path, no credentials. */
function plainHttpsOrigin(text: string): string | undefined {
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * The origin an endpoint template names, read off the written text: scheme and
 * authority up to the first `/`, `?` or `#`. An authority with a placeholder
 * names none: a credential there must not reach a credit link, and a shared
 * settings base is the instance's own service (perhaps plain http), not the
 * publisher's site.
 */
function templateOrigin(template: string): string | undefined {
  const written = /^https:\/\/([^/?#]*)/.exec(template);
  if (!written || written[1]!.includes("${")) return undefined;
  return plainHttpsOrigin(`https://${written[1]}`);
}

/**
 * The credit link of a feed without a written `homepage`: the `https` origin,
 * on the default port, of its first data endpoint's URL. It is read off the
 * written template, so a credential never reaches it, in the path, the query or
 * the host. Reference data (an endpoint with a decoder) is skipped. Undefined
 * when the endpoint names no such origin: the feed then needs a written one.
 */
export function deriveHomepage(endpoints: FeedDefinition["endpoints"]): string | undefined {
  for (const endpoint of Object.values(endpoints)) {
    if (endpoint.decoder !== undefined) continue;
    const template = endpoint.urls?.[0] ?? endpoint.url;
    if (template === undefined) continue;
    return templateOrigin(template);
  }
  return undefined;
}

/**
 * A written feed definition as the catalogue hands it out: the id derived from
 * its region and tokens, the country of a country region, the rights its licence
 * and terms grant, its coverage (the country when unwritten), its cadence and its
 * homepage. Throws on an unknown licence, a feed whose every endpoint is
 * reference data, or one whose homepage is neither written nor derivable.
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
  const rights = effectiveRights(def.license, def.terms);
  const cadenceSec = dataCadenceSec(def, id);
  const homepage = def.homepage ?? deriveHomepage(def.endpoints);
  if (homepage === undefined) {
    throw new Error(
      `feed ${id}: no https URL on the default port names its publisher, so it needs a written homepage`,
    );
  }
  const feed: CatalogFeed = {
    ...def,
    homepage,
    id,
    domain: origin.domain,
    region: origin.region,
    file: origin.file,
    maintainers: origin.maintainers,
    rights,
    restricted: isRestricted(rights),
    coverage: def.coverage ?? (country ? { countries: [country] } : {}),
    cadenceSec,
  };
  if (country) feed.country = country;
  else delete feed.country;
  const { fields, settings } = origin.shared
    ? sharedFieldsOf(def, origin.shared)
    : { fields: {}, settings: [] };
  if (Object.keys(fields).length > 0) feed.sharedFields = fields;
  else delete feed.sharedFields;
  if (settings.length > 0) feed.settingRefs = settings;
  else delete feed.settingRefs;
  return feed;
}
