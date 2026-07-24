import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { FeedSource, SiteGeometry, SiteTableParser } from "@openconditions/roads";
import { createPredefinedLocationsParser, createSiteTableParser } from "@openconditions/roads";
import {
  DEFAULT_MAX_FEED_BYTES,
  allowedTemplateVars,
  resolvedEnv,
  resolveUrlTemplate,
} from "@openconditions/ingest-framework";
import { withStreamRetry } from "./stream-retry.js";

/** Site tables change rarely (version-stamped); refetch at most every 6 hours. */
const SITE_TABLE_TTL_MS = 6 * 60 * 60 * 1000;

/** Ceiling on a single site table's decompressed bytes; matches the guard's byte cap. */
const MAX_DECOMPRESSED_BYTES = Number(
  process.env["OPENCONDITIONS_MAX_FEED_BYTES"] || DEFAULT_MAX_FEED_BYTES
);

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
  gzip: boolean,
  makeParser: () => SiteTableParser
): Promise<Map<string, SiteGeometry>> {
  const parser = makeParser();
  // `.pipe()` does not forward the source's errors to the gunzip stream, so a
  // mid-stream socket drop on the (multi-hundred-MB) download would surface as an
  // unhandled 'error' event and crash the process. Forward it so the loop rejects
  // and loadSiteTable's try/catch turns it into a logged fall-back to the cached
  // map; destroy `source` on the way out so a half-read connection never lingers.
  const decoded: Readable = gzip ? source.pipe(createGunzip()) : source;
  if (decoded !== source) source.on("error", (err) => decoded.destroy(err));
  try {
    let decompressed = 0;
    decoded.setEncoding("utf8");
    for await (const chunk of decoded) {
      decompressed += Buffer.byteLength(chunk as string);
      if (decompressed > MAX_DECOMPRESSED_BYTES) {
        if (decoded !== source) source.destroy();
        decoded.destroy();
        throw new Error(`decompressed stream exceeded ${MAX_DECOMPRESSED_BYTES} bytes`);
      }
      parser.write(chunk as string);
    }
  } finally {
    if (decoded !== source) source.destroy();
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

  // resolveUrlTemplate throws for a declared-but-unset ${VAR}; treat an unset
  // Verortung id as "dormant, no site table" rather than an error.
  let expanded: string;
  try {
    expanded = resolveUrlTemplate(table.url, resolvedEnv(), allowedTemplateVars(src));
  } catch {
    return undefined;
  }

  const cached = cache.get(expanded);
  if (cached && now() - cached.fetchedAt < SITE_TABLE_TTL_MS) {
    return cached.map;
  }

  const makeParser =
    table.format === "datex-predefined-locations"
      ? createPredefinedLocationsParser
      : createSiteTableParser;

  try {
    // Retry a transient mid-stream drop with a fresh connection + parser before
    // falling back — the cold 362 MB fetch is the one most likely to drop.
    const map = await withStreamRetry(
      async () => streamIntoParser(await streamFactory(expanded), table.gzip ?? false, makeParser),
      `${src.id} site-table`
    );
    cache.set(expanded, { map, fetchedAt: now() });
    return map;
  } catch (err) {
    console.warn(
      `[ingest] site-table load failed for ${src.id} (${expanded}):`,
      err instanceof Error ? err.message : err
    );
    return cached?.map;
  }
}
