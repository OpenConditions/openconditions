import { Readable } from "node:stream";
import type { FetchFn } from "@openconditions/ingest-framework";

/**
 * Opens a response body as a Node stream. Injectable so a test can serve a
 * fixture (or a stream that breaks mid-way) without a network round-trip.
 */
export type BodyStreamFactory = (url: string, init?: RequestInit) => Promise<Readable>;

/**
 * A body stream factory over `fetchFn`, so the guarded, authorized fetch still
 * makes the request while the body is consumed as a stream: a large document
 * is never buffered whole. `label` names the URL in errors, with credentials
 * scrubbed.
 */
export function bodyStreamFrom(
  fetchFn: FetchFn,
  label: (url: string) => string = (url) => url,
): BodyStreamFactory {
  return async (url, init) => {
    const res = await fetchFn(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${label(url)}`);
    if (!res.body) throw new Error(`empty body fetching ${label(url)}`);
    return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  };
}
