/**
 * SSRF + resource-limit egress guard for the ingest fetch path. Ported from
 * OpenMapX's validate-url + safe-download (OpenConditions' own core has none).
 * A URL that any feed fetches — baked-in, operator-mounted, remote-pulled, or a
 * catalog/discover result — must pass these checks before a socket opens.
 */

import { lookup as dnsLookup } from "node:dns/promises";

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
  /^fe80:/, // link-local
];

/**
 * Throws unless `url` is a public http(s) URL. Rejects non-http(s) schemes,
 * `localhost`, and any host matching the private/loopback/link-local/CGNAT/ULA
 * denylist. Textual only — DNS resolution is checked separately by
 * {@link assertResolvesToPublicIp} to close the rebinding window.
 */
export function assertPublicUrl(url: string): void {
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
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9")) return true;
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
 * Resolves `hostname` and throws if any returned address is private, loopback,
 * link-local, CGNAT, reserved, or IPv6 ULA/link-local — closing the rebinding
 * window where {@link assertPublicUrl} approves a name but the socket lands on a
 * private address. `lookup` is injectable so tests can force a resolver result.
 */
export async function assertResolvesToPublicIp(
  hostname: string,
  lookup: LookupFn = defaultLookup
): Promise<void> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) {
    throw new Error(`No DNS records for ${hostname}`);
  }
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
}
