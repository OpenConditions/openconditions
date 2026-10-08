import type { Readable } from "node:stream";
import type { ZodRawShape } from "zod";
import type { ParseOutput, StatusIndex, StatusOutput } from "../parse-output.js";
import type { DigestTee, PayloadDigest } from "../payload.js";
import type { Cell } from "./cells.js";
import type { CatalogResolver } from "./resolvers.js";
import type { CatalogFeed, FeedDefinition } from "./types.js";

/**
 * One endpoint role a format reads. A role with `decoders` holds reference data
 * (a site table, a station registry) that one of those decoders reads; a role
 * without is a payload the format parses itself.
 */
export interface EndpointRole {
  /**
   * Whether a poll needs the role: an optional role that fails with nothing
   * held leaves the poll to go on without it.
   */
  required: boolean;
  decoders?: readonly string[];
  /**
   * A role whose answers hold only the changes since the previous one, over
   * the snapshot the named role holds: a poll parses every answer since that
   * role's last fetch, oldest first, and a fresh snapshot starts them anew.
   */
  accumulatesSince?: string;
  /**
   * How far back an answer of changes reaches (the publisher's window): a
   * role failing for longer has missed changes, so its snapshot is fetched
   * afresh. Unset, any failure is such a gap.
   */
  changesWindowSec?: number;
  /**
   * A role of live states only, of what the other data roles describe: a
   * poll that fetches no other role reads it through the format's
   * `parseStatus`, without the snapshot.
   */
  status?: boolean;
}

/** Role → the payloads of that role's latest fetch. */
export type FeedPayloads = Readonly<Record<string, readonly Buffer[]>>;

export interface ParseContext {
  /** When the poll fetched its payloads (ISO instant); dates readings the source leaves undated. */
  fetchedAt: string;
  cadenceSec: number;
  /** Decoded reference data by role. */
  reference: Readonly<Record<string, unknown>>;
  /**
   * The grid cell an on-demand read fetched the payloads for: a source whose
   * answer reaches past the cell's edges keeps only what lies inside it.
   */
  cell?: Cell;
}

/**
 * A digesting tee for one streamed body and what to do when the stream ends:
 * keep what passed through (`ok`, e.g. archive it as a raw payload), or drop it
 * (a failed attempt, which a retry replaces with a fresh tee).
 */
export interface StreamTee {
  tee: DigestTee;
  finish(ok: boolean): Promise<void>;
}

/** One attempt at streaming a feed's main endpoint, as the caller opened it. */
export interface StreamInput {
  /** The endpoint URL with credentials scrubbed: what logs and the payload digest name. */
  url: string;
  /** Opens the response body, already gunzipped when the endpoint is `gzip`. */
  open(): Promise<Readable>;
  /** A fresh tee for the decoded body: its digest is the poll's payload identity. */
  tee(): Promise<StreamTee>;
}

/**
 * A format whose payload is too large to buffer: it reads the main endpoint's
 * body as a stream (through the tee, for the digest and raw archive) and
 * returns what the buffered `parse` would, plus the payload's digest. Throws
 * on a truncated or unreadable document so the last good publication stands.
 */
export interface StreamingParse<F extends CatalogFeed = CatalogFeed> {
  read(
    feed: F,
    input: StreamInput,
    ctx: ParseContext,
  ): Promise<{ output: ParseOutput; payload: PayloadDigest }>;
}

/** How a domain reads one feed format. */
export interface FeedFormat<F extends CatalogFeed = CatalogFeed> {
  id: string;
  kind: "situations" | "measurements" | "features";
  /** The products a feed of this format may carry. */
  products: readonly string[];
  /** The feature and offer kinds and the properties the format emits, which on-demand routing reads. */
  produces?: { kinds: readonly string[]; properties: readonly string[] };
  endpoints: Readonly<Record<string, EndpointRole>>;
  /** One poll's payloads as record drafts; throws when a payload cannot be read. */
  parse(feed: F, payloads: FeedPayloads, ctx: ParseContext): ParseOutput;
  /**
   * The readings the full parse would give the status records of `payloads`
   * (its `status` roles only), placed through the index the last full parse
   * returned; a record the index does not name is rejected. No features, no
   * offers.
   */
  parseStatus?(
    feed: F,
    payloads: FeedPayloads,
    ctx: ParseContext,
    index: StatusIndex,
  ): StatusOutput;
  stream?: StreamingParse<F>;
}

/**
 * A domain plugin (roads, transit, places, …): its product list, the feed fields
 * it adds to the base shape, its formats by code and its catalogue resolvers.
 */
export interface IngestDomain<F extends CatalogFeed = CatalogFeed> {
  id: string;
  products: readonly string[];
  feedShape: ZodRawShape;
  formats: Readonly<Record<string, FeedFormat<F>>>;
  resolvers: readonly CatalogResolver[];
  /**
   * The domain's own checks of one feed as its region file writes it, beyond
   * what the feed shape can say (a field a format needs); one message per
   * issue, each an error of the catalogue lint.
   */
  lintFeed?(feed: FeedDefinition): string[];
}

/**
 * Checks a domain's internal consistency and returns it unchanged: it names at
 * least one product, every format serves only the domain's products, and no two
 * resolvers share an id.
 */
export function defineIngestDomain<F extends CatalogFeed>(d: IngestDomain<F>): IngestDomain<F> {
  if (d.products.length === 0) throw new Error(`domain ${d.id} names no product`);
  for (const [code, format] of Object.entries(d.formats)) {
    for (const product of format.products) {
      if (!d.products.includes(product)) {
        throw new Error(
          `domain ${d.id}: format ${code} serves product ${product}, which the domain lacks`,
        );
      }
    }
  }
  const seen = new Set<string>();
  for (const resolver of d.resolvers) {
    if (seen.has(resolver.id)) {
      throw new Error(`domain ${d.id}: catalogue resolver ${resolver.id} is defined twice`);
    }
    seen.add(resolver.id);
  }
  return d;
}
