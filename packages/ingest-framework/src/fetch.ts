import type { FeedSourceBase } from "./feed-source.js";
import { resolvedEnv } from "./auth.js";
import { boundedGunzip } from "./egress.js";
import { resolveFeedUrls, resolveUrlTemplate } from "./template.js";
import { applyPreFetch } from "./pre-fetch.js";
import { getCatalogResolverById, resolveWithSnapshot } from "./catalog.js";

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
 * Per-source politeness memory: the ETag/Last-Modified + last body of each URL
 * (for conditional GET) and the last fetch time of each source (for the
 * `fetchIntervalSec` gate). A long-lived scheduler shares one instance across
 * cycles so conditional headers accumulate; tests pass a fresh one.
 */
export interface FetchState {
  conditional: Map<string, { etag?: string; lastModified?: string; buffer: Buffer }>;
  lastFetchAt: Map<string, number>;
}

export function createFetchState(): FetchState {
  return { conditional: new Map(), lastFetchAt: new Map() };
}

const sharedFetchState = createFetchState();

export type FetchResult = { status: "fetched"; buffers: Buffer[] } | { status: "unchanged" };

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

/**
 * Strip query-string VALUES from a URL for safe logging. Several feeds carry
 * credentials in query params (e.g. Buenos Aires' client_id/client_secret), and
 * fetch errors bubble the URL into logs — so redact every value while keeping the
 * path and param names for debugging. Falls back to the path on a parse failure.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/** Ceiling on a single feed's decompressed bytes; matches the guard's byte cap. */
const MAX_DECOMPRESSED_BYTES = Number(
  process.env["OPENCONDITIONS_MAX_FEED_BYTES"] || 256 * 1024 * 1024
);

async function fetchOne(
  url: string,
  fetchFn: typeof fetch,
  init?: RequestInit,
  state?: FetchState
): Promise<{ changed: boolean; buffer: Buffer }> {
  const prior = state?.conditional.get(url);
  const headers = new Headers(init?.headers);
  if (prior?.etag) headers.set("If-None-Match", prior.etag);
  if (prior?.lastModified) headers.set("If-Modified-Since", prior.lastModified);

  const res = await fetchFn(url, { ...init, headers });
  if (res.status === 304 && prior) return { changed: false, buffer: prior.buffer };
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${redactUrl(url)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const raw = Buffer.from(arrayBuf);
  const buffer = isGzip(raw) ? await boundedGunzip(raw, MAX_DECOMPRESSED_BYTES) : raw;
  if (state) {
    state.conditional.set(url, {
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      buffer,
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
    body: src.bodyTemplate ? resolveUrlTemplate(src.bodyTemplate, resolvedEnv()) : undefined,
    headers: src.requestHeaders,
  };
}

/**
 * Fetches a resolved catalog URL set with bounded concurrency and per-URL tolerance:
 * a single failing sub-feed is logged and skipped rather than aborting the
 * whole batch (many registry feeds require operator-supplied keys and will
 * fail). Throws only if *every* sub-feed fails, so the caller preserves the
 * last-good rows instead of swapping in an empty set.
 */
async function fetchFanout(urls: string[], fetchFn: typeof fetch): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let failures = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const url = urls[cursor++]!;
      try {
        const { buffer } = await fetchOne(url, fetchFn);
        if (looksLikeHtml(buffer)) {
          throw new Error("returned HTML, not JSON");
        }
        out.push(buffer);
      } catch (err) {
        failures++;
        console.warn(
          `[ingest] sub-feed fetch failed (${url}):`,
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
  return out;
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
  state?: FetchState
): Promise<{ changed: boolean; buffer: Buffer }[]> {
  const out = new Array<{ changed: boolean; buffer: Buffer }>(urls.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const i = cursor++;
      out[i] = await fetchOne(urls[i]!, fetchFn, init, state);
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
 * request at once.
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
    return { status: "fetched", buffers: await fetchFanout(urls, fetchFn) };
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
  const results = await fetchAllBounded(urls, fetchFn, init, state);
  state.lastFetchAt.set(active.id, now());

  if (results.every((r) => !r.changed)) return { status: "unchanged" };
  return { status: "fetched", buffers: results.map((r) => r.buffer) };
}
