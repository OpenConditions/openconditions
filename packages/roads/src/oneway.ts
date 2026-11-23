/** Explicit vehicle one-way tags; geometry remains in OSM node order. */
export function parseOnewayTag(tag: string | undefined): {
  oneway: boolean;
  onewayReversed?: boolean;
} {
  if (tag === "-1") return { oneway: true, onewayReversed: true };
  return { oneway: tag === "yes" || tag === "true" || tag === "1" };
}
