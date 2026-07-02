import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import JSON5 from "json5";
import type { ZodTypeAny } from "zod";
import { assertPublicUrl, guardedFetch } from "./egress.js";
import { loadFeedFiles } from "./load-feeds.js";
import { feedSchemaFor } from "./feed-schema-registry.js";
import type { FeedSourceBase } from "./feed-source.js";

export interface LoadFeedsOptions {
  domain: string;
  bakedInDir: string;
  mountDir?: string;
  remote?: { url: string; enabled: boolean; snapshotPath: string };
}

export interface LoadFeedsDeps {
  /** Guarded fetch used for remote-pull; defaults to the egress guard over global fetch. */
  remoteFetch?: typeof fetch;
  /** URL guard; defaults to assertPublicUrl. Injectable so tests stay hermetic. */
  assertUrl?: (url: string) => void;
  now?: () => number;
}

// Caps for the remote atlas bundle: small, declarative-only JSON. The atlas is a
// list of feed descriptors, not a data feed, so a few MB is generous.
const REMOTE_MAX_BYTES = 5_000_000;
const REMOTE_TIMEOUT_MS = 15_000;
const REMOTE_MAX_REDIRECTS = 3;

/**
 * Loads a domain's feed set from three layers and merges by `id`.
 * Precedence (highest wins): operator-mounted > remote-pull > baked-in.
 */
export async function loadFeeds(
  opts: LoadFeedsOptions,
  deps: LoadFeedsDeps = {}
): Promise<FeedSourceBase[]> {
  const schema = feedSchemaFor(opts.domain);
  const baked = loadFeedFiles(opts.bakedInDir, schema) as FeedSourceBase[];
  const mounted = loadMountedFeeds(opts.mountDir, schema);
  const remote = await loadRemoteFeeds(opts.domain, opts.remote, schema, deps);
  return mergeFeedsById([baked, remote, mounted]);
}

/** Later layers override earlier ones by `id`; a new id is appended in first-seen order. */
export function mergeFeedsById(layers: FeedSourceBase[][]): FeedSourceBase[] {
  const byId = new Map<string, FeedSourceBase>();
  for (const layer of layers) {
    for (const f of layer) byId.set(f.id, f); // re-set keeps the slot, replaces the value
  }
  return [...byId.values()];
}

function loadMountedFeeds(mountDir: string | undefined, schema: ZodTypeAny): FeedSourceBase[] {
  // A missing/unset mount dir is a silent no-op (the common self-host case). A
  // malformed mounted file must fail loudly — it's an operator error worth
  // surfacing — which loadFeedFiles does by throwing on bad JSON5 / schema.
  if (!mountDir || !existsSync(mountDir)) return [];
  return loadFeedFiles(mountDir, schema) as FeedSourceBase[];
}

async function loadRemoteFeeds(
  domain: string,
  remote: LoadFeedsOptions["remote"],
  schema: ZodTypeAny,
  deps: LoadFeedsDeps
): Promise<FeedSourceBase[]> {
  if (!remote?.enabled) return []; // default off
  const assertUrl = deps.assertUrl ?? assertPublicUrl;
  const fetchImpl =
    deps.remoteFetch ??
    guardedFetch(globalThis.fetch, {
      maxBytes: REMOTE_MAX_BYTES,
      timeoutMs: REMOTE_TIMEOUT_MS,
      maxRedirects: REMOTE_MAX_REDIRECTS,
    });

  try {
    assertUrl(remote.url); // the atlas bundle URL is untrusted — guard before fetch
    const res = await fetchImpl(remote.url);
    if (!res.ok) throw new Error(`remote atlas ${res.status}`);
    const text = await res.text();
    const feeds = parseBundle(text, schema, assertUrl);
    await writeSnapshot(remote.snapshotPath, feeds);
    return feeds;
  } catch (err) {
    console.warn(
      `[loadFeeds] ${domain}: remote pull failed (${String(err)}); falling back to snapshot`
    );
    const snap = await readSnapshot(remote.snapshotPath, schema);
    if (snap) {
      console.warn(`[loadFeeds] ${domain}: using vendored snapshot (${snap.length} feed(s))`);
      return snap;
    }
    console.warn(`[loadFeeds] ${domain}: no usable snapshot; baked-in feeds only`);
    return [];
  }
}

/** A remote bundle is a JSON5 array of descriptors or `{ feeds: [...] }`. Validate every one. */
function parseBundle(
  text: string,
  schema: ZodTypeAny,
  assertUrl: (url: string) => void
): FeedSourceBase[] {
  const raw: unknown = JSON5.parse(text);
  const feedsField =
    raw && typeof raw === "object" ? (raw as { feeds?: unknown }).feeds : undefined;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(feedsField)
      ? feedsField
      : (() => {
          throw new Error("remote bundle is neither an array nor { feeds: [...] }");
        })();
  return list.map((entry) => {
    const feed = schema.parse(entry) as FeedSourceBase;
    assertFeedUrls(feed, assertUrl); // declarative descriptor from an untrusted source
    return feed;
  });
}

/**
 * Guard each static URL a remote descriptor supplies. Templated URLs (`${VAR}`)
 * are guarded per-hop at fetch-time. `siteTable.url` is a domain-specific
 * (roads) field not declared on the base type; the runtime `guardedFetch`
 * already covers it, so this is parse-time defense-in-depth mirroring
 * `feeds-lint`.
 */
function assertFeedUrls(feed: FeedSourceBase, assertUrl: (url: string) => void): void {
  const urls = Array.isArray(feed.url) ? feed.url : feed.url ? [feed.url] : [];
  for (const u of urls) if (!u.includes("${")) assertUrl(u);

  const sUrl = (feed as { siteTable?: { url?: string } }).siteTable?.url;
  if (sUrl && !sUrl.includes("${")) assertUrl(sUrl);
}

async function writeSnapshot(path: string, feeds: FeedSourceBase[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(feeds, null, 2), "utf8");
}

async function readSnapshot(
  path: string,
  schema: ZodTypeAny
): Promise<FeedSourceBase[] | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON5.parse(await readFile(path, "utf8"));
    if (!Array.isArray(raw)) return undefined;
    return raw.map((e) => schema.parse(e) as FeedSourceBase);
  } catch {
    return undefined; // a corrupt snapshot is treated as "no snapshot"
  }
}
