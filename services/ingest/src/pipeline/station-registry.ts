import type { FeedSource, SiteGeometry } from "@openconditions/roads";
import { parseFintrafficStations, parseWebtrisSites } from "@openconditions/roads";

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
};

/**
 * Loads a feed's JSON/GeoJSON station registry into a station-id → geometry
 * map, cached in-process so it is not refetched on every ingest run. Fetched
 * through the caller's egress-guarded fetch — never a raw `fetch` — the same
 * way the DATEX `siteTable` loader is guarded.
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

  try {
    const res = await fetchFn(reg.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${reg.url}`);
    const parse = PARSERS[reg.format];
    if (!parse) throw new Error(`no station-registry parser for ${reg.format}`);
    const map = parse(await res.text());
    cache.set(reg.url, { map, fetchedAt: now() });
    return map;
  } catch (err) {
    console.warn(
      `[ingest] station-registry load failed for ${src.id} (${reg.url}):`,
      err instanceof Error ? err.message : err
    );
    return cached?.map;
  }
}
