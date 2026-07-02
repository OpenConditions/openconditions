import type { Env } from "./auth.js";
import type { FeedSourceBase } from "./feed-source.js";

/**
 * A reactive pre-fetch transform: given a feed and the resolved env, return a
 * possibly-rewritten descriptor (e.g. a scraped session URL, a date-stamped path).
 * Runs before URL resolution. Intentionally empty until a feed that needs it lands
 * (the login-then-session-cookie class); adding one is a deliberate, reviewed step.
 */
export type PreFetchHook = (
  src: FeedSourceBase,
  env: Env,
  fetchFn: typeof fetch
) => Promise<FeedSourceBase>;

function ddmmyyyy(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${day}${mon}${d.getUTCFullYear()}`;
}

/** Station registries change rarely; refetch the WebTRIS `/sites` list at most every 6 hours. */
const WEBTRIS_SITES_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Hard cap on the number of WebTRIS sites fanned out to per ingest cycle.
 * WebTRIS has 11k+ registered sites nationwide; querying all of them every
 * `cadenceSec` would be an unreasonable request rate against a public,
 * unauthenticated government API. The resulting URL array is fetched via the
 * tolerant `fetchFanout` (fetch.ts, opted into via `fanoutTolerant` on the
 * feed), so one bad site no longer risks aborting the whole cycle's swap —
 * the cap remains purely a request-rate courtesy/robustness balance, kept
 * well under a few hundred requests per cycle.
 */
export const WEBTRIS_MAX_SITES = 150;

/**
 * WebTRIS's `/reports/daily` documents `sites` as "Comma separated list of
 * site Ids" and the API does accept multiple ids in one request (verified
 * against the live API: a combined multi-site query's `row_count` sums the
 * per-site row counts). But this feed's `page_size` is small and fixed
 * relative to a single site's own daily row count, so combining several
 * sites into one request only returns rows for the first site(s) — later
 * sites in the same chunk are silently crowded out of the page before their
 * rows ever appear. Chunking one site per URL instead spends the whole
 * `page_size` budget on that site, maximizing the number of DISTINCT sites
 * that actually come back with data.
 */
export const WEBTRIS_SITE_CHUNK_SIZE = 1;

/**
 * Fallback site id used when the `/sites` registry is unreachable or returns
 * no active sites — the single site this feed hardcoded before per-site
 * fan-out was added, kept as a documented last resort so the feed always
 * resolves to a working URL.
 */
export const WEBTRIS_FALLBACK_SITE_ID = "5607";

interface WebtrisSiteRecord {
  Id?: unknown;
  Status?: unknown;
}

interface WebtrisSitesCacheEntry {
  ids: string[];
  fetchedAt: number;
}

const webtrisSitesCache = new Map<string, WebtrisSitesCacheEntry>();

/** Clears the in-process WebTRIS active-sites cache (used by tests). */
export function clearWebtrisSitesCache(): void {
  webtrisSitesCache.clear();
}

/**
 * Loads the WebTRIS `/sites` registry and returns up to `WEBTRIS_MAX_SITES`
 * active site ids, cached in-process (TTL `WEBTRIS_SITES_TTL_MS`) so the
 * multi-megabyte registry is not refetched every ingest cycle. Parses the
 * response inline rather than importing `@openconditions/roads`'
 * `parseWebtrisSites`, because `ingest-framework` sits below the `roads`
 * package in the dependency layering and cannot depend on it.
 *
 * Fetched only through the caller's egress-guarded `fetchFn` — never a raw
 * `fetch`. Never throws: any fetch/parse failure returns the last-good
 * cached ids (or an empty array when there is no cache yet), logging a
 * warning either way, so a transient registry outage never crashes the
 * pre-fetch step.
 */
export async function loadWebtrisActiveSiteIds(
  registryUrl: string,
  headers: Record<string, string> | undefined,
  fetchFn: typeof fetch,
  now: () => number = Date.now
): Promise<string[]> {
  const cached = webtrisSitesCache.get(registryUrl);
  if (cached && now() - cached.fetchedAt < WEBTRIS_SITES_TTL_MS) return cached.ids;

  try {
    const res = await fetchFn(registryUrl, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${registryUrl}`);
    const payload = JSON.parse(await res.text()) as { sites?: unknown };
    const records = Array.isArray(payload.sites) ? (payload.sites as WebtrisSiteRecord[]) : [];
    const ids = records
      .filter((s) => s.Status === "Active" && s.Id != null)
      .map((s) => String(s.Id))
      .slice(0, WEBTRIS_MAX_SITES);
    webtrisSitesCache.set(registryUrl, { ids, fetchedAt: now() });
    return ids;
  } catch (err) {
    console.warn(
      `[ingest] webtrisDailyWindow: sites registry load failed (${registryUrl}):`,
      err instanceof Error ? err.message : err
    );
    return cached?.ids ?? [];
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Stamps a rolling one-day window (yesterday → today, DDMMYYYY UTC) into a
 * WebTRIS daily-report URL by replacing the `{start_date}`/`{end_date}`
 * tokens. WebTRIS requires an explicit date range and has no "latest"
 * shortcut.
 *
 * When the url also carries a `{sites}` token, fans the single-site template
 * out into one concrete URL per active site drawn from the feed's
 * `stationRegistry` (bounded to `WEBTRIS_MAX_SITES`, one site per URL — see
 * `WEBTRIS_SITE_CHUNK_SIZE`), so the feed gets real multi-site coverage
 * instead of one hardcoded sensor. Falls back to `WEBTRIS_FALLBACK_SITE_ID`
 * — never leaving `{sites}` unresolved — when the registry is unreachable or
 * yields no active sites, so the feed always resolves to a working URL; both
 * fallback cases emit a `console.warn` so a silent revert-to-one-site stays
 * operator-visible. `stationRegistry` is a roads-domain field not declared on the base
 * `FeedSourceBase` type, so it is read via a structural cast, mirroring the
 * same pattern in `layered-feeds.ts`.
 */
const webtrisDailyWindow: PreFetchHook = async (src, _env, fetchFn) => {
  const url = Array.isArray(src.url) ? src.url[0] : src.url;
  if (typeof url !== "string") return src;
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const dateStamped = url
    .replace("{start_date}", ddmmyyyy(yesterday))
    .replace("{end_date}", ddmmyyyy(today));

  if (!dateStamped.includes("{sites}")) {
    return { ...src, url: dateStamped };
  }

  const registryUrl = (src as { stationRegistry?: { url?: string } }).stationRegistry?.url;
  const activeIds = registryUrl
    ? await loadWebtrisActiveSiteIds(registryUrl, src.requestHeaders, fetchFn)
    : [];
  if (activeIds.length === 0) {
    console.warn(
      `[ingest] webtrisDailyWindow: ${src.id} has zero active sites (registry unreachable or none marked Active); falling back to default site ${WEBTRIS_FALLBACK_SITE_ID}`
    );
  }
  const ids = activeIds.length > 0 ? activeIds : [WEBTRIS_FALLBACK_SITE_ID];
  const urls = chunk(ids, WEBTRIS_SITE_CHUNK_SIZE).map((c) =>
    dateStamped.replace("{sites}", c.join(","))
  );
  return { ...src, url: urls };
};

export const PRE_FETCH_HOOKS: Record<string, PreFetchHook> = { webtrisDailyWindow };

export async function applyPreFetch(
  src: FeedSourceBase,
  env: Env,
  fetchFn: typeof fetch
): Promise<FeedSourceBase> {
  if (!src.preFetch) return src;
  const hook = PRE_FETCH_HOOKS[src.preFetch];
  if (!hook) throw new Error(`feed ${src.id} references unknown preFetch hook ${src.preFetch}`);
  return hook(src, env, fetchFn);
}
