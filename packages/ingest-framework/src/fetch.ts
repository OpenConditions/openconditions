import { makeAuthorizedFetch } from "./auth.js";
import type { Cell } from "./catalog/cells.js";
import type { Env } from "./catalog/credentials.js";
import {
  type CatalogResolver,
  type ChildFeed,
  catalogResolverFor,
  resolveWithSnapshot,
} from "./catalog/resolvers.js";
import {
  eachItemPath,
  feedEndpoint,
  referencesCredential,
  resolveEachUrl,
  resolveEndpointUrls,
  resolveFeedTemplate,
} from "./catalog/templates.js";
import type { CatalogFeed, FeedEndpoint, FetchFn } from "./catalog/types.js";
import { boundedGunzip, maxFeedBytes } from "./egress.js";
import { type HeldPayload, heldBuffer, holdPayload } from "./held.js";
import { guardedImpersonatingFetch, type ImpersonationOptions } from "./impersonate.js";
import { getPath } from "./layouts/row.js";
import { digestPayload, type PayloadDigest } from "./payload.js";
import { feedSecretValues, redactSecrets, redactUrl } from "./redact.js";
import { unzipEntries } from "./zip.js";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** The entries an unzipped archive may list when its endpoint sets no bound. */
const DEFAULT_MAX_ZIP_ENTRIES = 10_000;

/** Max sub-feed fetches in flight when fanning out a resolved catalog URL set. */
const FANOUT_CONCURRENCY = 8;

/**
 * Per-endpoint politeness memory: the ETag/Last-Modified of each URL (for
 * conditional GET), keyed `${feed.id}#${role}\0${url}`, and the definition each
 * endpoint was last fetched under. A long-lived scheduler shares one instance
 * across cycles so conditional headers accumulate; tests pass a fresh one.
 *
 * `body` (the last decompressed body, gzipped in memory when large) is
 * retained ONLY for multi-URL endpoints, where a URL that replies 304 must be
 * re-combined with a sibling URL that changed before the feed is re-parsed.
 * Single-URL endpoints skip entirely on 304 (see {@link fetchEndpoint}), so
 * caching their bodies — often tens of MB each, ~1 GB across the ~30 datex
 * feeds — only bloats off-heap memory and is omitted.
 */
export interface FetchState {
  conditional: Map<
    string,
    { etag?: string; lastModified?: string; body?: HeldPayload; payload?: PayloadDigest }
  >;
  sourceConfig: Map<string, string>;
  /** Per feed id, the pacing of a feed that declares `requestLimits.perMinute`. */
  pacers: Map<string, Pacer>;
}

export function createFetchState(): FetchState {
  return { conditional: new Map(), sourceConfig: new Map(), pacers: new Map() };
}

/** When a feed's recent requests started, and the turn the next one waits for. */
interface Pacer {
  starts: number[];
  turn: Promise<void>;
}

const MINUTE_MS = 60_000;

/**
 * Wraps a feed's fetch so its requests start at most `perMinute` times in any
 * 60 s window: every request of the feed, whatever role or poll it belongs
 * to, takes a turn in one queue and waits until the oldest start in the
 * window has left it. Starts are spaced, not refused, so a fan-out or a
 * page sequence finishes at the rate the publisher allows.
 */
function pacedFetch(pacer: Pacer, perMinute: number, fetchFn: FetchFn): FetchFn {
  const wait = async (): Promise<void> => {
    const sinceWindow = () => Date.now() - MINUTE_MS;
    pacer.starts = pacer.starts.filter((t) => t > sinceWindow());
    if (pacer.starts.length >= perMinute) {
      const delay = (pacer.starts[0] ?? 0) + MINUTE_MS - Date.now();
      // A wait of up to a minute never holds a stopping process open.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)).unref());
      pacer.starts = pacer.starts.filter((t) => t > sinceWindow());
    }
    pacer.starts.push(Date.now());
  };
  return (async (...args: Parameters<FetchFn>) => {
    const mine = pacer.turn.then(wait);
    pacer.turn = mine.catch(() => {});
    await mine;
    return fetchFn(...args);
  }) as FetchFn;
}

const sharedFetchState = createFetchState();

/** A per-item role's latest response for one item, kept between polls. */
export interface KeptItem {
  /** The version the item's listing gave it (a walked item), when it gave one. */
  version?: string;
  /**
   * Whether the item was fetched twice under this version. A version of
   * coarse resolution (a listing's last-modified minute) can stay the same
   * across a write that came after the item was read, so a version is
   * trusted only once it repeats.
   */
  confirmed?: boolean;
  /** Epoch ms of the poll that fetched it. */
  at: number;
  body: HeldPayload;
}

/**
 * The items of a per-item role kept between polls, by URL: those its last
 * fetch named, and only those.
 */
export type KeptItems = ReadonlyMap<string, KeptItem>;

/** What a fetch that answered carries besides its status. */
interface FetchedPayloads {
  /** The payloads to parse. */
  buffers: Buffer[];
  /** The URL each buffer came from, same order. Never logged: it may carry a credential. */
  urls: string[];
  /** One digest per response this call received: the raw-payload identity of each. */
  payloads: PayloadDigest[];
  /**
   * The responses `payloads` digest, same order, when they are not `buffers`
   * one for one: the entries of an unzipped archive, or a per-item role whose
   * kept items stand in for responses not asked again.
   */
  responses?: Buffer[];
  /** A per-item role's items to keep for the next poll, replacing those it was given. */
  kept?: KeptItems;
  /**
   * The URLs of a tolerant fan-out that did not answer, in request order: the
   * caller may stand a held answer of each in. Never logged: they may carry a
   * credential.
   */
  failedUrls?: string[];
}

