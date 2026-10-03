import type { Readable } from "node:stream";
import {
  defineIngestDomain,
  type EndpointRole,
  emptyParseOutput,
  type FeedFormat,
  type IngestDomain,
  maxFeedBytes,
  type ParseContext,
  type ParseOutput,
  type StreamingParse,
} from "@openconditions/ingest-framework";
import { autobahnIndexResolver, wzdxRegistryResolver } from "./catalog/index.js";
import { type RoadFeed, roadsFeedShape } from "./feed-schema.js";
import type { FlowContext, FlowOutput, FlowSites } from "./flow-output.js";
import type { FlowFormatCode } from "./flow-parsers.js";
import { measuredDataReader, parseEvents, parseFlows, type SituationFormatCode } from "./parse.js";

/** What a roads feed publishes: situations, conditions, or measured traffic flow. */
export const ROAD_PRODUCTS = ["events", "conditions", "flow"] as const;

/**
 * The decoders of roads reference data: DATEX site tables and predefined
 * locations, and the station registries of the flow feeds keyed by station id.
 */
export const ROAD_REFERENCE_DECODERS = [
  "datex2-sites",
  "datex2-locations",
  "fintraffic-stations",
  "webtris-sites",
  "miv-config",
  "france-comptage-csv",
  "hk-detector-csv",
  "bcn-trams-csv",
] as const;

export type RoadReferenceDecoder = (typeof ROAD_REFERENCE_DECODERS)[number];

const MAIN: EndpointRole = { required: true };

function situations(id: SituationFormatCode): FeedFormat<RoadFeed> {
  return {
    id,
    kind: "situations",
    products: ["events", "conditions"],
    endpoints: { main: MAIN },
    parse: (feed, payloads, ctx) =>
      parseEvents(feed, payloads["main"] ?? [], { fetchedAt: ctx.fetchedAt }),
  };
}

const flowContext = (ctx: ParseContext): FlowContext => ({
  now: ctx.fetchedAt,
  cadenceSec: ctx.cadenceSec,
});

const sitesOf = (ctx: ParseContext) => ctx.reference["sites"] as FlowSites | undefined;

/** A poll's flow drafts as a parse output: flow carries no offers. */
function flowParseOutput(flow: FlowOutput): ParseOutput {
  return { ...emptyParseOutput(), ...flow };
}

/**
 * A measurement format. `sites` names the decoders of its site table or
 * station registry, and is required when the parser cannot place a reading
 * without it (the payload names sites by id only); a format whose payload
 * carries its own geometry reads no reference data.
 */
function measurements(
  id: FlowFormatCode,
  sites?: { required: boolean; decoders: readonly RoadReferenceDecoder[] },
  stream?: StreamingParse<RoadFeed>,
): FeedFormat<RoadFeed> {
  return {
    id,
    kind: "measurements",
    products: ["flow"],
    endpoints: sites ? { main: MAIN, sites } : { main: MAIN },
    parse: (feed, payloads, ctx) => {
      const out = emptyParseOutput();
      for (const payload of payloads["main"] ?? []) {
        const flow = parseFlows(feed, payload, sitesOf(ctx), flowContext(ctx));
        out.features.push(...flow.features);
        out.observations.push(...flow.observations);
        out.situations.push(...flow.situations);
      }
      return out;
    },
    ...(stream ? { stream } : {}),
  };
}

/** Ceiling on a streamed document's decoded bytes; matches the guard's byte cap. */
const MAX_DECODED_BYTES = maxFeedBytes();

/**
 * Streams a DATEX II MeasuredData document (NDW's ~50 MB trafficspeed feed
 * recurs every minute) through the SAX flow parser, so the document is never
 * buffered whole nor held as a DOM: peak memory is the drafts plus a small
 * per-site accumulator. The body passes through the tee on its way, which
 * digests it (the same identity a buffered fetch gives it) and keeps it when
 * the whole document arrived, even if the parser then rejects it. Throws on a
 * truncated or unreadable document, so the last good publication stands.
 */
const measuredDataStream: StreamingParse<RoadFeed> = {
  async read(feed, input, ctx) {
    const reader = measuredDataReader(feed, sitesOf(ctx), flowContext(ctx));
    // The tee opens before the download starts: a stream that errors while the
    // tee is still being opened would have no listener yet.
    const { tee, finish } = await input.tee();
    let body: Readable;
    try {
      body = await input.open();
    } catch (err) {
      await finish(false);
      throw err;
    }
    body.on("error", (err) => tee.destroy(err));
    body.pipe(tee);
    let complete = false;
    try {
      let decoded = 0;
      for await (const chunk of tee) {
        decoded += (chunk as Buffer).length;
        if (decoded > MAX_DECODED_BYTES) {
          body.destroy();
          tee.destroy();
          throw new Error(`decoded stream exceeded ${MAX_DECODED_BYTES} bytes`);
        }
        reader.write(chunk as Buffer);
      }
      complete = true;
    } finally {
      body.destroy();
      await finish(complete);
    }
    const { failed, ...flow } = reader.close();
    if (failed) {
      throw new Error(`streaming parse failed for source ${feed.id} (partial/truncated document)`);
    }
    return { output: flowParseOutput(flow), payload: tee.digest() };
  },
};

const FORMATS: FeedFormat<RoadFeed>[] = [
  situations("datex2"),
  situations("open511"),
  situations("wzdx"),
  situations("geojson"),
  situations("ibi511"),
  situations("ibi511-conditions"),
  situations("lta"),
  situations("gddkia"),
  situations("flatjson"),
  situations("trafikverket"),
  situations("autobahn"),
  situations("digitraffic"),
  situations("ohgo-events"),
  situations("vic-disruptions"),
  measurements(
    "datex2-measured",
    { required: false, decoders: ["datex2-sites", "france-comptage-csv"] },
    measuredDataStream,
  ),
  measurements("datex2-elaborated", { required: false, decoders: ["datex2-locations"] }),
  measurements("fintraffic-tms", { required: true, decoders: ["fintraffic-stations"] }),
  measurements("webtris", { required: true, decoders: ["webtris-sites"] }),
  measurements("nyc-dot"),
  measurements("ohgo"),
  measurements("trafikverket-flow"),
  measurements("bonn"),
  measurements("informo"),
  measurements("lta-speedbands"),
  measurements("miv", { required: true, decoders: ["miv-config"] }),
  measurements("fdt"),
  measurements("hk-td", { required: true, decoders: ["hk-detector-csv"] }),
  measurements("geojson-flow"),
  measurements("bcn-trams", { required: true, decoders: ["bcn-trams-csv"] }),
  measurements("digitraffic-traffic-measurement"),
];

/**
 * The roads domain: road situations and conditions (DATEX II, WZDx, Open511
 * and the national formats) and measured traffic flow, with the Autobahn and
 * WZDx catalogue resolvers.
 */
export const roadsDomain: IngestDomain<RoadFeed> = defineIngestDomain<RoadFeed>({
  id: "roads",
  products: ROAD_PRODUCTS,
  feedShape: roadsFeedShape,
  formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
  resolvers: [autobahnIndexResolver, wzdxRegistryResolver],
});
