import { createHash } from "node:crypto";
import path from "node:path";
import {
  type CatalogParent,
  type CatalogResolver,
  type ChildFeed,
  registryUrl,
} from "@openconditions/ingest-framework";
import { roadChildren } from "./child-schema.js";
import wzdxSnapshot from "./snapshots/wzdx-registry.json" with { type: "json" };

const RESOLVER_ID = "wzdx-registry";

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
}

/** What is known of a registry feed no one has reviewed: no licence, only where it was listed. */
const UNVERIFIED = {
  license: "NOASSERTION",
  terms: {
    note: "WZDx registry metadata (no dataset grant verified)",
    reviewedAt: "2026-09-11",
  },
} as const;

/** The licences reviewed for a registry dataset, by its URL. */
const VERIFIED_CHILD_GRANTS: Record<string, Pick<ChildFeed, "license" | "licenseUrl" | "terms">> = {
  "https://ks.carsprogram.org/carsapi_v1/api/wzdx": {
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    terms: { note: "Kansas WZDx road_event_feed_info.license", reviewedAt: "2026-09-11" },
  },
};

/**
 * A child with the licence its dataset was reviewed under, approved; or, when
 * none was, `NOASSERTION` with the registry note, discovered only. Applied to
 * the snapshot too, so a grant reviewed later needs no snapshot refresh.
 */
function withChildEvidence(child: ChildFeed): ChildFeed {
  // A grant belongs to the reviewed dataset URL, never to a state label or
  // its position in the registry (several states publish multiple feeds).
  const url = child.endpoints["main"]?.url;
  const grant = url !== undefined ? VERIFIED_CHILD_GRANTS[url] : undefined;
  const { license: _license, licenseUrl: _licenseUrl, terms: _terms, ...rest } = child;
  return {
    ...rest,
    ...(grant ?? UNVERIFIED),
    selectionState: grant ? "approved" : "discovered",
    snapshot: { completeness: "complete", recordsPath: "features" },
  };
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

/**
 * Maps each row of the Socrata WZDx registry the parent names to a child, for
 * feeds the WZDx parser understands: active, version 4.x or 3.1, labeled
 * geojson or json. Earlier
 * versions and the CWZ standard are different shapes and are skipped. A child
 * is named by a hash of its URL and deduped by URL. Rows whose URL is an
 * unfilled key placeholder are dropped (they can only 401 without a key we
 * don't hold).
 */
async function resolve(parent: CatalogParent, fetchFn: typeof fetch): Promise<ChildFeed[]> {
  const res = await fetchFn(registryUrl(parent, RESOLVER_ID));
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the WZDx feed registry`);

  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) return [];

  const children: ChildFeed[] = [];
  const seenUrls = new Set<string>();
  let placeholderSkipped = 0;

  for (const row of rows as WzdxRegistryRow[]) {
    if (!isActive(row.active)) continue;
    // Several publishers (Wisconsin, statewide Missouri) label an ordinary WZDx
    // FeatureCollection "json" rather than "geojson". The version gate is what
    // actually decides whether the v4 parser can read the body.
    const fmt = str(row.format).toLowerCase();
    if (fmt !== "geojson" && fmt !== "json") continue;
    // 3.1 is admitted because the parser lifts its flat core fields into the v4
    // shape. Earlier 3.x revisions and the CWZ standard are different shapes
    // with no adapter, so they stay out.
    const version = str(row.version);
    if (!version.startsWith("4") && !version.startsWith("3.1")) continue;
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
    // The registry has no stable dataset key: use the concrete URL so order,
    // display-name changes and multiple feeds in one state cannot swap IDs.
    const qualifier = createHash("sha256").update(url).digest("hex").slice(0, 16);

    // A row marked as needing an API key is used as published: placeholder
    // URLs are dropped above, and a concrete URL already carries its key.
    children.push(
      withChildEvidence({
        qualifier,
        name: `WZDx — ${org || feedname || state || "feed"}${state ? ` (${state})` : ""}`,
        endpoints: { main: { url, cadenceSec: 300 } },
        attribution: org || "WZDx publishers",
        selectionState: "discovered",
      }),
    );
  }

  if (placeholderSkipped > 0) {
    console.info(
      `[wzdx] skipped ${placeholderSkipped} registry feed(s) with an unfilled API-key placeholder`,
    );
  }
  return roadChildren(children);
}

export const wzdxRegistryResolver: CatalogResolver = {
  id: RESOLVER_ID,
  snapshotPath: path.resolve(import.meta.dirname, "snapshots/wzdx-registry.json"),
  snapshot: roadChildren(wzdxSnapshot).map(withChildEvidence),
  resolve,
};
