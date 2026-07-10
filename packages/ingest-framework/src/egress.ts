/**
 * SSRF + resource-limit egress guard for the ingest fetch path. Ported from
 * OpenMapX's validate-url + safe-download (OpenConditions' own core has none).
 * A URL that any feed fetches — baked-in, operator-mounted, remote-pulled, or a
 * catalog/discover result — must pass these checks before a socket opens.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { createGunzip } from "node:zlib";
import { Agent, fetch as undiciFetch } from "undici";

const PRIVATE_HOST_RANGES: RegExp[] = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local incl. the 169.254.169.254 cloud-metadata IP
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
  /^::1$/,
  /^f[cd]/, // fc00::/7 unique-local
  /^fe[89ab]/i, // fe80::/10 link-local (2nd byte 0x80-0xbf: fe8/fe9/fea/feb)
];

/**
 * Throws unless `url` is a public http(s) URL. Rejects non-http(s) schemes,
 * `localhost`, and any host matching the private/loopback/link-local/CGNAT/ULA
 * denylist. Textual only — DNS resolution is checked separately by
 * {@link assertResolvesToPublicIp} to close the rebinding window.
 *
 * `allowedHosts` is an operator-configured set of trusted internal hostnames
 * (e.g. a self-hosted Overpass on the compose network) that bypass the
 * private-range denylist — the scheme check always applies. Empty by default,
 * so the guard is strict unless an operator explicitly opts a host in.
 */
export function assertPublicUrl(url: string, allowedHosts?: ReadonlySet<string>): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
  const raw = parsed.hostname;
  const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (allowedHosts?.has(host.toLowerCase())) return;
  if (host === "localhost" || host === "" || PRIVATE_HOST_RANGES.some((re) => re.test(host))) {
    throw new Error("URLs targeting internal/private addresses are not allowed");
  }
}

/** Non-throwing form of {@link assertPublicUrl}. */
export function isPublicUrl(url: string): boolean {
  try {
    assertPublicUrl(url);
    return true;
  } catch {
    return false;
  }
}

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xe0000000, 0xffffffff], // 224.0.0.0/4 + 240.0.0.0/4 (multicast, reserved)
  [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function isPrivateIpv4(address: number): boolean {
  return PRIVATE_IPV4_RANGES.some(([lo, hi]) => address >= lo && address <= hi);
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  // fe80::/10 link-local: 2nd byte 0x80-0xbf, i.e. fe8/fe9/fea/feb.
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const ip = ipv4ToInt(mapped[1]!);
    if (ip !== null && isPrivateIpv4(ip)) return true;
  }
  return false;
}

export type LookupAddress = { address: string; family: number };
export type LookupFn = (
  hostname: string,
  opts: { all: true; verbatim: true }
) => Promise<LookupAddress[]>;

const defaultLookup: LookupFn = (hostname, opts) =>
  dnsLookup(hostname, opts) as Promise<LookupAddress[]>;

/**
 * Resolves `hostname`, validates every returned address (rejecting private,
 * loopback, link-local, CGNAT, reserved, and IPv6 ULA/link-local), and RETURNS
 * the validated addresses so the caller can PIN the connection to one of them —
 * closing the DNS-rebinding TOCTOU where a second, independent resolution inside
 * the network stack could land the socket on a private address the check never
 * saw. `lookup` is injectable so tests can force a resolver result.
 */
export async function resolvePublicIps(
  hostname: string,
  lookup: LookupFn = defaultLookup,
  opts: { allowPrivate?: boolean } = {}
): Promise<LookupAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) {
    throw new Error(`No DNS records for ${hostname}`);
  }
  // An operator-allowlisted host still resolves (so the connection can be pinned
  // to the returned address — no unchecked second lookup), but skips the
  // private-IP rejection. Trust is explicit and host-scoped, so there is no
  // rebinding gap: we allow the private address AND dial exactly it.
  if (opts.allowPrivate) return addresses;
  for (const { address, family } of addresses) {
    if (family === 4) {
      const int = ipv4ToInt(address);
      if (int === null || isPrivateIpv4(int)) {
        throw new Error(`Hostname ${hostname} resolves to private IP ${address}`);
      }
    } else if (family === 6) {
      if (isPrivateIpv6(address)) {
        throw new Error(`Hostname ${hostname} resolves to private IP ${address}`);
      }
    }
  }
  return addresses;
}

