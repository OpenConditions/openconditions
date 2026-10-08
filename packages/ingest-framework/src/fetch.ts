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
  feedEndpoint,
  referencesCredential,
  resolveEndpointUrls,
  resolveFeedTemplate,
} from "./catalog/templates.js";
import type { CatalogFeed, FeedEndpoint, FetchFn } from "./catalog/types.js";
import { boundedGunzip, maxFeedBytes } from "./egress.js";
import { type HeldPayload, heldBuffer, holdPayload } from "./held.js";
import { guardedImpersonatingFetch, type ImpersonationOptions } from "./impersonate.js";
import { digestPayload, type PayloadDigest } from "./payload.js";
import { feedSecretValues, redactSecrets, redactUrl } from "./redact.js";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

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

export type FetchResult =
  | {
      status: "fetched";
      /** Commit conditional validators only after the complete snapshot is published. */
      accept: () => void;
      buffers: Buffer[];
      /** One digest per buffer, same order: the raw-payload identity of each response. */
      payloads: PayloadDigest[];
      validatedAtNetwork: true;
      partitions: { succeeded: number; failed: 0; total: number };
    }
  | {
      status: "partial";
      buffers: Buffer[];
      payloads: PayloadDigest[];
      validatedAtNetwork: false;
      partitions: { succeeded: number; failed: number; total: number };
    }
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
): RequestInit | undefined {
  const endpoint = feedEndpoint(feed, role);
  const headers = endpoint.headers
    ? Object.fromEntries(
        Object.entries(endpoint.headers).map(([k, v]) => [
          k,
          resolveFeedTemplate(feed, v, env, cell),
        ]),
      )
    : undefined;
  if (endpoint.method !== "POST") return headers ? { headers } : undefined;
  return {
    method: "POST",
    body:
      endpoint.body !== undefined ? resolveFeedTemplate(feed, endpoint.body, env, cell) : undefined,
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
): RequestInit | undefined {
  const entries = Object.entries(feedEndpoint(feed, role).headers ?? {})
    .filter(([, template]) => !referencesCredential(template))
    .map(([name, template]) => [name, resolveFeedTemplate(feed, template, env, cell)]);
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
): Promise<{ buffers: Buffer[]; payloads: PayloadDigest[]; failures: number; total: number }> {
  const out: Buffer[] = [];
  const payloads: PayloadDigest[] = [];
  let failures = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const url = urls[cursor++]!;
      try {
        const { buffer, payload } = await fetchOne(url, fetchFn, init, undefined, false, redact);
        if (looksLikeHtml(buffer)) {
          throw new Error("returned an HTML page, not feed data");
        }
        out.push(buffer);
        payloads.push(payload);
      } catch (err) {
        failures++;
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
  return { buffers: out, payloads, failures, total: urls.length };
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
): Promise<{ buffers: Buffer[]; payloads: PayloadDigest[] }> {
  const recordsPath = pg.recordsPath ?? "value";
  const maxPages = pg.maxPages ?? DEFAULT_MAX_PAGES;
  const out: Buffer[] = [];
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
  return { buffers: out, payloads };
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
): Promise<{ buffers: Buffer[]; payloads: PayloadDigest[] }> {
  const buffers: Buffer[] = [];
  const payloads: PayloadDigest[] = [];
  for (const url of urls) {
    const page = await fetchOne(url, authorizedFetch, init, undefined, false, redact);
    const target = followTarget(follow, page.buffer, url);
    const followed = await fetchOne(target, baseFetch, nextInit, undefined, false, redact);
    buffers.push(followed.buffer);
    payloads.push(followed.payload);
  }
  return { buffers, payloads };
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

/** A tolerant fan-out as a result: "partial" when any sub-feed failed. */
function fanoutResult(fanout: Awaited<ReturnType<typeof fetchFanout>>): FetchResult {
  if (fanout.failures > 0) {
    return {
      status: "partial",
      buffers: fanout.buffers,
      payloads: fanout.payloads,
      validatedAtNetwork: false,
      partitions: {
        succeeded: fanout.total - fanout.failures,
        failed: fanout.failures,
        total: fanout.total,
      },
    };
  }
  return {
    status: "fetched",
    accept: () => {},
    buffers: fanout.buffers,
    payloads: fanout.payloads,
    validatedAtNetwork: true,
    partitions: { succeeded: fanout.total, failed: 0, total: fanout.total },
  };
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
 */
export async function fetchEndpoint(
  feed: CatalogFeed,
  role: string,
  baseFetch: FetchFn,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const state = opts.state ?? sharedFetchState;
  const env = opts.env ?? process.env;
  const cell = opts.cell;
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
    const fanout = await fetchFanout(urls, fetchFn, redact, requestInit(feed, role, env));
    if (fanout.total === 0) {
      return { status: "no-endpoint", reason: "missing-configuration", validatedAtNetwork: false };
    }
    return fanoutResult(fanout);
  }

  // Follow: the response names the URL of the data (a download page's CSV
  // link, a batch call's presigned link). The data URL is fetched without the
  // feed's credentials, and always: the page is not the payload, so no
  // conditional request applies.
  if (endpoint.follow) {
    const pageUrls = resolveEndpointUrls(feed, role, env, cell);
    if (pageUrls.length === 0) {
      return { status: "no-endpoint", reason: "missing-configuration", validatedAtNetwork: false };
    }
    const followed = await fetchFollowing(
      pageUrls,
      endpoint.follow,
      fetchFn,
      base,
      requestInit(feed, role, env, cell),
      followedInit(feed, role, env, cell),
      redact,
    );
    return {
      status: "fetched",
      accept: () => {},
      buffers: followed.buffers,
      payloads: followed.payloads,
      validatedAtNetwork: true,
      partitions: { succeeded: pageUrls.length, failed: 0, total: pageUrls.length },
    };
  }

  // Offset pagination: follow `$skip` over a single resolved URL until the last
  // (short) page. Skips conditional-GET/`unchanged` handling (a paged resource
  // changes each cycle, so an ETag buys nothing) — like the fan-out paths above.
  if (endpoint.pagination) {
    const baseUrls = resolveEndpointUrls(feed, role, env, cell);
    if (baseUrls.length === 0) {
      return { status: "no-endpoint", reason: "missing-configuration", validatedAtNetwork: false };
    }
    const pages = await fetchPaginated(
      baseUrls,
      feed.id,
      endpoint.pagination,
      requestInit(feed, role, env, cell),
      fetchFn,
      redact,
    );
    return {
      status: "fetched",
      accept: () => {},
      buffers: pages.buffers,
      payloads: pages.payloads,
      validatedAtNetwork: true,
      partitions: { succeeded: baseUrls.length, failed: 0, total: baseUrls.length },
    };
  }

  const urls = resolveEndpointUrls(feed, role, env, cell);

  // `fanout: "tolerant"` opts a large multi-URL fan-out (one URL per site or
  // region) into the same per-URL tolerant fetcher the catalog path uses,
  // instead of the all-or-nothing `fetchAllBounded` below, so one dead sub-URL
  // yields a partial result rather than failing the poll. This skips
  // conditional-GET/`unchanged` handling entirely (fetchFanout doesn't do
  // ETag/304), the price of that tolerance. Endpoints without it (or with a
  // single URL) fall through to the static path.
  if (endpoint.fanout === "tolerant" && urls.length > 1) {
    return fanoutResult(
      await fetchFanout(urls, fetchFn, redact, requestInit(feed, role, env, cell)),
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
      requestInit(feed, role, env, cell),
      undefined,
      false,
      redact,
    );
    return {
      status: "fetched",
      accept: () => {},
      buffers: results.map((r) => r.buffer),
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
  const init = requestInit(feed, role, env);
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
      for (const url of urls) {
        const accepted = provisional.conditional.get(url);
        if (accepted) state.conditional.set(cacheKey(url), accepted);
      }
    },
    buffers: results.map((r) => r.buffer),
    payloads: results.map((r) => r.payload),
    validatedAtNetwork: true,
    partitions: { succeeded: results.length, failed: 0, total: results.length },
  };
}
