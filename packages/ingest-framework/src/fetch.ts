import type { FeedSourceBase } from "./feed-source.js";
import { resolvedEnv } from "./auth.js";
import { boundedGunzip, DEFAULT_MAX_FEED_BYTES } from "./egress.js";
import { resolveFeedUrls, resolveUrlTemplate, allowedTemplateVars } from "./template.js";
import { applyPreFetch } from "./pre-fetch.js";
import { getCatalogResolverById, resolveWithSnapshot } from "./catalog.js";
import { redactUrl, redactSecrets, feedSecretValues } from "./redact.js";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Max sub-feed fetches in flight when fanning out a resolved catalog URL set. */
const FANOUT_CONCURRENCY = 8;

/**
 * `FeedSourceBase` carries every declarative transport field this module needs
 * (`url` template(s), `expandEnv`, `bodyTemplate`, `catalog`). Kept as an alias
 * so the internal helpers read against one name.
 */
type FetchableFeed = FeedSourceBase;

/**
 * Per-source politeness memory: the ETag/Last-Modified of each URL (for
 * conditional GET) and the last fetch time of each source (for the
 * `fetchIntervalSec` gate). A long-lived scheduler shares one instance across
 * cycles so conditional headers accumulate; tests pass a fresh one.
 *
 * `buffer` (the last decompressed body) is retained ONLY for multi-URL feeds,
 * where a URL that replies 304 must be re-combined with a sibling URL that
 * changed before the source is re-parsed. Single-URL feeds skip entirely on 304
 * (see {@link fetchAll}), so caching their bodies — often tens of MB each, ~1 GB
 * across the ~30 datex feeds — only bloats off-heap memory and is omitted.
 */
export interface FetchState {
  conditional: Map<string, { etag?: string; lastModified?: string; buffer?: Buffer }>;
  lastFetchAt: Map<string, number>;
}

export function createFetchState(): FetchState {
  return { conditional: new Map(), lastFetchAt: new Map() };
}

const sharedFetchState = createFetchState();

export type FetchResult =
  | {
      status: "fetched";
      buffers: Buffer[];
      /**
       * Set only on a tolerant fan-out path (catalog or `fanoutTolerant`
       * static arrays) — undefined on every other path, where every URL
       * either succeeded or the whole fetch threw. `failures`/`total` count
       * sub-feed URLs, not bytes, so the caller (`runSource`) can compute a
       * failure ratio and decide whether a mostly-failed fan-out is too
       * unreliable to swap in (see `OPENCONDITIONS_FANOUT_FAIL_SKIP_RATIO`).
       */
      partial?: { failures: number; total: number };
    }
  | { status: "unchanged" };

interface FetchOptions {
  state?: FetchState;
  now?: () => number;
}

function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

// First non-whitespace char is '<' → an HTML/XML block/login/error page, not the
// JSON the fanned-out catalog feeds serve. Only applied on the fan-out path;
// XML feeds like NDW go through the single-URL path and are never checked here.
function looksLikeHtml(buf: Buffer): boolean {
  return buf.subarray(0, 64).toString("utf8").trimStart().startsWith("<");
}

/** Ceiling on a single feed's decompressed bytes; matches the guard's byte cap. */
const MAX_DECOMPRESSED_BYTES = Number(
  process.env["OPENCONDITIONS_MAX_FEED_BYTES"] || DEFAULT_MAX_FEED_BYTES
);

const EMPTY_BUFFER = Buffer.alloc(0);

