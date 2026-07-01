/**
 * SSRF + resource-limit egress guard for the ingest fetch path. Ported from
 * OpenMapX's validate-url + safe-download (OpenConditions' own core has none).
 * A URL that any feed fetches — baked-in, operator-mounted, remote-pulled, or a
 * catalog/discover result — must pass these checks before a socket opens.
 */

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
