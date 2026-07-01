import type { Observation } from "@openconditions/core";
import type { FeedSourceBase } from "./feed-source.js";

export type ParserFn = (buf: Buffer, ...rest: never[]) => unknown[];
export type FlowParserFn = (input: string | Buffer, ...rest: never[]) => unknown;

/**
 * A domain plugin: its loaded feed instances, the parser dispatch for its wire
 * formats, and the mapper from a domain observation to the JSONB attributes
 * column. Generalized from services/ingest's DomainPlugin so transit/places reuse it.
 */
export interface IngestDomain {
  name: string;
  feeds: FeedSourceBase[];
  parserFor(format: string): ParserFn;
  flowParserFor?(format: string): FlowParserFn;
  attributes(obs: Observation): Record<string, unknown>;
  feedSchema?: unknown;
}

export type DomainRegistry = Record<string, IngestDomain>;
