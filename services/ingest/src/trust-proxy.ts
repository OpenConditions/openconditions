import proxyaddr from "@fastify/proxy-addr";

export const DEFAULT_TRUSTED_PROXY_RANGES = ["loopback", "linklocal", "uniquelocal"];

/**
 * Trust one reverse proxy only, and only when its peer address belongs to an
 * explicitly configured range. This keeps client-supplied X-Forwarded-For
 * entries beyond the OpenMapX proxy from influencing Fastify's `request.ip`.
 */
export function createTrustProxy(ranges: string | undefined) {
  const configuredRanges = (ranges ?? DEFAULT_TRUSTED_PROXY_RANGES.join(","))
    .split(",")
    .map((range) => range.trim())
    .filter(Boolean);
  const isTrustedAddress = proxyaddr.compile(configuredRanges);

  return (address: string, hop: number): boolean => hop === 0 && isTrustedAddress(address, hop);
}
