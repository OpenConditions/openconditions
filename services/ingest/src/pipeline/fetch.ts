import { gunzipSync } from "node:zlib";
import type { FeedSource } from "@openconditions/roads";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

async function fetchOne(url: string, fetchFn: typeof fetch): Promise<Buffer> {
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const raw = Buffer.from(arrayBuf);
  return isGzip(raw) ? gunzipSync(raw) : raw;
}

/**
 * Resolves the URL(s) for a feed source and fetches each one, returning
 * an array of decoded Buffers (gunzipped transparently when the response
 * bytes start with the gzip magic bytes 0x1f 0x8b).
 *
 * `src.url` may be a static string, a string array, or a function that
 * receives `process.env` and returns a string.
 */
export async function fetchAll(src: FeedSource, fetchFn: typeof fetch): Promise<Buffer[]> {
  const urlOrFn = src.url;

  if (typeof urlOrFn === "function") {
    const resolved = urlOrFn(process.env as Record<string, string | undefined>);
    return [await fetchOne(resolved, fetchFn)];
  }

  if (Array.isArray(urlOrFn)) {
    return Promise.all(urlOrFn.map((u) => fetchOne(u, fetchFn)));
  }

  return [await fetchOne(urlOrFn, fetchFn)];
}
