import type { SiteGeometry } from "./siteTable.js";

/**
 * Build a site-id → Point map from a WebTRIS sites JSON registry.
 *
 * Temporary stub: the real parser lands with the WebTRIS flow parser and
 * always returns an empty map until then, so `loadStationRegistry` can
 * register the `webtris-sites` format now without a runtime failure.
 */
export function parseWebtrisSites(_input: string | Buffer): Map<string, SiteGeometry> {
  return new Map<string, SiteGeometry>();
}
