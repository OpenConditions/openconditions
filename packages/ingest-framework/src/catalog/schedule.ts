import type { CatalogFeed } from "./types.js";

/**
 * The data roles of a feed to fetch now: every endpoint without a decoder whose
 * `cadenceSec` has elapsed since `lastFetchedAt[role]` (epoch ms), and every
 * such role on the first poll. Reference endpoints refresh on their own
 * cadence through the reference loader, never here.
 */
export function dueRoles(
  feed: CatalogFeed,
  lastFetchedAt: Readonly<Record<string, number>>,
  now: number,
): string[] {
  return Object.entries(feed.endpoints)
    .filter(([role, endpoint]) => {
      if (endpoint.decoder !== undefined) return false;
      const last = lastFetchedAt[role];
      return last === undefined || now - last >= endpoint.cadenceSec * 1000;
    })
    .map(([role]) => role);
}
