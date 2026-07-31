/**
 * TMC location tables available to the parsers.
 *
 * Only tables under a licence that permits redistribution are vendored here.
 * Germany's LCL 22.0 qualifies (CC BY 4.0); other countries' tables are usually
 * restricted, so a feed referencing one resolves to `no-table` and its records
 * stay counted as unmapped rather than being placed by guesswork.
 */

import { fromSnapshot, type TmcLocationTable, type TmcTableSnapshot } from "./lcl.js";
import lclDe from "./snapshots/lcl-de.json" with { type: "json" };

export * from "./lcl.js";
export * from "./resolve.js";

let cached: TmcLocationTable[] | undefined;

/**
 * The vendored tables, built on first use.
 *
 * Deferred because the German table alone is ~38k entries: processes that never
 * see an Alert-C record should not pay for it.
 */
export function tmcTables(): TmcLocationTable[] {
  cached ??= [fromSnapshot(lclDe as unknown as TmcTableSnapshot)];
  return cached;
}
