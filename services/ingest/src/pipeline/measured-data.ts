import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  type CatalogFeed,
  type Env,
  feedEndpoint,
  feedSecretValues,
  type ParseContext,
  type ParseOutput,
  type PayloadDigest,
  redactSecrets,
  redactUrl,
  resolveEndpointUrls,
  resolveFeedTemplate,
  type StreamingParse,
} from "@openconditions/ingest-framework";
import { digestOnlyTee, type StreamTeeFactory } from "../raw/stream-tee.js";
import type { BodyStreamFactory } from "./body-stream.js";
import { withStreamRetry } from "./stream-retry.js";

/** The single URL a streamed feed reads: its main endpoint, resolved. */
function streamUrl(feed: CatalogFeed, env: Env): string {
  const urls = resolveEndpointUrls(feed, "main", env);
  if (urls.length === 1) return urls[0]!;
  if (urls.length === 0) throw new Error(`feed ${feed.id} has no streamable url`);
  throw new Error(`feed ${feed.id} resolved to ${urls.length} urls; expected one`);
}

/** The main endpoint's request: its method, body and headers, their `${field}`s filled. */
function requestInit(feed: CatalogFeed, env: Env): RequestInit | undefined {
  const endpoint = feedEndpoint(feed, "main");
  const fill = (template: string) => resolveFeedTemplate(feed, template, env);
  const headers = endpoint.headers
    ? Object.fromEntries(Object.entries(endpoint.headers).map(([k, v]) => [k, fill(v)]))
    : undefined;
  if (endpoint.method !== "POST") return headers ? { headers } : undefined;
  return {
    method: "POST",
    ...(endpoint.body !== undefined ? { body: fill(endpoint.body) } : {}),
    ...(headers ? { headers } : {}),
  };
}

/**
 * Reads a feed whose format streams its payload (NDW's ~50 MB DATEX
 * MeasuredData document recurs every minute): the main endpoint's body is
 * opened as a stream, gunzipped when the endpoint is `gzip`, and handed to the
 * format's streaming reader, so the document is never buffered whole. A
 * transient mid-stream socket drop (NDW drops ~10% of these downloads) is
 * re-fetched and re-parsed from scratch, with a fresh connection and a fresh
 * tee each attempt; anything else throws, so the last good publication stands.
 */
export async function streamFeed(
  feed: CatalogFeed,
  stream: StreamingParse,
  open: BodyStreamFactory,
  ctx: ParseContext,
  teeFor: StreamTeeFactory = digestOnlyTee,
  env: Env = process.env,
): Promise<{ output: ParseOutput; payload: PayloadDigest }> {
  const url = streamUrl(feed, env);
  const label = redactSecrets(redactUrl(url), feedSecretValues(feed, env));
  const init = requestInit(feed, env);
  const gzip = feedEndpoint(feed, "main").gzip ?? false;
  return withStreamRetry(
    () =>
      stream.read(
        feed,
        {
          url: label,
          open: async () => {
            const source = await open(url, init);
            if (!gzip) return source;
            // `.pipe()` does not forward the source's errors to the gunzip
            // stream, so a mid-stream socket drop would surface as an unhandled
            // 'error' event and crash the process. Forward it so the reader
            // rejects, and release the connection when the gunzip ends early.
            const decoded: Readable = source.pipe(createGunzip());
            source.on("error", (err) => decoded.destroy(err));
            decoded.on("close", () => source.destroy());
            return decoded;
          },
          tee: () => teeFor(label),
        },
        ctx,
      ),
    feed.id,
  );
}