/**
 * Throwing-only form of {@link resolvePublicIps} that discards the addresses —
 * kept for callers that only need the validation, not the pinned result.
 */
export async function assertResolvesToPublicIp(
  hostname: string,
  lookup: LookupFn = defaultLookup
): Promise<void> {
  await resolvePublicIps(hostname, lookup);
}

export interface FetchGuardOptions {
  /** Max response-body bytes (declared + streamed). Aborts mid-stream when exceeded. */
  maxBytes: number;
  /** Per-attempt timeout applied via an AbortSignal. */
  timeoutMs: number;
  /** Cap on redirect hops before giving up. */
  maxRedirects: number;
  /**
   * Operator-configured trusted internal hostnames (lowercased) that bypass the
   * private-IP rejection — every other check (scheme, redirect re-validation,
   * size/timeout caps) still applies, and a redirect to a NON-allowed host is
   * still rejected. Undefined/empty keeps the guard strict.
   */
  allowedHosts?: ReadonlySet<string>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Redact query-string values so a rejected URL never leaks a credential into logs. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/** Wrap a response body in a stream that errors once the running byte total passes `maxBytes`. */
function capBody(res: Response, maxBytes: number, url: string): Response {
  const declared = res.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      void res.body?.cancel().catch(() => {});
      throw new Error(`Content-Length ${n} exceeds max ${maxBytes} for ${redact(url)}`);
    }
  }
  if (!res.body) return res;
  let seen = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new Error(`response body exceeded ${maxBytes} bytes for ${redact(url)}`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(res.body.pipeThrough(limiter), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Optional mTLS material folded into the pinned dispatcher's `connect`. */
export interface GuardedConnectOptions {
  cert?: string;
  key?: string;
  ca?: string;
}

// `dispatcher` is an undici extension to the standard RequestInit — undici's
// fetch reads it, a test's fake baseFetch ignores it.
type PinnedInit = RequestInit & { dispatcher?: unknown };

/**
 * Wraps `baseFetch` with the egress guard: validates the URL (scheme +
 * private-range + DNS), follows redirects manually so every `Location` is
 * re-validated (feeds rely on 302s, so this is the real SSRF bypass), applies a
 * timeout AbortSignal per hop, and caps the streamed body size.
 *
 * The guard PINS the connection: it resolves+validates the hostname ONCE, then
 * dials exactly that address via a per-hop undici Agent whose `connect.lookup`
 * returns the pre-validated IP (the Host header and TLS SNI stay the original
 * hostname). This closes the DNS-rebinding TOCTOU — a short-TTL name cannot pass
 * the check and then re-resolve to a private IP for the actual socket. Because
 * the dispatcher is honored by undici's fetch, `baseFetch` MUST default to
 * undici's fetch. `connect` carries optional mTLS material so the mTLS path pins
 * on the SAME dispatcher. `lookup` is injectable for tests.
 */
export function guardedFetch(
  baseFetch: typeof fetch = undiciFetch as unknown as typeof fetch,
  opts: FetchGuardOptions = guardOptionsFromEnv(),
  connect: GuardedConnectOptions = {},
  lookup: LookupFn = defaultLookup
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const startUrl = urlOf(input);
    let currentUrl = startUrl;
    let currentInit: RequestInit = { ...(init ?? {}) };

    for (let hop = 0; hop <= opts.maxRedirects; hop++) {
      assertPublicUrl(currentUrl, opts.allowedHosts);
      const rawHost = new URL(currentUrl).hostname;
      // `URL.hostname` keeps the brackets on an IPv6 literal (e.g. "[::1]"),
      // which dns.lookup cannot parse; strip them for the DNS check, mirroring
      // the bracket-strip assertPublicUrl already does.
      const host =
        rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
      const allowPrivate = opts.allowedHosts?.has(host.toLowerCase()) ?? false;
      const addrs = await resolvePublicIps(host, lookup, { allowPrivate });
      const pinned = addrs[0]!;

      // Per-hop dispatcher that dials the exact validated IP. `connect.lookup`
      // receives the ORIGINAL hostname (so Host/SNI stay correct) but resolves
      // it to the pinned address — no second, unchecked DNS resolution happens.
      const agent = new Agent({
        connect: {
          lookup: (
            _h: string,
            _o: unknown,
            cb: (e: Error | null, addrs: LookupAddress[]) => void
          ) => cb(null, [{ address: pinned.address, family: pinned.family }]),
          ...(connect.cert ? { cert: connect.cert, key: connect.key, ca: connect.ca } : {}),
        },
      });

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`fetch timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs
      );
      let res: Response;
      try {
        res = await baseFetch(currentUrl, {
          ...currentInit,
          redirect: "manual",
          signal: controller.signal,
          dispatcher: agent,
        } as PinnedInit);
      } finally {
        clearTimeout(timer);
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        void res.body?.cancel().catch(() => {});
        void agent.close().catch(() => {}); // this hop is done — release its socket
        if (!location) {
          throw new Error(`redirect ${res.status} without Location from ${redact(currentUrl)}`);
        }
        const next = new URL(location, currentUrl).toString();
        // Re-validate the hop before the next iteration checks DNS. The allowlist
        // is passed too, so a redirect to a NON-allowed private host is still rejected.
        assertPublicUrl(next, opts.allowedHosts);
        // A 303 downgrades to GET and drops the body; 307/308 preserve method + body.
        if (res.status === 303) currentInit = { ...currentInit, method: "GET", body: undefined };
        // Mirror browser redirect behavior: a cross-origin hop must not replay
        // credentials the outer caller (e.g. makeAuthorizedFetch) injected for the
        // ORIGINAL host onto a DIFFERENT host.
        if (new URL(next).host !== new URL(currentUrl).host) {
          const h = new Headers(currentInit.headers);
          h.delete("authorization");
          h.delete("cookie");
          h.delete("proxy-authorization");
          currentInit = { ...currentInit, headers: h };
        }
        currentUrl = next;
        continue;
      }

      // Final hop: do NOT close the agent here — its socket still carries the
      // body being returned. Left to GC + undici's keepAliveTimeout.
      return capBody(res, opts.maxBytes, currentUrl);
    }
    throw new Error(`too many redirects (>${opts.maxRedirects}) fetching ${redact(startUrl)}`);
  }) as typeof fetch;
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  // Compose injects "" for an unset ${VAR:-}; treat empty as absent.
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parses a comma-separated hostname list into a lowercased Set, or undefined
 * when unset/empty (Compose's `${VAR:-}`). These hosts bypass the private-IP
 * rejection — an operator lists a self-hosted service they explicitly trust
 * (e.g. `overpass` for a same-network Overpass instance).
 */
export function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const hosts = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  return hosts.length > 0 ? new Set(hosts) : undefined;
}

/**
 * Default ceiling on a feed's decompressed / response bytes. Sized above the
 * largest legitimate default-enabled feed — NDW's site table
 * (measurement.xml.gz) decompresses to ~373 MiB. That table (and the flow
 * feeds) are processed as a stream (SAX, one chunk at a time), so this cap
 * bounds cumulative bytes seen, not resident memory: raising it lets a large
 * legitimate feed complete without increasing RSS (which stays bounded by the
 * per-chunk read plus the small retained site-id map). A true decompression
 * bomb is still bounded by this finite cap plus the fetch timeout. Overridable
 * via OPENCONDITIONS_MAX_FEED_BYTES.
 */
export const DEFAULT_MAX_FEED_BYTES = 512 * 1024 * 1024;

/** Reads the guard caps from the environment (defaults ~512 MB / 60 s / 5 hops). */
export function guardOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FetchGuardOptions {
  return {
    maxBytes: envInt(env, "OPENCONDITIONS_MAX_FEED_BYTES", DEFAULT_MAX_FEED_BYTES),
    timeoutMs: envInt(env, "OPENCONDITIONS_FETCH_TIMEOUT_MS", 60_000),
    maxRedirects: envInt(env, "OPENCONDITIONS_MAX_REDIRECTS", 5),
    allowedHosts: parseAllowedHosts(env["OPENCONDITIONS_EGRESS_ALLOWED_HOSTS"]),
  };
}

/**
 * Gunzip `raw` while capping the DECOMPRESSED size. Streams through zlib and
 * throws the moment the running decompressed total passes `maxBytes`, so a
 * highly-compressed "gzip bomb" cannot expand into an OOM.
 */
export async function boundedGunzip(raw: Buffer, maxBytes: number): Promise<Buffer> {
  const gunzip = createGunzip();
  gunzip.end(raw); // write the whole compressed buffer, close the writable side
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of gunzip as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      gunzip.destroy();
      throw new Error(`gunzip output exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
