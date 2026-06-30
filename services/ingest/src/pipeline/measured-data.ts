import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { Observation } from "@openconditions/core";
import { createMeasuredDataParser, feedToSourceDescriptor } from "@openconditions/roads";
import type { SiteGeometry } from "@openconditions/roads";
import { resolvedEnv } from "./auth.js";
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

/** Resolves the single feed URL for a streaming flow source (string or env fn). */
function resolveUrl(src: DomainFeedSource): string {
  const u = src.url;
  const resolved = typeof u === "function" ? u(resolvedEnv()) : u;
  // Streaming flow feeds are single-URL by contract; the array-returning
  // function form (e.g. Mobilithek multi-subscription) is only used by buffered
  // event feeds, never here.
  if (Array.isArray(resolved)) {
    if (resolved.length === 1) return resolved[0]!;
    throw new Error(`flow feed ${src.id} resolved to ${resolved.length} urls; expected one`);
  }
  if (typeof resolved === "string") return resolved;
  throw new Error(`flow feed ${src.id} has no streamable url`);
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
  const decoded: Readable = src.gzip ? source.pipe(createGunzip()) : source;
  decoded.setEncoding("utf8");
  for await (const chunk of decoded) {
    parser.write(chunk as string);
  }

  const { flows, events } = parser.close();
  return [...flows, ...events];
}
