import type { FeedSourceBase } from "./feed-source.js";
import { resolvedEnv } from "./auth.js";
import { boundedGunzip } from "./egress.js";
import { resolveFeedUrls, resolveUrlTemplate } from "./template.js";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Max sub-feed fetches in flight when fanning out a discovered URL set. */
const FANOUT_CONCURRENCY = 8;

/**
 * `FeedSourceBase` carries the declarative transport fields (`url` template(s),
 * `expandEnv`, `bodyTemplate`). `discover` is still declared by
 * `@openconditions/roads`' `FeedSource` today and is removed by the later catalog
 * work; widen locally for it so the framework needn't depend on roads.
 */
type FetchableFeed = FeedSourceBase & {
  discover?: (fetchFn: typeof fetch) => Promise<string[]>;
};

function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

// First non-whitespace char is '<' → an HTML/XML block/login/error page, not the
// JSON the fanned-out (discovered) feeds serve. Only applied on the fan-out path;
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

async function fetchOne(url: string, fetchFn: typeof fetch, init?: RequestInit): Promise<Buffer> {
  const res = await fetchFn(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${redactUrl(url)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const raw = Buffer.from(arrayBuf);
  return isGzip(raw) ? await boundedGunzip(raw, MAX_DECOMPRESSED_BYTES) : raw;
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
 * Fetches a discovered URL set with bounded concurrency and per-URL tolerance:
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
        const buf = await fetchOne(url, fetchFn);
        if (looksLikeHtml(buf)) {
          throw new Error("returned HTML, not JSON");
        }
        out.push(buf);
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
 * Fetches every url with bounded concurrency, preserving order. Unlike the
 * tolerant discover fan-out, a single failure rejects the whole batch (matching
 * the prior Promise.all semantics for static feed URL sets).
 */
async function fetchAllBounded(
  urls: string[],
  fetchFn: typeof fetch,
  init: RequestInit | undefined
): Promise<Buffer[]> {
  const out: Buffer[] = new Array<Buffer>(urls.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const i = cursor++;
      out[i] = await fetchOne(urls[i]!, fetchFn, init);
    }
  }
  const workerCount = Math.min(FANOUT_CONCURRENCY, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

/**
 * Resolves the URL(s) for a feed source and fetches each one, returning
 * an array of decoded Buffers (gunzipped transparently when the response
 * bytes start with the gzip magic bytes 0x1f 0x8b).
 *
 * `src.discover`, when present, resolves the URL set dynamically and is fanned
 * out tolerantly (takes precedence over `src.url`). Otherwise `src.url` is a
 * `${VAR}` template string or array of templates; `expandEnv` fans one template
 * out over a comma-separated env var (one client-pull URL per Mobilithek
 * subscription id). Multi-URL sets fetch with bounded concurrency so a large
 * resolved URL set cannot fire every request at once.
 */
export async function fetchAll(src: FetchableFeed, fetchFn: typeof fetch): Promise<Buffer[]> {
  if (typeof src.discover === "function") {
    const urls = await src.discover(fetchFn);
    return fetchFanout(urls, fetchFn);
  }

  const urls = resolveFeedUrls(src, resolvedEnv());
  if (urls.length === 0) {
    if (src.url == null) throw new Error(`feed ${src.id} has neither url nor discover`);
    return []; // expandEnv configured but no items yet — a dormant, uncredentialed feed
  }

  const init = requestInit(src);
  return fetchAllBounded(urls, fetchFn, init);
}
