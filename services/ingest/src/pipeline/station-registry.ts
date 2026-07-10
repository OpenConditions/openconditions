import type { FeedSource, SiteGeometry } from "@openconditions/roads";
import {
  parseFintrafficStations,
  parseFranceComptageStations,
  parseHkDetectors,
  parseMivConfig,
  parseWebtrisSites,
} from "@openconditions/roads";
import { feedSecretValues, redactSecrets } from "@openconditions/ingest-framework";

/** Station registries change rarely; refetch at most every 6 hours. */
const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  map: Map<string, SiteGeometry>;
  fetchedAt: number;
}
const cache = new Map<string, CacheEntry>();

/** Clears the in-process registry cache (used by tests). */
export function clearStationRegistryCache(): void {
  cache.clear();
}

const PARSERS: Record<string, (input: string) => Map<string, SiteGeometry>> = {
  "fintraffic-stations": parseFintrafficStations,
  "webtris-sites": parseWebtrisSites,
  "miv-config": parseMivConfig,
  "france-comptage-csv": parseFranceComptageStations,
  "hk-detector-csv": parseHkDetectors,
};

/**
 * Loads a feed's JSON/GeoJSON station registry into a station-id → geometry
 * map, cached in-process so it is not refetched on every ingest run. Fetched
 * through the caller's egress-guarded fetch — never a raw `fetch` — the same
 * way the DATEX `siteTable` loader is guarded, and carrying the feed's
 * `requestHeaders` (e.g. Fintraffic's `Digitraffic-User`) when it declares any.
 *
 * Returns undefined when the feed declares no registry, or when the fetch or
 * parse fails with no usable cache yet — the flow parser then simply skips
 * sites it cannot resolve, never crashing the run. A later fetch failure with
 * a warm cache instead returns the last-good map, so a transient registry
 * outage never strips geometry mid-run.
 */
export async function loadStationRegistry(
  src: FeedSource,
  fetchFn: typeof fetch,
  now: () => number = Date.now
): Promise<Map<string, SiteGeometry> | undefined> {
  const reg = src.stationRegistry;
  if (!reg) return undefined;

  const cached = cache.get(reg.url);
  if (cached && now() - cached.fetchedAt < REGISTRY_TTL_MS) return cached.map;

  // Scrubs `src`'s own secret values out of any string before it reaches the
  // warn log below — the registry url itself, AND any error message that
  // embeds it (e.g. the HTTP-status error just below), so a credential
  // duplicated into the URL path is never logged unredacted either way.
  const redact = (s: string) => redactSecrets(s, feedSecretValues(src));

  try {
    const res = await fetchFn(reg.url, { headers: src.requestHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${redact(reg.url)}`);
    const parse = PARSERS[reg.format];
    if (!parse) throw new Error(`no station-registry parser for ${reg.format}`);
    const map = parse(await res.text());
    cache.set(reg.url, { map, fetchedAt: now() });
    return map;
  } catch (err) {
    console.warn(
      `[ingest] station-registry load failed for ${src.id} (${redact(reg.url)}):`,
      err instanceof Error ? redact(err.message) : err
    );
    return cached?.map;
  }
}
