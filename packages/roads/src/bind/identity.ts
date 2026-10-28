/**
 * Which road a location names, and whether a spine segment is that road. A
 * location names a road by its number (`A 46`, `B410`, `K 32`) or by its
 * street name (`Hermannstraße`); OSM carries both as a way's `ref` and `name`.
 * A stated identity that the segment contradicts rules the segment out: the
 * nearest road is not the road a side street's roadworks are on.
 */

import { normalizeRefs } from "./refs.js";

/**
 * A name written as a road number: a class letter or two in capitals (or
 * Bavaria's `St`, a district's `Kr`), then the number (`A100 (Stadtring)`,
 * `L 523`, `St 2240`). A word before a number (`Tie 40`, Finnish for road
 * 40) is no class letter.
 */
const REF_NAME = /^\s*([A-Z]{1,2}|St|Kr)\s*-?\s*(\d{1,5}[a-z]?)(?=$|[\s(/,;:-])/;

/** A European route number, as normalized. */
const EUROPEAN_ROUTE = /^E\d+$/;

/**
 * Words naming a street's type, as street names end or begin with them, in
 * the languages the feeds write. Only a name with one is a street name: a
 * feed's route description (`Stuttgart-Großbottwar`) names no road a segment
 * could contradict.
 */
const STREET_WORD =
  /(stra(ss|ß)e|str\.?|weg|allee|platz|ring|damm|gasse|ufer|chaussee|steig|stieg|markt|brücke|tunnel|graben|wall|deich|twiete|kamp|pfad|promenade)$|^(street|road|avenue|lane|drive|boulevard|rue|avenida|calle|via|viale|straat|laan|weg|gracht|kade|plein|dreef|plaza|place)$|(straat|laan|weg|gracht|kade|plein|dreef|gatan|vägen|vej|gade|tie|katu)$/i;

/** A street name as compared: lower case, `ß` as `ss`, `Straße` as `str`, no house number or note. */
export function normalizeName(value: string): string {
  return value
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/stra(ss|ß)e\b|str\.(?=\s|$|-)|str\b/g, "str")
    .replace(/\b\d+[a-z]?(\s*[-–/]\s*\d+[a-z]?)?\b/g, " ")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Whether a name is a street's, by a word naming its type. */
export function isStreetName(value: string): boolean {
  return value
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s,;/]+/)
    .some((word) => STREET_WORD.test(word.replace(/[:]+$/, "")));
}

/** The road numbers and street names a location's roads state, normalized for comparing. */
export function roadIdentity(roads: Array<{ ref?: string; name?: string }>): {
  refs: string[];
  names: string[];
} {
  const refValues: string[] = [];
  const names: string[] = [];
  for (const road of roads) {
    if (road.ref) refValues.push(road.ref);
    if (!road.name) continue;
    const asRef = REF_NAME.exec(road.name);
    if (asRef) refValues.push(`${asRef[1]}${asRef[2]}`);
    else if (isStreetName(road.name)) {
      const name = normalizeName(road.name);
      if (name.length >= 4 && !names.includes(name)) names.push(name);
    }
  }
  return { refs: normalizeRefs(refValues), names };
}

/** Whether a stated street name and an OSM way's name are one street's. */
function sameName(stated: string, wayName: string): boolean {
  if (stated === wayName) return true;
  // One name inside the other: `werrenstrkreuzungsbereichgaensbergstr` holds
  // `werrenstr`, and a note the source wrote after the name holds it too.
  return (
    (wayName.length >= 5 && stated.includes(wayName)) ||
    (stated.length >= 5 && wayName.includes(stated))
  );
}

/**
 * How a segment's road agrees with the location's: 1 when its number or name
 * is the stated one, 0 when the location states one the segment contradicts,
 * 0.5 when neither says. A stated number decides alone; a stated street name
 * decides where the location states no number.
 */
export function identityScore(
  stated: { refs: string[]; names?: string[] },
  segment: { ref: string | null; name?: string | null },
): 1 | 0.5 | 0 {
  const segmentRefs = normalizeRefs([segment.ref]);
  if (segmentRefs.some((r) => stated.refs.includes(r))) return 1;
  // A European route number (`E40`) is OSM's `int_ref`, never the national
  // `ref` compared here, so it contradicts no segment's number.
  const national = stated.refs.filter((r) => !EUROPEAN_ROUTE.test(r));
  if (national.length > 0 && segmentRefs.length > 0) return 0;
  const wayName = segment.name ? normalizeName(segment.name) : "";
  const names = stated.names ?? [];
  if (names.length === 0 || wayName === "") return 0.5;
  if (names.some((n) => sameName(n, wayName))) return 1;
  // A stated number decides alone: a segment without one is not ruled out by its name.
  return national.length > 0 ? 0.5 : 0;
}
