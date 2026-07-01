import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { Observation } from "@openconditions/core";
import { createMeasuredDataParser, feedToSourceDescriptor } from "@openconditions/roads";
import type { SiteGeometry } from "@openconditions/roads";
import { resolveFeedUrls, resolvedEnv } from "@openconditions/ingest-framework";
import type { DomainFeedSource } from "./run.js";
import type { SiteTableStreamFactory } from "./site-table.js";

/**
 * True for DATEX II flow feeds that must be streamed rather than buffered. The
 * NDW trafficspeed feed is ~50 MB and recurs every ~60 s; a full-DOM parse
 * balloons to several hundred MB and OOMs the memory-capped ingest. Digitraffic
 * flow is small JSON and stays on the buffered path.
 */
export function isStreamingFlowFeed(src: DomainFeedSource): boolean {
  return src.produces === "flow" && src.format === "datex2";
}

/** Ceiling on a single flow feed's decompressed bytes; matches the guard's byte cap. */
const MAX_DECOMPRESSED_BYTES = Number(
  process.env["OPENCONDITIONS_MAX_FEED_BYTES"] || 256 * 1024 * 1024
);

/** Resolves the single feed URL for a streaming flow source from its template(s). */
function resolveUrl(src: DomainFeedSource): string {
  // Streaming flow feeds are single-URL by contract; the multi-URL expandEnv
  // form (e.g. Mobilithek multi-subscription) is only used by buffered event
  // feeds, never here.
  const urls = resolveFeedUrls(src, resolvedEnv());
  if (urls.length === 1) return urls[0]!;
  if (urls.length === 0) throw new Error(`flow feed ${src.id} has no streamable url`);
  throw new Error(`flow feed ${src.id} resolved to ${urls.length} urls; expected one`);
}

/**
 * Streams a DATEX II MeasuredData (traffic-speed/flow) feed through the SAX flow
 * parser: fetch → optional gunzip → {@link createMeasuredDataParser}. The large
 * document is never buffered whole nor materialised as a DOM — peak memory is the
 * output flow/event arrays plus a small per-site accumulator. Returns the flows
 * plus any derived congestion events as Observations (all carry geometry).
 */
export async function streamMeasuredData(
  src: DomainFeedSource,
  streamFactory: SiteTableStreamFactory,
  siteMap: Map<string, SiteGeometry> | undefined,
  now: () => string
): Promise<Observation[]> {
  const descriptor = feedToSourceDescriptor(src);
  const parser = createMeasuredDataParser(descriptor, siteMap, now);

  const source = await streamFactory(resolveUrl(src));
  // `.pipe()` does not forward the source's errors to the gunzip stream, so a
  // mid-stream socket drop (the upstream closing a large download) would surface
  // as an unhandled 'error' event and crash the process. Forward it so the loop
  // below rejects and the caller turns it into a logged, recoverable skip;
  // destroy `source` on the way out so a half-read connection never lingers.
  const decoded: Readable = src.gzip ? source.pipe(createGunzip()) : source;
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

  const { flows, events } = parser.close();
  return [...flows, ...events];
}
