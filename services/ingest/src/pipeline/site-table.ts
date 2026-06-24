import { gunzipSync } from "node:zlib";
import type { FeedSource, SiteGeometry } from "@openconditions/roads";
import { parseDatexSiteTable } from "@openconditions/roads";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Site tables change rarely (version-stamped); refetch at most every 6 hours. */
const SITE_TABLE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  map: Map<string, SiteGeometry>;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

/** Clears the in-process site-table cache (used by tests). */
export function clearSiteTableCache(): void {
  cache.clear();
}

/**
 * Loads and parses a feed's DATEX II site table into an id→Geometry map, caching
 * the result in-process so a large (multi-MB) table is not refetched on every
 * (e.g. 60 s) ingest run. Returns undefined when the feed declares no site table
 * or when the fetch/parse fails — in which case the measured-data parser simply
 * lacks external geometry and skips sites it cannot resolve, never crashing the
 * run.
 */
export async function loadSiteTable(
  src: FeedSource,
  fetchFn: typeof fetch,
  now: () => number = Date.now
): Promise<Map<string, SiteGeometry> | undefined> {
  const table = src.siteTable;
  if (!table) return undefined;

  const cached = cache.get(table.url);
  if (cached && now() - cached.fetchedAt < SITE_TABLE_TTL_MS) {
    return cached.map;
  }

  try {
    const res = await fetchFn(table.url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${table.url}`);
    }
    const raw = Buffer.from(await res.arrayBuffer());
    const decoded = table.gzip || isGzip(raw) ? gunzipSync(raw) : raw;
    const map = parseDatexSiteTable(decoded);
    cache.set(table.url, { map, fetchedAt: now() });
    return map;
  } catch (err) {
    console.warn(
      `[ingest] site-table load failed for ${src.id} (${table.url}):`,
      err instanceof Error ? err.message : err
    );
    return cached?.map;
  }
}