async function fetchOne(
  url: string,
  fetchFn: typeof fetch,
  init?: RequestInit,
  state?: FetchState,
  cacheBody = false,
  redact: (s: string) => string = (s) => s
): Promise<{ changed: boolean; buffer: Buffer }> {
  const prior = state?.conditional.get(url);
  const headers = new Headers(init?.headers);
  if (prior?.etag) headers.set("If-None-Match", prior.etag);
  if (prior?.lastModified) headers.set("If-Modified-Since", prior.lastModified);

  const res = await fetchFn(url, { ...init, headers });
  // A 304 body is only consumed for a multi-URL feed's partial-304 re-parse
  // (where `cacheBody` is true and `prior.buffer` was retained). A single-URL 304
  // returns this empty buffer, which the caller discards on its "unchanged" path.
  if (res.status === 304 && prior) return { changed: false, buffer: prior.buffer ?? EMPTY_BUFFER };
  if (!res.ok) {
    // `redact` (the feed's own secret values) runs after `redactUrl` (query
    // values) so a credential duplicated into the URL PATH — e.g. Mobilithek's
    // subscription id — is also scrubbed, not just its query-string copy.
    throw new Error(`HTTP ${res.status} fetching ${redact(redactUrl(url))}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const raw = Buffer.from(arrayBuf);
  const buffer = isGzip(raw) ? await boundedGunzip(raw, MAX_DECOMPRESSED_BYTES) : raw;
  if (state) {
    state.conditional.set(url, {
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      buffer: cacheBody ? buffer : undefined,
    });
  }
  return { changed: true, buffer };
}

/** Build the RequestInit for a feed: POST + body + headers when configured. */
function requestInit(src: FetchableFeed): RequestInit | undefined {
  if (src.method !== "POST") {
    return src.requestHeaders ? { headers: src.requestHeaders } : undefined;
  }
  return {
    method: "POST",
    body: src.bodyTemplate
      ? resolveUrlTemplate(src.bodyTemplate, resolvedEnv(), allowedTemplateVars(src))
      : undefined,
    headers: src.requestHeaders,
  };
}

/**
 * Fetches a resolved catalog URL set with bounded concurrency and per-URL tolerance:
 * a single failing sub-feed is logged and skipped rather than aborting the
 * whole batch (many registry feeds require operator-supplied keys and will
 * fail). Throws only if *every* sub-feed fails, so the caller preserves the
 * last-good rows instead of swapping in an empty set.
 *
 * Returns `failures`/`total` alongside the successful buffers (rather than a
 * bare `Buffer[]`) so a caller can tell a mostly-healthy fan-out from a
 * mass-failure one that merely stayed above the all-failed floor — without
 * this, `runSource` swapped in whatever fragment survived even when e.g. 9 of
 * 10 sub-feeds failed, and the diff-upsert's delete-missing step then wiped
 * every row belonging to the 9 failed sub-feeds as "no longer present".
 *
 * FUTURE refinement: once a per-sub-feed last-good buffer is available here
 * (the `cacheBody`/`FetchState.conditional` plumbing `fetchOne` already
 * supports for the static multi-URL path, but `fetchFanout` doesn't thread a
 * `state` through today), a failed sub-feed could contribute its cached
 * buffer instead of vanishing from `out` — so no rows would be pruned even
 * below the ratio threshold below. Not built here: it depends on that
 * in-progress per-URL body-caching work landing first.
 */
async function fetchFanout(
  urls: string[],
  fetchFn: typeof fetch,
  redact: (s: string) => string = (s) => s
): Promise<{ buffers: Buffer[]; failures: number; total: number }> {
  const out: Buffer[] = [];
  let failures = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const url = urls[cursor++]!;
      try {
        const { buffer } = await fetchOne(url, fetchFn, undefined, undefined, false, redact);
        if (looksLikeHtml(buffer)) {
          throw new Error("returned HTML, not JSON");
        }
        out.push(buffer);
      } catch (err) {
        failures++;
        console.warn(
          `[ingest] sub-feed fetch failed (${redact(url)}):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  const workerCount = Math.min(FANOUT_CONCURRENCY, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (urls.length > 0 && out.length === 0) {
    throw new Error(`all ${urls.length} sub-feeds failed (${failures} failures)`);
  }
  return { buffers: out, failures, total: urls.length };
}

/**
 * Fetches every url with bounded concurrency, preserving order, threading the
 * conditional-GET `state` through each request. Unlike the tolerant catalog
 * fan-out, a single failure rejects the whole batch (matching the prior
 * Promise.all semantics for static feed URL sets). Returns the per-URL
 * `{changed, buffer}` so the caller can decide the source is unchanged when
 * every URL replied 304.
 */
async function fetchAllBounded(
  urls: string[],
  fetchFn: typeof fetch,
  init: RequestInit | undefined,
  state: FetchState | undefined,
  cacheBody: boolean,
  redact: (s: string) => string = (s) => s
): Promise<{ changed: boolean; buffer: Buffer }[]> {
  const out = new Array<{ changed: boolean; buffer: Buffer }>(urls.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const i = cursor++;
      out[i] = await fetchOne(urls[i]!, fetchFn, init, state, cacheBody, redact);
    }
  }
  const workerCount = Math.min(FANOUT_CONCURRENCY, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

/** Shallow equality match of a resolved descriptor against a catalog filter. */
function matchesFilter(feed: FeedSourceBase, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(
    ([k, v]) => (feed as unknown as Record<string, unknown>)[k] === v
  );
}

/**
 * Resolves the URL(s) for a feed source and fetches each one, returning a
 * {@link FetchResult}. Buffers are gunzipped transparently when the response
 * bytes start with the gzip magic bytes 0x1f 0x8b.
 *
 * `src.catalog`, when present, resolves a registry into concrete feed
 * descriptors (live, with a vendored-snapshot fallback) and fans their URLs out
 * tolerantly (takes precedence over `src.url`) — always "fetched", since
 * registry sub-feeds are best-effort and not conditionally cached. Otherwise
 * `src.url` is a `${VAR}` template string or array of templates; `expandEnv`
 * fans one template out over a comma-separated env var. Multi-URL sets fetch
 * with bounded concurrency so a large resolved URL set cannot fire every
 * request at once. A static multi-URL feed with `fanoutTolerant: true` is
 * instead routed through the same per-URL tolerant fetcher as the catalog
 * path (see below).
 *
 * Politeness on the static/template path: a source fetched within its
 * `fetchIntervalSec` window is skipped ("unchanged"); each URL sends its cached
 * ETag/Last-Modified, and a source whose every URL replied 304 is "unchanged"
 * so the caller preserves last-good rows instead of re-swapping.
 */
export async function fetchAll(
  src: FetchableFeed,
  fetchFn: typeof fetch,
  opts: FetchOptions = {}
): Promise<FetchResult> {
  const state = opts.state ?? sharedFetchState;
  const now = opts.now ?? Date.now;

  // Scrubs `src`'s own secret values (its auth vars + `requiredEnv`) out of
  // any string before it reaches a log or `FeedStatusStore` — computed once,
  // at the source, from the ORIGINAL descriptor (not `active`; the one
  // registered pre-fetch hook never rewrites `auth`/`requiredEnv`) so every
  // downstream log/error is pre-scrubbed of values a syntax-only redactor
  // like `redactUrl` would miss (e.g. a credential duplicated into the URL path).
  const redact = (s: string) => redactSecrets(s, feedSecretValues(src));

  // Reactive pre-fetch transform (dormant — no hooks registered today). When a
  // hook is registered it may rewrite the descriptor before URL resolution; with
  // none, this returns `src` unchanged.
  const active = await applyPreFetch(src, resolvedEnv(), fetchFn);

  if (active.catalog) {
    const resolver = getCatalogResolverById(active.catalog.resolver);
    const feeds = (await resolveWithSnapshot(resolver, fetchFn)).filter((f) =>
      matchesFilter(f, active.catalog?.filter)
    );
    const urls = feeds.flatMap((f) => (Array.isArray(f.url) ? f.url : f.url ? [f.url] : []));
    const fanout = await fetchFanout(urls, fetchFn, redact);
    return {
      status: "fetched",
      buffers: fanout.buffers,
      partial: { failures: fanout.failures, total: fanout.total },
    };
  }

  // `fanoutTolerant` opts a large static multi-URL fan-out (e.g. WebTRIS's
  // ~150 per-site URLs) into the same per-URL tolerant fetcher the catalog
  // path uses, instead of the all-or-nothing `fetchAllBounded` below. This
  // skips conditional-GET/`fetchIntervalSec`/`unchanged` handling entirely
  // (fetchFanout doesn't do ETag/304) — an acceptable trade for these feeds,
  // e.g. WebTRIS's URL date-window changes every run, so conditional GET buys
  // nothing anyway. Feeds without the flag (or with a single URL) are
  // unaffected and fall through to the static path unchanged.
  if (active.fanoutTolerant) {
    const fanoutUrls = resolveFeedUrls(active, resolvedEnv());
    if (fanoutUrls.length > 1) {
      const fanout = await fetchFanout(fanoutUrls, fetchFn, redact);
      return {
        status: "fetched",
        buffers: fanout.buffers,
        partial: { failures: fanout.failures, total: fanout.total },
      };
    }
  }

  if (active.fetchIntervalSec != null) {
    const last = state.lastFetchAt.get(active.id);
    if (last != null && now() - last < active.fetchIntervalSec * 1000) {
      return { status: "unchanged" };
    }
  }

  const urls = resolveFeedUrls(active, resolvedEnv());
  if (urls.length === 0) {
    if (active.url == null) throw new Error(`feed ${active.id} has neither url nor catalog`);
    // expandEnv configured but no items yet — a dormant, uncredentialed feed.
    state.lastFetchAt.set(active.id, now());
    return { status: "fetched", buffers: [] };
  }

  const init = requestInit(active);
  // Retain last bodies only for multi-URL feeds — a single-URL feed skips whole
  // on 304 (below) and never re-reads its cached body, so caching it just holds
  // tens of MB of off-heap Buffer per feed for nothing.
  const results = await fetchAllBounded(urls, fetchFn, init, state, urls.length > 1, redact);
  state.lastFetchAt.set(active.id, now());

  if (results.every((r) => !r.changed)) return { status: "unchanged" };
  return { status: "fetched", buffers: results.map((r) => r.buffer) };
}
