import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { maxFeedBytes, type StreamTee } from "@openconditions/ingest-framework";
import type { FlowSites, SiteTableParser } from "@openconditions/roads";
import { createPredefinedLocationsParser, createSiteTableParser } from "@openconditions/roads";
import type { StreamTeeFactory } from "../raw/stream-tee.js";
import type { BodyStreamFactory } from "./body-stream.js";
import { withStreamRetry } from "./stream-retry.js";

/** Ceiling on a single site table's decompressed bytes; matches the guard's byte cap. */
const MAX_DECOMPRESSED_BYTES = maxFeedBytes();

/** The streaming parsers of the DATEX reference decoders, by decoder. */
const SITE_TABLE_PARSERS: Readonly<Record<string, () => SiteTableParser>> = {
  "datex2-sites": createSiteTableParser,
  "datex2-locations": createPredefinedLocationsParser,
};

/** Whether `decoder` reads a DATEX site table (or predefined locations) as a stream. */
export function isSiteTableDecoder(decoder: string): boolean {
  return Object.hasOwn(SITE_TABLE_PARSERS, decoder);
}

/**
 * Streams a chunked, possibly-gzipped XML stream through the incremental
 * site-table parser. Memory stays bounded to the output Map plus the small SAX
 * accumulators — the source bytes flow through gunzip → SAX and are discarded.
 */
async function streamIntoParser(
  source: Readable,
  gzip: boolean,
  makeParser: () => SiteTableParser,
  { tee, finish }: StreamTee,
): Promise<FlowSites> {
  const parser = makeParser();
  // `.pipe()` does not forward the source's errors to the gunzip stream, so a
  // mid-stream socket drop on the (multi-hundred-MB) download would surface as an
  // unhandled 'error' event and crash the process. Forward it so the loop rejects
  // and the caller turns it into a logged fall-back to the cached map; destroy
  // `source` on the way out so a half-read connection never lingers.
  const decoded: Readable = gzip ? source.pipe(createGunzip()) : source;
  if (decoded !== source) source.on("error", (err) => decoded.destroy(err));
  decoded.on("error", (err) => tee.destroy(err));
  decoded.pipe(tee);
  let complete = false;
  try {
    let decompressed = 0;
    tee.setEncoding("utf8");
    for await (const chunk of tee) {
      decompressed += Buffer.byteLength(chunk as string);
      if (decompressed > MAX_DECOMPRESSED_BYTES) {
        if (decoded !== source) source.destroy();
        decoded.destroy();
        tee.destroy();
        throw new Error(`decompressed stream exceeded ${MAX_DECOMPRESSED_BYTES} bytes`);
      }
      parser.write(chunk as string);
    }
    complete = true;
  } finally {
    if (decoded !== source) source.destroy();
    await finish(complete);
  }
  return parser.close();
}

/**
 * Reads a DATEX II site table (or predefined-location table) into its sites by
 * id: geometry, name, lane count, equipment and per-index channels. The fetch →
 * gunzip → parse path is fully streaming: the 362 MB NDW site table is never
 * held in memory as a whole, only the resolved sites survive the call. A
 * transient mid-stream drop is retried with a fresh connection and parser;
 * anything else throws.
 *
 * `label` is the URL with credentials scrubbed: what the tee (and the raw
 * payload it archives) and the retry log name.
 */
export async function readSiteTable(
  url: string,
  opts: {
    decoder: string;
    label: string;
    gzip: boolean;
    init?: RequestInit;
    stream: BodyStreamFactory;
    teeFor: StreamTeeFactory;
  },
): Promise<FlowSites> {
  const makeParser = SITE_TABLE_PARSERS[opts.decoder];
  if (!makeParser) throw new Error(`no site-table parser for ${opts.decoder}`);
  return withStreamRetry(async () => {
    // The tee opens before the download starts: a stream that errors while the
    // tee is still being opened would have no listener yet.
    const tee = await opts.teeFor(opts.label);
    let source: Readable;
    try {
      source = await opts.stream(url, opts.init);
    } catch (err) {
      await tee.finish(false);
      throw err;
    }
    return streamIntoParser(source, opts.gzip, makeParser, tee);
  }, `${opts.label} site-table`);
}
