import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { FeedSource, SiteGeometry } from "@openconditions/roads";
import { createSiteTableParser } from "@openconditions/roads";

/** Site tables change rarely (version-stamped); refetch at most every 6 hours. */
const SITE_TABLE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  map: Map<string, SiteGeometry>;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * A stream factory for the raw (possibly gzipped) site-table body. Injectable so
 * tests can feed a fixture without a real network round-trip. The default
 * implementation fetches directly so it can consume `res.body` as a Node stream,
 * never materialising the multi-hundred-MB document in memory.
 */
export type SiteTableStreamFactory = (url: string) => Promise<Readable>;

const defaultStreamFactory: SiteTableStreamFactory = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  if (!res.body) {
    throw new Error(`empty body fetching ${url}`);
  }
  return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
};

/** Clears the in-process site-table cache (used by tests). */
export function clearSiteTableCache(): void {
  cache.clear();
}

/**
 * Streams a chunked, possibly-gzipped XML stream through the incremental
 * site-table parser. Memory stays bounded to the output Map plus the small SAX
 * accumulators — the source bytes flow through gunzip → SAX and are discarded.
 */
async function streamIntoParser(
  source: Readable,
  gzip: boolean
): Promise<Map<string, SiteGeometry>> {
  const parser = createSiteTableParser();
  const decoded: Readable = gzip ? source.pipe(createGunzip()) : source;
  decoded.setEncoding("utf8");
  for await (const chunk of decoded) {
    parser.write(chunk as string);
  }
  return parser.close();
}

/**
 * Loads and parses a feed's DATEX II site table into an id→Geometry map, caching
 * the result in-process so a large (multi-hundred-MB) table is not refetched on
 * every (e.g. 60 s) ingest run.
 *
 * The fetch → gunzip → parse path is fully streaming: the 362 MB NDW site table
 * is never held in memory as a whole — only the resolved id→Geometry map (tens
 * of MB) survives the call. Returns undefined when the feed declares no site
 * table or when the fetch/parse fails with no usable cache — in which case the
 * measured-data parser simply lacks external geometry and skips sites it cannot
 * resolve, never crashing the run.
 */
export async function loadSiteTable(
  src: FeedSource,
  streamFactory: SiteTableStreamFactory = defaultStreamFactory,
  now: () => number = Date.now
): Promise<Map<string, SiteGeometry> | undefined> {
  const table = src.siteTable;
  if (!table) return undefined;

  const cached = cache.get(table.url);
  if (cached && now() - cached.fetchedAt < SITE_TABLE_TTL_MS) {
    return cached.map;
  }

  try {
    const source = await streamFactory(table.url);
    const map = await streamIntoParser(source, table.gzip ?? false);
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
