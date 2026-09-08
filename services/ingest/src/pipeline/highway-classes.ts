/**
 * The road classes the spine import keeps. Six major classes by default:
 * enough for the motorway/trunk/primary network conditions are published on,
 * without pulling a country's full residential grid into `osm_road`.
 */
export const DEFAULT_HIGHWAY_CLASSES = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
];

/**
 * `SEGMENT_HIGHWAY_CLASSES` = comma list of OSM `highway` values a self-hoster
 * wants in the spine (e.g. adding `secondary` for a dense urban region).
 * Unset, empty (Compose's `${VAR:-}` unset-injection) or all-garbage → the
 * defaults. Read per call so a changed env takes effect without a reimport.
 */
export function loadHighwayClasses(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["SEGMENT_HIGHWAY_CLASSES"];
  if (raw == null || raw.trim() === "") return DEFAULT_HIGHWAY_CLASSES;
  const out: string[] = [];
  for (const token of raw.split(",")) {
    const value = token.trim();
    // Only real OSM highway values, so a typo can never inject regex
    // metacharacters into the Overpass query or a flag into osmium's argv.
    if (/^[a-z_]+$/.test(value) && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : DEFAULT_HIGHWAY_CLASSES;
}

/** Anchored alternation for an Overpass `["highway"~"…"]` clause. */
export function overpassHighwayRegex(classes: string[]): string {
  return `^(${classes.join("|")})$`;
}

/** `osmium tags-filter` expression selecting ways with any of `classes`. */
export function osmiumHighwayFilter(classes: string[]): string {
  return `w/highway=${classes.join(",")}`;
}
