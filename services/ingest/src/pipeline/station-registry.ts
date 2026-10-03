import type { FetchFn } from "@openconditions/ingest-framework";
import type { FlowSites } from "@openconditions/roads";
import {
  parseBcnTramsStations,
  parseFintrafficStations,
  parseFranceComptageStations,
  parseHkDetectors,
  parseMivConfig,
  parseWebtrisSites,
} from "@openconditions/roads";
import type { StreamTeeFactory } from "../raw/stream-tee.js";
import { bodyStreamFrom } from "./body-stream.js";

/** The parsers of the JSON/GeoJSON/CSV station-registry decoders, by decoder. */
const REGISTRY_PARSERS: Readonly<Record<string, (input: string) => FlowSites>> = {
  "fintraffic-stations": parseFintrafficStations,
  "webtris-sites": parseWebtrisSites,
  "miv-config": parseMivConfig,
  "france-comptage-csv": parseFranceComptageStations,
  "hk-detector-csv": parseHkDetectors,
  "bcn-trams-csv": parseBcnTramsStations,
};

/**
 * Reads a JSON/GeoJSON/CSV station registry into its sites by station id
 * (geometry, name, lane count). Fetched through the caller's egress-guarded
 * fetch, never a raw `fetch`, with the endpoint's request headers (e.g.
 * Fintraffic's `Digitraffic-User`). The body passes through the tee on its way
 * in, so the archive keeps the bytes as fetched; the parser reads them as
 * `Response.text()` would (UTF-8, a byte-order mark dropped). Throws on a
 * failed fetch or an unknown decoder.
 *
 * `label` is the URL with credentials scrubbed: what errors and the tee name.
 */
export async function readStationRegistry(
  url: string,
  opts: {
    decoder: string;
    label: string;
    init?: RequestInit;
    fetchFn: FetchFn;
    teeFor: StreamTeeFactory;
  },
): Promise<FlowSites> {
  const parse = REGISTRY_PARSERS[opts.decoder];
  if (!parse) throw new Error(`no station-registry parser for ${opts.decoder}`);
  const { tee, finish } = await opts.teeFor(opts.label);
  const chunks: Buffer[] = [];
  let complete = false;
  try {
    const body = await bodyStreamFrom(opts.fetchFn, () => opts.label)(url, opts.init);
    body.on("error", (err) => tee.destroy(err));
    body.pipe(tee);
    for await (const chunk of tee) chunks.push(chunk as Buffer);
    complete = true;
  } finally {
    await finish(complete);
  }
  return parse(new TextDecoder().decode(Buffer.concat(chunks)));
}
