import path from "node:path";
import type { CatalogResolver, FeedSourceBase } from "@openconditions/ingest-framework";
import wzdxSnapshot from "./snapshots/wzdx-registry.json" with { type: "json" };

const WZDX_REGISTRY_URL = "https://datahub.transportation.gov/resource/69qe-yiui.json?$limit=5000";

// Many registry entries for keyed feeds carry an unfilled credential placeholder
// in the URL instead of a real key. Requesting those just 401s/403s every cycle
// and can't work without per-agency keys we don't have, so drop them up front
// rather than fan them out. Three shapes occur in the wild:
//   1. a literal "fill me in" token — ?api_key=INSERT-API-KEY-HERE,
//      ?apiKey=[Your-API-Key-Here], or a path segment like /<key>/...
//   2. the same token percent-encoded — ?key=%3ckey%3e  (decodes to <key>)
//   3. an empty credential param — ?api_key= , ?key= , ?apiKey=
// (1) and (2) are caught by matching the URL-*decoded* form against the
// placeholder pattern; (3) by an empty key/token/secret query param.
const PLACEHOLDER_KEY_RE =
  /[<>[\]{}]|INSERT[-_ ]?API|API[-_ ]?KEY[-_ ]?HERE|YOUR[-_ ]?(API[-_ ]?)?KEY|REPLACE[-_ ]?(ME|WITH)|X{5,}/i;

// A credential-bearing query param (name ends in key/token/secret) with an empty
// value: ?api_key= , &key= , ?subscription-key=&foo=… .
const EMPTY_KEY_PARAM_RE = /[?&][\w.-]*(?:key|token|secret)=(?=$|&)/i;

/** decodeURIComponent that never throws on a malformed `%` sequence. */
function decodeUrlSafe(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** True when the URL still carries an unfilled API-key placeholder (any of the three shapes above). */
function hasUnfilledKeyPlaceholder(url: string): boolean {
  return PLACEHOLDER_KEY_RE.test(decodeUrlSafe(url)) || EMPTY_KEY_PARAM_RE.test(url);
}

interface WzdxRegistryRow {
  active?: unknown;
  format?: unknown;
  version?: unknown;
  url?: unknown;
  feedname?: unknown;
  state?: unknown;
  issuingorganization?: unknown;
  needapikey?: unknown;
  apikeyurl?: unknown;
}

function isActive(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw.trim().toLowerCase() === "true";
  return false;
}

/** The registry's `url` column is a Socrata URL object (`{ url }`); tolerate a plain string too. */
function extractUrl(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (raw && typeof raw === "object" && "url" in raw) {
    const u = (raw as { url?: unknown }).url;
    if (typeof u === "string") return u.trim() || undefined;
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function needsApiKey(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = str(v).toLowerCase();
  return s === "yes" || s === "true";
}

/**
 * Maps each Socrata WZDx registry row to a full feed descriptor for feeds the
 * WZDx v4.x parser understands: active, GeoJSON-format, version 4.x. Older
 * versions and the CWZ standard use a different shape and are skipped. Deduped by
 * URL and by generated id. Rows whose URL is an unfilled key placeholder are
 * dropped (they can only 401 without a key we don't hold).
 */
async function resolve(fetchFn: typeof fetch): Promise<FeedSourceBase[]> {
  const res = await fetchFn(WZDX_REGISTRY_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the WZDx feed registry`);

  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) return [];

  const feeds: FeedSourceBase[] = [];
  const seenUrls = new Set<string>();
  const seenIds = new Set<string>();
  let placeholderSkipped = 0;

  for (const row of rows as WzdxRegistryRow[]) {
    if (!isActive(row.active)) continue;
    if (str(row.format).toLowerCase() !== "geojson") continue;
    if (!str(row.version).startsWith("4")) continue;
    const url = extractUrl(row.url);
    if (!url) continue;
    if (hasUnfilledKeyPlaceholder(url)) {
      placeholderSkipped++;
      continue;
    }
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const state = str(row.state);
    const feedname = str(row.feedname);
    const org = str(row.issuingorganization);
    let id = `wzdx-${slug(state || feedname || url)}`;
    let n = 1;
    while (seenIds.has(id)) id = `wzdx-${slug(state || feedname || url)}-${++n}`;
    seenIds.add(id);

    const apikeyurl = str(row.apikeyurl);
    const feed: FeedSourceBase = {
      id,
      name: `WZDx — ${org || feedname || state || "feed"}${state ? ` (${state})` : ""}`,
      format: "wzdx",
      url,
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: org || "WZDx publishers",
      country: "US",
      privacyUrl: "https://www.transportation.gov/privacy",
      enabledByDefault: true,
    };
    if (needsApiKey(row.needapikey)) {
      // The concrete URL is used as published (placeholder rows are dropped
      // above); attach a documentation-only guide pointing operators at where a
      // registered key can be obtained.
      feed.auth = { kind: "none" };
      const envVar = `WZDX_${(state || feedname || "US").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
      feed.setup = {
        [envVar]: {
          title: `${feed.name} — API key`,
          ...(apikeyurl ? { url: apikeyurl } : {}),
          notes:
            "This registry feed is marked as needing an API key. The registry URL is used as published; supply a registered key upstream if the feed requires one.",
        },
      };
    }
    feeds.push(feed);
  }

  if (placeholderSkipped > 0) {
    console.info(
      `[wzdx] skipped ${placeholderSkipped} registry feed(s) with an unfilled API-key placeholder`
    );
  }
  return feeds;
}

export const wzdxRegistryResolver: CatalogResolver = {
  id: "wzdx-registry",
  snapshotPath: path.resolve(import.meta.dirname, "snapshots/wzdx-registry.json"),
  snapshot: wzdxSnapshot as FeedSourceBase[],
  resolve,
};
