import {
  type CatalogFeed,
  type Env,
  type FetchFn,
  feedEndpoint,
  feedSecretValues,
  redactSecrets,
  redactUrl,
  resolveEndpointUrls,
  resolveFeedTemplate,
} from "@openconditions/ingest-framework";
import { digestOnlyTee, type StreamTeeFactory } from "../raw/stream-tee.js";
import { bodyStreamFrom } from "./body-stream.js";
import { resolveMobilithekReference } from "./mobilithek-reference.js";
import { isSiteTableDecoder, readSiteTable } from "./site-table.js";
import { readStationRegistry } from "./station-registry.js";

interface CacheEntry {
  data: unknown;
  fetchedAt: number;
}

/**
 * Decoded reference data by source and decoder. Keyed by what is fetched, not
 * by feed, so two feeds sharing a site table hold one copy of it.
 */
const cache = new Map<string, CacheEntry>();

/** Clears the in-process reference cache (used by tests). */
export function clearReferenceCaches(): void {
  cache.clear();
}

/** The endpoint's request headers, their `${field}`s filled; undefined when it declares none. */
function requestInit(feed: CatalogFeed, role: string, env: Env): RequestInit | undefined {
  const headers = feedEndpoint(feed, role).headers;
  if (!headers) return undefined;
  return {
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, resolveFeedTemplate(feed, v, env)]),
    ),
  };
}

/**
 * Loads one reference endpoint of a feed (a site table, a station registry)
 * with the decoder it names, cached in-process for the endpoint's
 * `cadenceSec`, so a large table is not refetched on every poll. A `url`
 * endpoint is fetched as written; a Mobilithek `reference` endpoint resolves,
 * each time it is due, to the latest file of its offer. Every request goes
 * through `fetchFn`, the poll's guarded fetch, and the body through the tee,
 * which archives it as a raw reference payload when the poll keeps any.
 *
 * Never throws. Returns undefined when the URL names a credential that is not
 * set (a dormant table), or when loading fails with nothing cached; a later
 * failure with a warm cache returns the last good data, so a transient outage
 * never strips geometry mid-run.
 */
export async function loadReference(
  feed: CatalogFeed,
  role: string,
  fetchFn: FetchFn,
  now: () => number = Date.now,
  teeFor: StreamTeeFactory = digestOnlyTee,
  env: Env = process.env,
): Promise<unknown | undefined> {
  const endpoint = feedEndpoint(feed, role);
  const decoder = endpoint.decoder;
  if (decoder === undefined) throw new Error(`feed ${feed.id}: endpoint ${role} has no decoder`);

  let url: string | undefined;
  if (!endpoint.reference) {
    try {
      url = resolveEndpointUrls(feed, role, env)[0];
    } catch {
      return undefined;
    }
    if (url === undefined) return undefined;
  }
  const key = `${decoder}\0${url ?? JSON.stringify(endpoint.reference)}`;
  const cached = cache.get(key);
  if (cached && now() - cached.fetchedAt < endpoint.cadenceSec * 1000) return cached.data;

  // Scrubs the feed's own secret values out of anything logged or archived —
  // the URL itself, and any error message that embeds it.
  const secrets = feedSecretValues(feed, env);
  const redact = (s: string) => redactSecrets(redactUrl(s), secrets);
  try {
    const target = url ?? (await resolveMobilithekReference(endpoint.reference!, fetchFn));
    const label = redact(target);
    const init = requestInit(feed, role, env);
    const data = isSiteTableDecoder(decoder)
      ? await readSiteTable(target, {
          decoder,
          label,
          gzip: endpoint.gzip ?? false,
          ...(init ? { init } : {}),
          stream: bodyStreamFrom(fetchFn, redact),
          teeFor,
        })
      : await readStationRegistry(target, {
          decoder,
          label,
          ...(init ? { init } : {}),
          fetchFn,
          teeFor,
        });
    cache.set(key, { data, fetchedAt: now() });
    return data;
  } catch (err) {
    console.warn(
      `[ingest] ${decoder} load failed for ${feed.id} (${role}):`,
      err instanceof Error ? redact(err.message) : err,
    );
    return cached?.data;
  }
}
