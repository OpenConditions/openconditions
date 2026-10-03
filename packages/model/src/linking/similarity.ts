/**
 * Name, operator and address agreement for feature linking. The metric is
 * token overlap over the smaller token set, not an edit distance: sources
 * write the same site as "Parkhaus Am Markt" and "PH Am Markt (P2)", where a
 * character metric scores low but the meaningful tokens agree. Tokens the
 * whole kind shares ("parkhaus", "ladestation") carry no evidence, so a kind
 * declares them as stopwords and they are dropped before comparing.
 */

const TOKEN = /[\p{L}\p{N}]+/gu;

/** Lowercased tokens of at least two characters, minus the stopwords. */
export function tokenize(value: string, stopwords: ReadonlySet<string> = new Set()): string[] {
  const tokens = value.toLowerCase().normalize("NFC").match(TOKEN) ?? [];
  return tokens.filter((t) => t.length > 1 && !stopwords.has(t));
}

const DIRECTIONS: Readonly<Record<string, string>> = {
  n: "n",
  nord: "n",
  north: "n",
  noord: "n",
  s: "s",
  süd: "s",
  sud: "s",
  south: "s",
  zuid: "s",
  e: "e",
  o: "e",
  ost: "e",
  east: "e",
  est: "e",
  oost: "e",
  w: "w",
  west: "w",
  ouest: "w",
};

/** The compass directions a name states ("Neuhaus O", "Rastplatz Nord"). */
function directionsOf(value: string): Set<string> {
  const tokens = value.toLowerCase().normalize("NFC").match(TOKEN) ?? [];
  return new Set(tokens.flatMap((t) => (DIRECTIONS[t] === undefined ? [] : [DIRECTIONS[t]])));
}

/**
 * |A ∩ B| / min(|A|, |B|): 1 when one name's tokens are all contained in the
 * other's, so a source that adds a house number or a lot number to the same
 * name still scores 1. Empty on either side scores 0 — an absent name is no
 * evidence, never agreement. Two names that state different directions score
 * 0: the rest areas on either carriageway ("Neuhaus O", "Neuhaus W") share
 * every other token.
 */
export function tokenSimilarity(
  a: string | undefined,
  b: string | undefined,
  stopwords: ReadonlySet<string> = new Set(),
): number {
  if (a === undefined || b === undefined) return 0;
  const [da, db] = [directionsOf(a), directionsOf(b)];
  const differ = da.size !== db.size || [...da].some((d) => !db.has(d));
  if (da.size > 0 && db.size > 0 && differ) return 0;
  const left = new Set(tokenize(a, stopwords));
  const right = new Set(tokenize(b, stopwords));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance between two [lon, lat] positions, in metres. */
export function haversineMetres(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const [lonA, latA] = a;
  const [lonB, latB] = b;
  const dLat = (latB - latA) * RAD;
  const dLon = (lonB - lonA) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(latA * RAD) * Math.cos(latB * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
