import { gunzipSync } from "node:zlib";
import type { FeedSource } from "@openconditions/roads";
import { resolvedEnv } from "./auth.js";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Max sub-feed fetches in flight when fanning out a discovered URL set. */
const FANOUT_CONCURRENCY = 8;

function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

// First non-whitespace char is '<' → an HTML/XML block/login/error page, not the
// JSON the fanned-out (discovered) feeds serve. Only applied on the fan-out path;
// XML feeds like NDW go through the single-URL path and are never checked here.
function looksLikeHtml(buf: Buffer): boolean {
  return buf.subarray(0, 64).toString("utf8").trimStart().startsWith("<");
}

async function fetchOne(url: string, fetchFn: typeof fetch, init?: RequestInit): Promise<Buffer> {
  const res = await fetchFn(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const raw = Buffer.from(arrayBuf);
  return isGzip(raw) ? gunzipSync(raw) : raw;
}

/** Build the RequestInit for a feed: POST + body + headers when configured. */
function requestInit(src: FeedSource): RequestInit | undefined {
  if (src.method !== "POST") {
    return src.requestHeaders ? { headers: src.requestHeaders } : undefined;
  }
  return {
    method: "POST",
    body: src.body ? src.body(resolvedEnv()) : undefined,
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
 * Resolves the URL(s) for a feed source and fetches each one, returning
 * an array of decoded Buffers (gunzipped transparently when the response
 * bytes start with the gzip magic bytes 0x1f 0x8b).
 *
 * `src.discover`, when present, resolves the URL set dynamically and is fanned
 * out tolerantly (takes precedence over `src.url`). Otherwise `src.url` may be
 * a static string, a string array, or a function that receives `process.env`
 * and returns a string.
 */
export async function fetchAll(src: FeedSource, fetchFn: typeof fetch): Promise<Buffer[]> {
  if (typeof src.discover === "function") {
    const urls = await src.discover(fetchFn);
    return fetchFanout(urls, fetchFn);
  }

  const urlOrFn = src.url;

  if (urlOrFn == null) {
    throw new Error(`feed ${src.id} has neither url nor discover`);
  }

  const init = requestInit(src);

  if (typeof urlOrFn === "function") {
    const resolved = urlOrFn(resolvedEnv());
    return [await fetchOne(resolved, fetchFn, init)];
  }

  if (Array.isArray(urlOrFn)) {
    return Promise.all(urlOrFn.map((u) => fetchOne(u, fetchFn, init)));
  }

  return [await fetchOne(urlOrFn, fetchFn, init)];
}