export type FetchResult =
  | ({
      status: "fetched";
      /** Commit conditional validators only after the complete snapshot is published. */
      accept: () => void;
      validatedAtNetwork: true;
      partitions: { succeeded: number; failed: 0; total: number };
    } & FetchedPayloads)
  | ({
      status: "partial";
      validatedAtNetwork: false;
      partitions: { succeeded: number; failed: number; total: number };
    } & FetchedPayloads)
  | { status: "not-modified"; validatedAtNetwork: true }
  | {
      status: "no-endpoint";
      reason: "missing-configuration";
      validatedAtNetwork: false;
    };

export interface FetchOptions {
  state?: FetchState;
  /** The resolvers a catalogue parent may name: its domain's. */
  resolvers?: readonly CatalogResolver[];
  /** Where credentials are read; defaults to `process.env`. */
  env?: Env;
  /** Fill the endpoint's cell placeholders for this cell. A cell read keeps no conditional-GET state. */
  cell?: Cell;
  /** Replaces the impersonating client and DNS lookup (tests). */
  impersonation?: ImpersonationOptions;
  /** The payloads of the role a per-item (`each`) endpoint reads its ids from. */
  eachSource?: readonly Buffer[];
  /** The URL of each `eachSource` payload, same order: where a walk resolves its links. */
  eachSourceUrls?: readonly string[];
  /** The items a per-item endpoint kept at its last fetch. */
  kept?: KeptItems;
  /** Epoch ms of the poll: the instant its date placeholders and kept items are read at. */
  at?: number;
}

function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

/**
 * An HTML page served where data was expected — a sign-in wall or error page
 * from a portal that answered 200.
 *
 * Matched on an actual HTML signature. This used to test for a leading '<',
 * which was safe only while the fan-out carried JSON alone: the first XML feed
 * routed through it had every sub-feed rejected as an error page, losing the
 * whole publisher on the very path meant to survive partial failure. A JSON
 * feed handed XML still fails — at the parser, where the message names the
 * real problem instead of misreporting it as HTML.
 */
function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 256).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("<?xml")) return false;
  return /^<(!doctype\s+html|html[\s>])/i.test(head);
}

/** Ceiling on a single feed's decompressed bytes; matches the guard's byte cap. */
const MAX_DECOMPRESSED_BYTES = maxFeedBytes();

const EMPTY_BUFFER = Buffer.alloc(0);

