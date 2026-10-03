import type { z } from "zod";
import type { endpointSchema, feedBaseShape } from "./schema.js";
import type { EffectiveRights } from "./terms.js";

export type FeedDefinition = z.input<z.ZodObject<typeof feedBaseShape>>;
export type FeedEndpoint = z.input<typeof endpointSchema>;

/** The fetch a caller injects, so the egress guard and test doubles apply. */
export type FetchFn = typeof fetch;

export interface Maintainer {
  name: string;
  github: string;
}

/** A feed as the loader hands it out: the written definition plus everything derived. */
export interface CatalogFeed extends FeedDefinition {
  id: string;
  domain: string;
  region: string;
  /** Upper-case ISO 3166-1 alpha-2; absent for `eu` and `global`. */
  country?: string;
  file: string;
  maintainers: Maintainer[];
  rights: EffectiveRights;
  coverage: { countries?: string[]; bbox?: [number, number, number, number] };
  /** The smallest `cadenceSec` over endpoints without a decoder. */
  cadenceSec: number;
  parentSourceId?: string;
  policyIds?: string[];
  selectionState?: "approved" | "discovered";
}
