/**
 * Dynamic feed-URL discovery.
 *
 * Some sources do not expose a single static URL but an index that has to be
 * pulled first to learn the concrete set of URLs to fetch:
 *  - the Autobahn API lists every motorway, each served at its own per-service
 *    endpoint;
 *  - the WZDx feed registry catalogs every US work-zone feed.
 *
 * A `discover` function pulls that index and returns the concrete URLs. The
 * ingest service fans those out with bounded concurrency and per-URL tolerance,
 * so a single failing sub-feed never wipes the source.
 */

const AUTOBAHN_BASE = "https://verkehr.autobahn.de/o/autobahn";

/**
 * Services enumerated per motorway. Warnings and closures are the high-signal
 * road conditions. The `roadworks` service is a high-volume planned-works
 * firehose (hundreds of items per road), so it is intentionally left out here;
 * add it to this list to enable it.
 */
const AUTOBAHN_DISCOVER_SERVICES = ["warning", "closure"] as const;

interface AutobahnIndex {
  roads?: unknown;
}

/**
 * Pulls the Autobahn road index and returns one URL per (road × service) for
 * the high-signal services. Road names are trimmed (the upstream list contains
 * stray whitespace, e.g. `"A60 "`) and deduped before enumeration.
 */
export async function discoverAutobahnRoads(fetchFn: typeof fetch): Promise<string[]> {
  const res = await fetchFn(`${AUTOBAHN_BASE}/`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching the Autobahn road index`);
  }

  const data = (await res.json()) as AutobahnIndex;
  const rawRoads = Array.isArray(data.roads) ? data.roads : [];

  const roads = new Set<string>();
  for (const raw of rawRoads) {
    if (typeof raw !== "string") continue;
    const road = raw.trim();
    if (road) roads.add(road);
  }

  const urls: string[] = [];
  for (const road of roads) {
    const id = encodeURIComponent(road);
    for (const service of AUTOBAHN_DISCOVER_SERVICES) {
      urls.push(`${AUTOBAHN_BASE}/${id}/services/${service}`);
    }
  }
  return urls;
}

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

/**
 * Pulls the WZDx feed registry and returns the URLs of feeds the WZDx v4.x
 * parser understands: active, GeoJSON-format, version 4.x. Older versions and
 * the CWZ standard use a different shape and are skipped. Deduped.
 *
 * Many registered feeds require an API key the operator must supply; those will
 * fail at fetch time and are tolerated by the fan-out (logged + skipped).
 */
export async function discoverWzdxFeeds(
  fetchFn: typeof fetch,
  registryUrl: string = WZDX_REGISTRY_URL
): Promise<string[]> {
  const res = await fetchFn(registryUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching the WZDx feed registry`);
  }

  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) return [];

  const urls = new Set<string>();
  let placeholderSkipped = 0;
  for (const row of rows as WzdxRegistryRow[]) {
    if (!isActive(row.active)) continue;
    if (
      String(row.format ?? "")
        .trim()
        .toLowerCase() !== "geojson"
    )
      continue;
    if (
      !String(row.version ?? "")
        .trim()
        .startsWith("4")
    )
      continue;
    const url = extractUrl(row.url);
    if (!url) continue;
    if (hasUnfilledKeyPlaceholder(url)) {
      placeholderSkipped++;
      continue;
    }
    urls.add(url);
  }
  if (placeholderSkipped > 0) {
    console.info(
      `[wzdx] skipped ${placeholderSkipped} registry feed(s) with an unfilled API-key placeholder`
    );
  }
  return [...urls];
}