async function fetchOne(
  url: string,
  fetchFn: typeof fetch,
  init?: RequestInit,
  state?: FetchState,
  cacheBody = false,
  redact: (s: string) => string = (s) => s,
): Promise<{ changed: boolean; buffer: Buffer; payload: PayloadDigest }> {
  const prior = state?.conditional.get(url);
  const headers = new Headers(init?.headers);
  if (prior?.etag) headers.set("If-None-Match", prior.etag);
  if (prior?.lastModified) headers.set("If-Modified-Since", prior.lastModified);

  const res = await fetchFn(url, { ...init, headers });
  // A 304 body is only consumed for a multi-URL feed's partial-304 re-parse
  // (where `cacheBody` is true and `prior.body` was retained). A single-URL 304
  // returns this empty buffer, which the caller discards on its "unchanged" path.
  if (res.status === 304 && prior) {
    const buffer = prior.body === undefined ? EMPTY_BUFFER : await heldBuffer(prior.body);
    return {
      changed: false,
      buffer,
      payload: prior.payload ?? digestPayload(redact(redactUrl(url)), buffer),
    };
  }
  if (!res.ok) {
    // `redact` (the feed's own secret values) runs after `redactUrl` (query
    // values) so a credential duplicated into the URL PATH — e.g. Mobilithek's
    // subscription id — is also scrubbed, not just its query-string copy.
    throw new Error(`HTTP ${res.status} fetching ${redact(redactUrl(url))}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const raw = Buffer.from(arrayBuf);
  const buffer = isGzip(raw) ? await boundedGunzip(raw, MAX_DECOMPRESSED_BYTES) : raw;
  // The digest travels further than this function (poll records, raw index):
  // it carries the URL with credentials scrubbed, never the live one.
  const payload = digestPayload(redact(redactUrl(url)), buffer);
  if (state) {
    state.conditional.set(url, {
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      body: cacheBody ? await holdPayload(buffer) : undefined,
      payload: cacheBody ? payload : undefined,
    });
  }
  return { changed: true, buffer, payload };
}

/** Build the RequestInit for an endpoint: method, body and headers, their `${field}`s filled. */
function requestInit(
  feed: CatalogFeed,
  role: string,
  env: Env,
  cell?: Cell,
  at?: number,
): RequestInit | undefined {
  const endpoint = feedEndpoint(feed, role);
  const headers = endpoint.headers
    ? Object.fromEntries(
        Object.entries(endpoint.headers).map(([k, v]) => [
          k,
          resolveFeedTemplate(feed, v, env, cell, at),
        ]),
      )
    : undefined;
  if (endpoint.method !== "POST") return headers ? { headers } : undefined;
  return {
    method: "POST",
    body:
      endpoint.body !== undefined
        ? resolveFeedTemplate(feed, endpoint.body, env, cell, at)
        : undefined,
    headers,
  };
}

/**
 * The request init of a followed URL: a GET carrying the endpoint's headers
 * that name no credential. A header that does (`"X-Key": "${key}"`) is dropped,
 * so a secret never reaches the second host.
 */
function followedInit(
  feed: CatalogFeed,
  role: string,
  env: Env,
  cell?: Cell,
  at?: number,
): RequestInit | undefined {
  const entries = Object.entries(feedEndpoint(feed, role).headers ?? {})
    .filter(([, template]) => !referencesCredential(template))
    .map(([name, template]) => [name, resolveFeedTemplate(feed, template, env, cell, at)]);
  return entries.length > 0 ? { headers: Object.fromEntries(entries) } : undefined;
}

/**
 * Fetches a resolved catalog URL set with bounded concurrency and per-URL tolerance:
 * a single failing sub-feed is logged and skipped rather than aborting the
 * whole batch (many registry feeds require operator-supplied keys and will
 * fail). Throws only if *every* sub-feed fails, so the caller preserves the
 * last-good rows instead of swapping in an empty set.
 *
 * Returns `failures`/`total` alongside the successful buffers (rather than a
 * bare `Buffer[]`) so a caller can tell a mostly-healthy fan-out from a
 * mass-failure one that merely stayed above the all-failed floor — without
 * this, `runSource` swapped in whatever fragment survived even when e.g. 9 of
 * 10 sub-feeds failed, and the diff-upsert's delete-missing step then wiped
 * every row belonging to the 9 failed sub-feeds as "no longer present".
 *
 * FUTURE refinement: once a per-sub-feed last-good buffer is available here
 * (the `cacheBody`/`FetchState.conditional` plumbing `fetchOne` already
 * supports for the static multi-URL path, but `fetchFanout` doesn't thread a
 * `state` through today), a failed sub-feed could contribute its cached
 * buffer instead of vanishing from `out` — so no rows would be pruned even
 * below the ratio threshold below. Not built here: it depends on that
 * in-progress per-URL body-caching work landing first.
 */
async function fetchFanout(
  urls: string[],
  fetchFn: typeof fetch,
  redact: (s: string) => string = (s) => s,
  // The endpoint's own RequestInit — its headers, and a POST method/body
  // where it has them. The static path has always sent these; the fan-out
  // dropped them, so a feed quietly lost its headers by being fanned out.
  init?: RequestInit,
  // The role is a directory listing another role walks: an HTML page is its data.
  html = false,
): Promise<ItemsFetch> {
  const out: Buffer[] = [];
  const answered: string[] = [];
  const payloads: PayloadDigest[] = [];
  const failed = new Set<string>();
  let failures = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const url = urls[cursor++]!;
      try {
        const { buffer, payload } = await fetchOne(url, fetchFn, init, undefined, false, redact);
        if (!html && looksLikeHtml(buffer)) {
          throw new Error("returned an HTML page, not feed data");
        }
        out.push(buffer);
        answered.push(url);
        payloads.push(payload);
      } catch (err) {
        failures++;
        failed.add(url);
        console.warn(
          `[ingest] sub-feed fetch failed (${redact(url)}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const workerCount = Math.min(FANOUT_CONCURRENCY, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (urls.length > 0 && out.length === 0) {
    throw new Error(`all ${urls.length} sub-feeds failed (${failures} failures)`);
  }
  return {
    buffers: out,
    urls: answered,
    payloads,
    failures,
    total: urls.length,
    ...(failures > 0 ? { failedUrls: urls.filter((url) => failed.has(url)) } : {}),
  };
}

/**
 * Fetches every url with bounded concurrency, preserving order, threading the
 * conditional-GET `state` through each request. Unlike the tolerant catalog
 * fan-out, a single failure rejects the whole batch (matching the prior
 * Promise.all semantics for static feed URL sets). Returns the per-URL
 * `{changed, buffer}` so the caller can decide the source is unchanged when
 * every URL replied 304.
 */
async function fetchAllBounded(
  urls: string[],
  fetchFn: typeof fetch,
  init: RequestInit | undefined,
  state: FetchState | undefined,
  cacheBody: boolean,
  redact: (s: string) => string = (s) => s,
): Promise<{ changed: boolean; buffer: Buffer; payload: PayloadDigest }[]> {
  const out = new Array<{ changed: boolean; buffer: Buffer; payload: PayloadDigest }>(urls.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const i = cursor++;
      out[i] = await fetchOne(urls[i]!, fetchFn, init, state, cacheBody, redact);
    }
  }
  const workerCount = Math.min(FANOUT_CONCURRENCY, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

/** Default ceiling on pages a single paginated feed fetches per cycle. */
const DEFAULT_MAX_PAGES = 100;

/**
 * Count the records at `path` (dot-separated) in a JSON page body. Throws when
 * the body is not JSON so a corrupt page fails the whole cycle (last-good
 * preserved) rather than silently ending pagination early. The collection must
 * exist and be an array, including on the terminal empty page, unless the
 * JSON is converted from XML (`xmlLists`): then a lone object is a list of
 * one, and a page after the first without the collection is an empty list.
 */
function countJsonRecords(
  buffer: Buffer,
  path: string,
  lists: { xml: boolean; firstPage: boolean },
): number {
  let doc: unknown;
  try {
    doc = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("pagination: page body is not valid JSON");
  }
  const emptyAllowed = lists.xml && !lists.firstPage;
  let node: unknown = doc;
  for (const key of path.split(".")) {
    if (node == null || typeof node !== "object") {
      if (emptyAllowed && (node === undefined || node === "")) return 0;
      throw new Error(`pagination: missing collection ${path}`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  if (Array.isArray(node)) return node.length;
  if (lists.xml && node !== null && typeof node === "object") return 1;
  if (emptyAllowed && (node === undefined || node === "")) return 0;
  throw new Error(`pagination: expected array at ${path}`);
}

/**
 * Append `param=offset` to a URL, choosing `?`/`&`. The offset param name is
 * emitted verbatim (OData wants a literal `$skip`, which URLSearchParams would
 * percent-encode to `%24skip`).
 */
function withOffset(baseUrl: string, param: string, offset: number): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}${param}=${offset}`;
}

/**
 * Paginates each base URL: fetches `$skip=0`, `$skip=pageSize`, … (or, in page
 * mode, `pageNo=firstPage`, `firstPage+1`, …) until a page returns fewer than
 * `pageSize` records (the last page) or `maxPages` is reached, pushing each
 * non-empty page body as its own buffer (the parser runs per-buffer and
 * `runSource` concatenates the results). A failed page fetch
 * throws — all-or-nothing, like the static multi-URL path — so a partial set
 * never reaches the atomic swap and prunes rows for the pages that didn't load.
 */
async function fetchPaginated(
  baseUrls: string[],
  feedId: string,
  pg: NonNullable<FeedEndpoint["pagination"]>,
  init: RequestInit | undefined,
  fetchFn: FetchFn,
  redact: (s: string) => string,
): Promise<{ buffers: Buffer[]; urls: string[]; payloads: PayloadDigest[] }> {
  const recordsPath = pg.recordsPath ?? "value";
  const maxPages = pg.maxPages ?? DEFAULT_MAX_PAGES;
  const out: Buffer[] = [];
  const urls: string[] = [];
  const payloads: PayloadDigest[] = [];
  for (const baseUrl of baseUrls) {
    let reachedEnd = false;
    for (let page = 0; page < maxPages; page++) {
      const value = pg.mode === "page" ? (pg.firstPage ?? 1) + page : page * pg.pageSize;
      const url = withOffset(baseUrl, pg.skipParam, value);
      const { buffer, payload } = await fetchOne(url, fetchFn, init, undefined, false, redact);
      const count = countJsonRecords(buffer, recordsPath, {
        xml: pg.xmlLists === true,
        firstPage: page === 0,
      });
      if (count > 0) {
        out.push(buffer);
        urls.push(url);
        payloads.push(payload);
      }
      if (count < pg.pageSize) {
        reachedEnd = true;
        break;
      }
    }
    if (!reachedEnd) {
      throw new Error(`pagination: ${feedId} reached maxPages=${maxPages} without a terminal page`);
    }
  }
  return { buffers: out, urls, payloads };
}

/** The string at a dotted JSON path (numeric segments index arrays), or undefined. */
function jsonPathString(buffer: Buffer, path: string): string | undefined {
  let node: unknown;
  try {
    node = JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
  for (const key of path.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" && node !== "" ? node : undefined;
}

/** The URL a `follow` endpoint's page names, resolved against the page URL. */
function followTarget(
  follow: NonNullable<FeedEndpoint["follow"]>,
  page: Buffer,
  pageUrl: string,
): string {
  let found: string | undefined;
  if (follow.path !== undefined) {
    found = jsonPathString(page, follow.path);
  } else if (follow.pattern !== undefined) {
    // A link in markup spells `&` as `&amp;`.
    found = new RegExp(follow.pattern).exec(page.toString("utf8"))?.[1]?.replaceAll("&amp;", "&");
  }
  if (!found) throw new Error("follow: no URL found");
  try {
    return new URL(found, pageUrl).toString();
  } catch {
    throw new Error("follow: no URL found");
  }
}

/**
 * Fetches each URL with the feed's authorization, takes the next URL out of
 * the response and fetches that with `baseFetch`, the guarded fetch that
 * carries no credential, and `nextInit`, which carries none either.
 */
async function fetchFollowing(
  urls: string[],
  follow: NonNullable<FeedEndpoint["follow"]>,
  authorizedFetch: FetchFn,
  baseFetch: FetchFn,
  init: RequestInit | undefined,
  nextInit: RequestInit | undefined,
  redact: (s: string) => string,
): Promise<{ buffers: Buffer[]; urls: string[]; payloads: PayloadDigest[] }> {
  const buffers: Buffer[] = [];
  const targets: string[] = [];
  const payloads: PayloadDigest[] = [];
  for (const url of urls) {
    const page = await fetchOne(url, authorizedFetch, init, undefined, false, redact);
    const target = followTarget(follow, page.buffer, url);
    const followed = await fetchOne(target, baseFetch, nextInit, undefined, false, redact);
    buffers.push(followed.buffer);
    targets.push(target);
    payloads.push(followed.payload);
  }
  return { buffers, urls: targets, payloads };
}

/** What a tolerant set of requests yields: the answers, and how many of how many failed. */
interface ItemsFetch extends FetchedPayloads {
  failures: number;
  total: number;
}

type EachSpec = NonNullable<FeedEndpoint["each"]>;

/**
 * The items a per-item endpoint is fetched for: `field` of every record at
 * `records` in each source payload, in order, each item once. The field is a
 * string, a number or a list of strings; anything else contributes nothing,
 * and an item is never made up. With `pattern`, only the values it matches
 * count, and its first group is the item. An item that could leave the path
 * it fills is refused and counted.
 */
function eachItems(
  each: EachSpec,
  sources: readonly Buffer[],
): { items: string[]; refused: number } {
  const pattern = each.pattern === undefined ? undefined : new RegExp(each.pattern);
  const items = new Set<string>();
  const refused = new Set<string>();
  const take = (value: string) => {
    const item = pattern ? pattern.exec(value)?.[1] : value;
    if (item === undefined || item === "") return;
    if (eachItemPath(item) === undefined) refused.add(item);
    else items.add(item);
  };
  for (const source of sources) {
    let doc: unknown;
    try {
      doc = JSON.parse(source.toString("utf8"));
    } catch {
      throw new Error(`each: the ${each.role} payload is not valid JSON`);
    }
    const records = getPath(doc, each.records ?? "");
    if (!Array.isArray(records)) {
      throw new Error(`each: no list at ${each.records} in the ${each.role} payload`);
    }
    for (const record of records) {
      const value = getPath(record, each.field ?? "");
      if (typeof value === "string") take(value);
      else if (typeof value === "number" && Number.isFinite(value)) take(String(value));
      else if (Array.isArray(value)) {
        for (const element of value) if (typeof element === "string") take(element);
      }
    }
  }
  return { items: [...items], refused: refused.size };
}

/**
 * Fetches each URL with bounded concurrency, each answer in its URL's slot
 * and a failed one left empty. Without `tolerant` the first failure rejects
 * and no further request is sent; with it a failed URL is logged and counted.
 * `html` takes an HTML page as an answer (a directory listing) instead of a
 * sign of an error page. No validator is read or written: an item's response
 * is never conditional on another's, and the list of items changes with its
 * source.
 */
async function fetchSlots(
  urls: readonly string[],
  fetchFn: FetchFn,
  init: RequestInit | undefined,
  redact: (s: string) => string,
  tolerant: boolean,
  html = false,
): Promise<{
  slots: ({ buffer: Buffer; payload: PayloadDigest } | undefined)[];
  failures: number;
}> {
  const slots = new Array<{ buffer: Buffer; payload: PayloadDigest } | undefined>(urls.length);
  let failures = 0;
  let cursor = 0;
  // Without `tolerant` the role has failed at its first failed item: the
  // other workers send no further request, which would only spend the
  // publisher's quota on a result that is thrown away.
  let stopped = false;
  async function worker(): Promise<void> {
    while (!stopped && cursor < urls.length) {
      const i = cursor++;
      try {
        const { buffer, payload } = await fetchOne(
          urls[i]!,
          fetchFn,
          init,
          undefined,
          false,
          redact,
        );
        if (!html && looksLikeHtml(buffer)) {
          throw new Error("returned an HTML page, not feed data");
        }
        slots[i] = { buffer, payload };
      } catch (err) {
        if (!tolerant) {
          stopped = true;
          throw err;
        }
        failures++;
        console.warn(
          `[ingest] item fetch failed (${redact(redactUrl(urls[i]!))}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FANOUT_CONCURRENCY, urls.length) }, () => worker()),
  );
  return { slots, failures };
}

/**
 * Fetches each URL, keeping order. Without `tolerant` the first failure rejects
 * the role and no further item is requested; with it a failed item is skipped,
 * and the role fails only when every item did.
 */
async function fetchEach(
  urls: string[],
  fetchFn: FetchFn,
  init: RequestInit | undefined,
  redact: (s: string) => string,
  tolerant: boolean,
): Promise<ItemsFetch> {
  const { slots, failures } = await fetchSlots(urls, fetchFn, init, redact, tolerant);
  const done = slots.flatMap((s, i) => (s ? [{ ...s, url: urls[i]! }] : []));
  if (urls.length > 0 && done.length === 0) {
    throw new Error(`all ${urls.length} item requests failed`);
  }
  return {
    buffers: done.map((s) => s.buffer),
    urls: done.map((s) => s.url),
    payloads: done.map((s) => s.payload),
    failures,
    total: urls.length,
  };
}

/**
 * Fetches the items not kept, and keeps every item fetched. An item is asked
 * again once `stale` says its kept copy is, and a kept copy stands in for an
 * item whose request failed. The items kept for the next poll are exactly the
 * ones `urls` names. The role fails when there were requests and every one
 * failed with no kept copy to stand in.
 */
async function fetchKeeping(
  urls: readonly { url: string; version?: string }[],
  stale: (url: string, version: string | undefined, kept: KeptItem) => boolean,
  kept: KeptItems | undefined,
  at: number,
  fetchFn: FetchFn,
  init: RequestInit | undefined,
  redact: (s: string) => string,
  tolerant: boolean,
  html: boolean,
): Promise<ItemsFetch & { kept: Map<string, KeptItem>; standIns: number }> {
  const due = urls.filter(({ url, version }) => {
    const prior = kept?.get(url);
    return prior === undefined || stale(url, version, prior);
  });
  const { slots, failures } = await fetchSlots(
    due.map((d) => d.url),
    fetchFn,
    init,
    redact,
    tolerant,
    html,
  );
  const answers = new Map(due.map((d, i) => [d.url, slots[i]] as const));
  if (due.length > 0 && failures === due.length && due.every((d) => !kept?.has(d.url))) {
    throw new Error(`all ${due.length} item requests failed`);
  }
  const next = new Map<string, KeptItem>();
  const buffers: Buffer[] = [];
  const answered: string[] = [];
  let standIns = 0;
  for (const { url, version } of urls) {
    const answer = answers.get(url);
    if (answer) {
      const repeated = version !== undefined && kept?.get(url)?.version === version;
      next.set(url, {
        ...(version !== undefined ? { version } : {}),
        ...(repeated ? { confirmed: true } : {}),
        at,
        body: await holdPayload(answer.buffer),
      });
      buffers.push(answer.buffer);
      answered.push(url);
      continue;
    }
    const prior = kept?.get(url);
    if (prior) {
      next.set(url, prior);
      buffers.push(await heldBuffer(prior.body));
      answered.push(url);
      if (answers.has(url)) standIns++;
    }
  }
  const fetched = slots.filter((s) => s !== undefined);
  return {
    buffers,
    urls: answered,
    payloads: fetched.map((s) => s.payload),
    responses: fetched.map((s) => s.buffer),
    failures,
    total: due.length,
    kept: next,
    standIns,
  };
}

/**
 * The links one walk level finds in its listings: group 1 of each match the
 * href (`&amp;` read as `&`), resolved against the listing's URL, group 2 the
 * entry's version when the pattern has one. A link is followed only when it
 * lies below the listing's directory on the same origin: never to another
 * host, the parent or a sibling. Each URL once, in the order found.
 */
function listedLinks(
  pattern: string,
  listings: readonly { buffer: Buffer; url: string }[],
): { url: string; version?: string }[] {
  const found = new Map<string, string | undefined>();
  const re = new RegExp(pattern, "g");
  for (const listing of listings) {
    const base = new URL(listing.url);
    const dir = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
    for (const match of listing.buffer.toString("utf8").matchAll(re)) {
      const href = match[1]?.replaceAll("&amp;", "&");
      if (!href) continue;
      let target: URL;
      try {
        target = new URL(href, base);
      } catch {
        continue;
      }
      target.hash = "";
      const below =
        target.origin === base.origin &&
        target.pathname.startsWith(dir) &&
        target.pathname.length > dir.length;
      if (below && !found.has(target.href)) found.set(target.href, match[2]);
    }
  }
  return [...found].map(([url, version]) => (version === undefined ? { url } : { url, version }));
}

/**
 * Walks directory listings down from the source role's payloads, one level
 * per `links` pattern; the last level's items are the role's payloads. A
 * listing with a version is listed again when its version changes and once
 * more on the next walk, skipped only after the same version was seen twice
 * (a minute-resolution version can hide a write in the minute it was read);
 * one without a version on every walk (only listing it shows what changed below). A last
 * level item is fetched again only when its version changes, and without one
 * never while it is listed. Every response is kept, so a listing or file that
 * fails stands in from its last answer. A listing that matches no link fails
 * too, its kept copy standing in. The walked files are the role's whole
 * snapshot: only a failure nothing stood in for counts, and it leaves the
 * result partial, its subtree missing.
 */
async function fetchWalk(
  links: readonly string[],
  sources: readonly { buffer: Buffer; url: string }[],
  kept: KeptItems | undefined,
  at: number,
  fetchFn: FetchFn,
  init: RequestInit | undefined,
  redact: (s: string) => string,
  tolerant: boolean,
): Promise<ItemsFetch> {
  let listings = sources;
  const next = new Map<string, KeptItem>();
  const payloads: PayloadDigest[] = [];
  const responses: Buffer[] = [];
  let failures = 0;
  let total = 0;
  for (const [level, pattern] of links.entries()) {
    const last = level === links.length - 1;
    const read: { buffer: Buffer; url: string }[] = [];
    for (const listing of listings) {
      if (listedLinks(pattern, [listing]).length > 0) {
        read.push(listing);
        // A source listing is kept here too, so it can stand in for an empty answer.
        if (level === 0) next.set(listing.url, { at, body: await holdPayload(listing.buffer) });
        continue;
      }
      // A listing that names nothing below it is not an empty level (the
      // Datamart has none) but a page in its place: a maintenance page, a
      // renamed tree. It fails like a request that failed.
      const prior = kept?.get(listing.url);
      const copy = prior && { buffer: await heldBuffer(prior.body), url: listing.url };
      const message = `[ingest] listing matched no link (${redact(redactUrl(listing.url))})`;
      if (prior && copy && listedLinks(pattern, [copy]).length > 0) {
        console.warn(`${message}: its kept copy stands in`);
        read.push(copy);
        next.set(listing.url, prior);
        continue;
      }
      next.delete(listing.url);
      if (!tolerant)
        throw new Error(`a listing matched no link (${redact(redactUrl(listing.url))})`);
      console.warn(message);
      failures++;
      // A source listing was no request of the walk's.
      if (level === 0) total++;
    }
    const found = await fetchKeeping(
      listedLinks(pattern, read),
      (_url, version, prior) =>
        version === undefined
          ? !last
          : prior.version !== version || (!last && prior.confirmed !== true),
      kept,
      at,
      fetchFn,
      init,
      redact,
      tolerant,
      !last,
    );
    for (const [url, item] of found.kept) next.set(url, item);
    payloads.push(...found.payloads);
    responses.push(...(found.responses ?? []));
    // A failure a kept copy stood in for leaves nothing out of the snapshot.
    failures += found.failures - found.standIns;
    total += found.total;
    listings = found.buffers.map((buffer, i) => ({ buffer, url: found.urls[i]! }));
  }
  return {
    buffers: listings.map((l) => l.buffer),
    urls: listings.map((l) => l.url),
    payloads,
    responses,
    failures,
    total,
    kept: next,
  };
}

/** Shallow equality match of a resolved child against a catalog filter. */
function matchesFilter(child: ChildFeed, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(
    ([k, v]) => (child as unknown as Record<string, unknown>)[k] === v,
  );
}

/** The static URLs of one role of a resolved child; a child without the role has none. */
function childUrls(child: ChildFeed, role: string): string[] {
  const endpoint = child.endpoints[role];
  if (!endpoint) return [];
  return endpoint.urls ?? (endpoint.url ? [endpoint.url] : []);
}

/** A tolerant set of requests as a result: "partial" when any of them failed. */
function fanoutResult({ failures, total, ...fetched }: ItemsFetch): FetchResult {
  if (failures > 0) {
    return {
      status: "partial",
      ...fetched,
      validatedAtNetwork: false,
      partitions: { succeeded: total - failures, failed: failures, total },
    };
  }
  return {
    status: "fetched",
    accept: () => {},
    ...fetched,
    validatedAtNetwork: true,
    partitions: { succeeded: total, failed: 0, total },
  };
}

/** Whether another endpoint of the feed walks this role's payloads as directory listings. */
function walkedRole(feed: CatalogFeed, role: string): boolean {
  return Object.values(feed.endpoints).some(
    (endpoint) => endpoint.each?.role === role && endpoint.each.links !== undefined,
  );
}

/** The zip archive entries `unzip` names, as the role's payloads; the archives stay the responses. */
function unzipped(result: FetchResult, unzip: NonNullable<FeedEndpoint["unzip"]>): FetchResult {
  if (result.status !== "fetched" && result.status !== "partial") return result;
  const entries = unzip.entries === undefined ? undefined : new RegExp(unzip.entries);
  const buffers: Buffer[] = [];
  const urls: string[] = [];
  for (const [i, zip] of result.buffers.entries()) {
    const found = unzipEntries(zip, {
      ...(entries ? { entries } : {}),
      maxEntries: unzip.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES,
      maxBytes: MAX_DECOMPRESSED_BYTES,
    });
    for (const entry of found) {
      buffers.push(entry.data);
      urls.push(result.urls[i]!);
    }
  }
  return { ...result, buffers, urls, responses: result.responses ?? result.buffers };
}

/**
 * Resolves the URL(s) of one endpoint of a feed and fetches each one, returning
 * a {@link FetchResult}. Buffers are gunzipped transparently when the response
 * bytes start with the gzip magic bytes 0x1f 0x8b. Every request carries the
 * endpoint's `method`, `body` and `headers`, their `${field}`s filled from the
 * feed's credentials. When to call it is the caller's: see `dueRoles`. The
 * caller passes the guarded fetch without credentials; the feed's authorization
 * is applied here.
 *
 * `feed.catalog`, when present, resolves a registry into children (live, with a
 * vendored-snapshot fallback) and fans the URLs of their `role` endpoints out
 * tolerantly (takes precedence over the feed's own URL) — always "fetched",
 * since registry sub-feeds are best-effort and not conditionally cached.
 * Otherwise the endpoint's `url` or `urls` are templates, and `expand` fans them
 * out over a comma-separated credential. Multi-URL sets fetch with bounded
 * concurrency so a large resolved URL set cannot fire every request at once. An
 * endpoint with `fanout: "tolerant"` and more than one URL is instead routed
 * through the same per-URL tolerant fetcher as the catalog path (see below).
 *
 * Politeness on the static/template path: each URL sends its cached
 * ETag/Last-Modified, kept per `${feed.id}#${role}`, and an endpoint whose every
 * URL replied 304 is "not-modified" so the caller preserves last-good rows
 * instead of re-swapping.
 *
 * An endpoint with `unzip` answers with zip archives: the entries it names
 * are the role's payloads, whichever way the archives were fetched.
 */
export async function fetchEndpoint(
  feed: CatalogFeed,
  role: string,
  baseFetch: FetchFn,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const unzip = feedEndpoint(feed, role).unzip;
  const result = await fetchRole(feed, role, baseFetch, opts);
  return unzip ? unzipped(result, unzip) : result;
}

async function fetchRole(
  feed: CatalogFeed,
  role: string,
  baseFetch: FetchFn,
  opts: FetchOptions,
): Promise<FetchResult> {
  const state = opts.state ?? sharedFetchState;
  const env = opts.env ?? process.env;
  const cell = opts.cell;
  const at = opts.at ?? Date.now();
  const endpoint = feedEndpoint(feed, role);

  // Scrubs the feed's own secret values out of any string before it reaches a
  // log or `FeedStatusStore` — computed once, at the source, so every
  // downstream log/error is pre-scrubbed of values a syntax-only redactor like
  // `redactUrl` would miss (e.g. a credential duplicated into the URL path).
  const redact = (s: string) => redactSecrets(s, feedSecretValues(feed, env));

  // The caller's fetch is the guarded one without credentials; the feed's
  // authorization is added here, on top of it or of the impersonating client.
  // The base itself is what a followed URL is fetched with.
  if (endpoint.impersonate && feed.auth?.kind === "mtls") {
    throw new Error("impersonate cannot be combined with mtls auth");
  }
  const base = endpoint.impersonate ? guardedImpersonatingFetch(opts.impersonation) : baseFetch;
  const authorized = makeAuthorizedFetch(feed, base, env);
  // A bulk fetch keeps to the feed's stated rate here; a cell read is paced
  // by the on-demand request budget instead. A followed URL is not the
  // publisher's API and goes unpaced.
  const perMinute = feed.requestLimits?.perMinute;
  let fetchFn = authorized;
  if (perMinute !== undefined && !cell) {
    let pacer = state.pacers.get(feed.id);
    if (!pacer) {
      pacer = { starts: [], turn: Promise.resolve() };
      state.pacers.set(feed.id, pacer);
    }
    fetchFn = pacedFetch(pacer, perMinute, authorized);
  }

  if (feed.catalog) {
    const resolver = catalogResolverFor(feed, opts.resolvers ?? []);
    const children = (await resolveWithSnapshot(resolver, feed, fetchFn)).filter((child) =>
      matchesFilter(child, feed.catalog?.filter),
    );
    const urls = children.flatMap((child) => childUrls(child, role));
    const fanout = await fetchFanout(
      urls,
      fetchFn,
      redact,
      requestInit(feed, role, env, undefined, at),
    );
    if (fanout.total === 0) {
      return { status: "no-endpoint", reason: "missing-configuration", validatedAtNetwork: false };
    }
    return fanoutResult(fanout);
  }

  // Each: one request per item read from another role's payload. The items
  // come from `opts.eachSource`, which the caller supplies from that role's
  // latest fetch; without it there is nothing to read and the role fails.
  if (endpoint.each) {
    const each = endpoint.each;
    if (!opts.eachSource) {
      throw new Error(`each: no ${each.role} payload to read ids from`);
    }
    const init = requestInit(feed, role, env, undefined, at);
    const tolerant = endpoint.fanout === "tolerant";
    if (each.links !== undefined) {
      const sourceUrls = opts.eachSourceUrls;
      if (sourceUrls === undefined || sourceUrls.length !== opts.eachSource.length) {
        throw new Error(`each: no URLs for the ${each.role} payloads to walk from`);
      }
      const sources = opts.eachSource.map((buffer, i) => ({ buffer, url: sourceUrls[i]! }));
      return fanoutResult(
        await fetchWalk(each.links, sources, opts.kept, at, fetchFn, init, redact, tolerant),
      );
    }
    const { items, refused } = eachItems(each, opts.eachSource);
    if (refused > 0) {
      console.warn(`[ingest] ${feed.id}: ${role}: ${refused} items refused (not a plain path)`);
    }
    const urls = items.map((item) => resolveEachUrl(feed, role, item, env, at));
    if (each.keepSec === undefined) {
      return fanoutResult(await fetchEach(urls, fetchFn, init, redact, tolerant));
    }
    const keepMs = each.keepSec * 1000;
    return fanoutResult(
      await fetchKeeping(
        urls.map((url) => ({ url })),
        (_url, _version, prior) => at - prior.at >= keepMs,
        opts.kept,
        at,
        fetchFn,
        init,
        redact,
        tolerant,
        false,
      ),
    );
  }

  // Follow: the response names the URL of the data (a download page's CSV
  // link, a batch call's presigned link). The data URL is fetched without the
  // feed's credentials, and always: the page is not the payload, so no
  // conditional request applies.
  if (endpoint.follow) {
    const pageUrls = resolveEndpointUrls(feed, role, env, cell, at);
    if (pageUrls.length === 0) {
      return { status: "no-endpoint", reason: "missing-configuration", validatedAtNetwork: false };
    }
    const followed = await fetchFollowing(
      pageUrls,
      endpoint.follow,
      fetchFn,
      base,
      requestInit(feed, role, env, cell, at),
      followedInit(feed, role, env, cell, at),
      redact,
    );
    return {
      status: "fetched",
      accept: () => {},
      ...followed,
      validatedAtNetwork: true,
      partitions: { succeeded: pageUrls.length, failed: 0, total: pageUrls.length },
    };
  }

  // Offset pagination: follow `$skip` over a single resolved URL until the last
  // (short) page. Skips conditional-GET/`unchanged` handling (a paged resource
  // changes each cycle, so an ETag buys nothing) — like the fan-out paths above.
  if (endpoint.pagination) {
    const baseUrls = resolveEndpointUrls(feed, role, env, cell, at);
    if (baseUrls.length === 0) {
      return { status: "no-endpoint", reason: "missing-configuration", validatedAtNetwork: false };
    }
    const pages = await fetchPaginated(
      baseUrls,
      feed.id,
      endpoint.pagination,
      requestInit(feed, role, env, cell, at),
      fetchFn,
      redact,
    );
    return {
      status: "fetched",
      accept: () => {},
      ...pages,
      validatedAtNetwork: true,
      partitions: { succeeded: baseUrls.length, failed: 0, total: baseUrls.length },
    };
  }

  const urls = resolveEndpointUrls(feed, role, env, cell, at);

  // `fanout: "tolerant"` opts a large multi-URL fan-out (one URL per site or
  // region) into the same per-URL tolerant fetcher the catalog path uses,
  // instead of the all-or-nothing `fetchAllBounded` below, so one dead sub-URL
  // yields a partial result rather than failing the poll. This skips
  // conditional-GET/`unchanged` handling entirely (fetchFanout doesn't do
  // ETag/304), the price of that tolerance. Endpoints without it (or with a
  // single URL) fall through to the static path.
  if (endpoint.fanout === "tolerant" && urls.length > 1) {
    return fanoutResult(
      await fetchFanout(
        urls,
        fetchFn,
        redact,
        requestInit(feed, role, env, cell, at),
        walkedRole(feed, role),
      ),
    );
  }

  // A cell read is a one-off request for one place: no validators are read or
  // written, so nothing of it outlives the call.
  if (cell) {
    if (urls.length === 0) {
      return { status: "no-endpoint", reason: "missing-configuration", validatedAtNetwork: false };
    }
    const results = await fetchAllBounded(
      urls,
      fetchFn,
      requestInit(feed, role, env, cell, at),
      undefined,
      false,
      redact,
    );
    return {
      status: "fetched",
      accept: () => {},
      buffers: results.map((r) => r.buffer),
      urls,
      payloads: results.map((r) => r.payload),
      validatedAtNetwork: true,
      partitions: { succeeded: results.length, failed: 0, total: results.length },
    };
  }

  // A changed parser or grant must be applied even when upstream content is unchanged.
  // Invalidate the old conditional state so the next publication restamps provenance.
  const stateKey = `${feed.id}#${role}`;
  const config = JSON.stringify(feed);
  if (state.sourceConfig.get(stateKey) !== config) {
    for (const key of state.conditional.keys()) {
      if (key.startsWith(`${stateKey}\0`)) state.conditional.delete(key);
    }
    state.sourceConfig.set(stateKey, config);
  }

  // An `expand` credential with no items yet — a dormant, uncredentialed feed.
  if (urls.length === 0) {
    return { status: "no-endpoint", reason: "missing-configuration", validatedAtNetwork: false };
  }

  const cacheKey = (url: string) => `${stateKey}\0${url}`;
  const init = requestInit(feed, role, env, undefined, at);
  // Retain last bodies only for multi-URL feeds — a single-URL feed skips whole
  // on 304 (below) and never re-reads its cached body, so caching it just holds
  // tens of MB of off-heap Buffer per feed for nothing.
  // Downloads are provisional: a failed parse, completeness check or transaction
  // must retry against the last published validators, including mixed 200/304 batches.
  const provisional: FetchState = {
    conditional: new Map(
      urls.flatMap((url) => {
        const prior = state.conditional.get(cacheKey(url));
        return prior ? [[url, prior] as const] : [];
      }),
    ),
    sourceConfig: state.sourceConfig,
    pacers: state.pacers,
  };
  const results = await fetchAllBounded(urls, fetchFn, init, provisional, urls.length > 1, redact);

  if (results.every((r) => !r.changed)) {
    return { status: "not-modified", validatedAtNetwork: true };
  }
  return {
    status: "fetched",
    accept: () => {
      // A URL the endpoint no longer names (yesterday's dated URL, a dropped
      // expand item) is never asked again: its validators go.
      for (const key of state.conditional.keys()) {
        if (key.startsWith(`${stateKey}\0`) && !urls.includes(key.slice(stateKey.length + 1))) {
          state.conditional.delete(key);
        }
      }
      for (const url of urls) {
        const accepted = provisional.conditional.get(url);
        if (accepted) state.conditional.set(cacheKey(url), accepted);
      }
    },
    buffers: results.map((r) => r.buffer),
    urls,
    payloads: results.map((r) => r.payload),
    validatedAtNetwork: true,
    partitions: { succeeded: results.length, failed: 0, total: results.length },
  };
}
