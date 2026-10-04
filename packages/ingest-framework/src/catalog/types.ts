import type { z } from "zod";
import type { credentialFieldSchema, endpointSchema, feedBaseShape } from "./schema.js";
import type { EffectiveRights } from "./terms.js";

export type FeedDefinition = z.input<z.ZodObject<typeof feedBaseShape>>;
export type FeedEndpoint = z.input<typeof endpointSchema>;
export type CredentialField = z.input<typeof credentialFieldSchema>;

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
  /** The written homepage, else the origin of the first data endpoint; never carries a credential. */
  homepage: string;
  /** Withheld from the public scope; see `isRestricted`. */
  restricted: boolean;
  coverage: { countries?: string[]; bbox?: [number, number, number, number] };
  /** The smallest `cadenceSec` over endpoints without a decoder. */
  cadenceSec: number;
  /**
   * The shared fields the feed reads, by ref (`@overpass.url`), as
   * `credentials.jsonc` declares them: where a shared field's `default` and
   * `optional` come from.
   */
  sharedFields?: Readonly<Record<string, CredentialField>>;
  /**
   * The shared refs the feed reads that are instance settings, fields of a
   * group of settings (`isSettingsGroup`): base URLs, filled as such.
   */
  settingRefs?: readonly string[];
  parentSourceId?: string;
  policyIds?: string[];
  selectionState?: "approved" | "discovered";
}
