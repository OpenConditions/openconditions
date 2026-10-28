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
const REF_NAME = /^([A-Z]{1,2}|St|Kr) ?-? ?(\d{1,5}[a-z]?)(?=$|[\s(/,;:-])/;

/** Longer than this, a name is cut: no road's name or number runs longer. */
const MAX_NAME = 200;

/**
 * A name without its parenthesized notes (`Ruschestraße (Lichtenberg)`), cut
 * to {@link MAX_NAME}. A scan rather than a pattern, so a name of many
 * unclosed parentheses costs no more than its length.
 */
function withoutNotes(value: string, max = MAX_NAME): string {
  let out = "";
  let depth = 0;
  for (const ch of value.slice(0, max)) {
    if (ch === "(") {
      if (depth === 0) out += " ";
      depth++;
    } else if (ch === ")" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

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

/**
 * A German street named by its place rather than its type: a preposition (and
 * article) before a capitalized word (`Im Johannistal`, `An der Schanz`,
 * `Zur Alten Mühle`). Only in a stated road name: in prose the same words
 * begin any phrase. A name with a digit (`An der B 9`) names a road number.
 */
const PLACE_NAME =
  /^(Am|Im|An|Auf|In|Zum|Zur|Zu|Beim|Bei|Hinter|Hinterm|Unter|Unterm|Vor|Vorm|Über|Neben|Gegenüber)\s+((der|dem|den|die|das)\s+)?\p{Lu}[^\d]*$/u;

/**
 * A street name as compared: lower case, `ß` as `ss` and umlauts as `ae`/`oe`/`ue`
 * (`Nosswitzbruecke` is `Noßwitzbrücke`), `Straße` as `str`, no house number or note.
 */
export function normalizeName(value: string, max = MAX_NAME): string {
  return (
    withoutNotes(value, max)
      .toLowerCase()
      .replace(/ß/g, "ss")
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/stra(ss|ß)e\b|str\.(?=\s|$|-)|str\b/g, "str")
      // House numbers and ranges (`211-217`, `82a`); their dashes go with the rest below.
      .replace(/\d+[a-z]?/g, " ")
      .replace(/[^\p{L}\p{N}]/gu, "")
  );
}

/** Whether a name is a street's, by a word naming its type or by naming its place. */
export function isStreetName(value: string): boolean {
  const name = withoutNotes(value).trim();
  return (
    PLACE_NAME.test(name) ||
    name.split(/[\s,;/]+/).some((word) => STREET_WORD.test(word.replace(/[:]+$/, "")))
  );
}

/** Longer than this, a record's prose is cut: the road it is on comes first. */
const MAX_PROSE = 1000;

/** The road a location names, as {@link roadIdentity} reads it. */
export interface RoadIdentity {
  refs: string[];
  names: string[];
  /** The record's headline and description as {@link normalizeName} writes them, where its names are the prose's. */
  prose?: string;
}

/**
 * The road numbers and street names a location's roads state, normalized for
 * comparing. A location that names no road (no roads, or only a code too short
 * to be a name: Rhineland-Palatinate's `G`, the authority that entered it) takes the
 * street names its record's prose names ({@link namesInText}), and the prose
 * itself: a segment whose name the prose holds is the stated road although
 * the prose writes it without a street word (`Hamburg, Sechslingspforte`).
 * A road name the binder cannot read (`Neue Weinsteige`) still keeps the
 * prose out: the prose's streets are then its surroundings.
 */
export function roadIdentity(
  roads: Array<{ ref?: string; name?: string }>,
  text: readonly string[] = [],
): RoadIdentity {
  const refValues: string[] = [];
  const names: string[] = [];
  let namesRoad = false;
  for (const road of roads) {
    if (road.ref) refValues.push(road.ref);
    if (!road.name) continue;
    if (road.name.trim().length > 2) namesRoad = true;
    const asRef = REF_NAME.exec(road.name.trim().slice(0, MAX_NAME));
    if (asRef) refValues.push(`${asRef[1]}${asRef[2]}`);
    else if (isStreetName(road.name)) {
      const name = normalizeName(road.name);
      if (name.length >= 4 && !names.includes(name)) names.push(name);
    }
  }
  const refs = normalizeRefs(refValues);
  if (refs.length > 0 || namesRoad) return { refs, names };
  const fromText = namesInText(text);
  if (fromText.length === 0) return { refs, names: [] };
  return { refs, names: fromText, prose: normalizeName(text.join(" "), MAX_PROSE) };
}

/** A road number anywhere in prose (`B 421`, `L528`, `K19neu`, `A602`). */
const REF_IN_TEXT = /(?:^|[^\p{L}\d])(?:[A-Z]{1,2}|St|Kr) ?-? ?\d{1,5}/u;

/** A street type written as its own word, after the name's other words (`Kasselburger Weg`). */
const BARE_STREET_WORD =
  /^(stra(ss|ß)e|str\.?|weg|allee|platz|ring|damm|gasse|ufer|chaussee|steig|stieg|markt|brücke|tunnel|graben|wall|deich|pfad|promenade)$/i;

/**
 * The word before a bare street type that is part of its name: a capitalized
 * adjective (`Kasselburger Weg`, `Alter Markt`, `Hohe Straße`). A noun before
 * it (`Sperrung Brücke`) is the prose's.
 */
const NAME_ADJECTIVE = /^\p{Lu}[\p{L}-]*(er|e|en|es)$/u;

/** Capitalized words ending as an adjective does that are no part of a name (`Der Tunnel`, `Höhe Brücke`). */
const NOT_A_NAME_WORD =
  /^(der|die|das|den|dem|des|eine|einen|einem|einer|eines|diese|dieser|diesen|unter|hinter|über|wieder|oder|aber|höhe|nähe|ende|seite|baustelle|strecke|stelle|anlage|umleitungsstrecke)$/i;

/**
 * Words that end in a street type but name a kind of way or place, not one
 * street: a closed `Gehweg` or `Kreisstraße` contradicts no segment's name.
 * As {@link normalizeName} writes them.
 */
const GENERIC_WAY = new Set(
  [
    "Gehweg",
    "Radweg",
    "Fußweg",
    "Feldweg",
    "Waldweg",
    "Wirtschaftsweg",
    "Anwohnerweg",
    "Zufahrtsweg",
    "Zuweg",
    "Umleitungsweg",
    "Parkplatz",
    "Wanderparkplatz",
    "Rastplatz",
    "Spielplatz",
    "Sportplatz",
    "Festplatz",
    "Wendeplatz",
    "Weihnachtsmarkt",
    "Wochenmarkt",
    "Flohmarkt",
    "Bauernmarkt",
    "Supermarkt",
    "Straßengraben",
    "Seitengraben",
    "Bahndamm",
    "Bahnsteig",
    "Lärmschutzwall",
    "Bundesstraße",
    "Landesstraße",
    "Kreisstraße",
    "Gemeindestraße",
    "Staatsstraße",
    "Landstraße",
    "Ortsstraße",
    "Durchgangsstraße",
    "Hauptverkehrsstraße",
    "Nebenstraße",
    "Seitenstraße",
    "Anliegerstraße",
    "Zufahrtsstraße",
    "Umgehungsstraße",
    "Erschließungsstraße",
    "Baustraße",
    "Einbahnstraße",
    "Fahrradstraße",
    "Spielstraße",
    "Autobahnbrücke",
    "Eisenbahnbrücke",
    "Bahnbrücke",
    "Fußgängerbrücke",
  ].map((word) => normalizeName(word)),
);

/** A word without the full stops after it, but for an abbreviated `Str.`. */
function withoutFullStop(word: string): string {
  let end = word.length;
  while (end > 0 && word[end - 1] === ".") end--;
  if (end < word.length && /str$/i.test(word.slice(0, end))) return word.slice(0, end + 1);
  return word.slice(0, end);
}

/**
 * The street names a record's prose names (`Vollsperrung der Bahnhofstraße`,
 * `der Kasselburger Weg`), for a record whose location states no road. None
 * where the prose names a road number: a number there is as often the detour
 * (`Umleitung über die B 48`) as the road, and the streets beside it say no
 * more. Names in prose only add to what may match; the prose's other streets
 * (a detour, a crossing) keep a segment named for them from being ruled out.
 */
export function namesInText(texts: readonly string[]): string[] {
  const names: string[] = [];
  for (const text of texts) {
    const value = text.slice(0, MAX_PROSE);
    if (REF_IN_TEXT.test(value)) return [];
    const words = value.split(/[\s,;:()"„“”'!?/]+/).map(withoutFullStop);
    words.forEach((word, i) => {
      if (!STREET_WORD.test(word)) return;
      let name = word;
      if (BARE_STREET_WORD.test(word)) {
        const before = words[i - 1];
        if (!before || !NAME_ADJECTIVE.test(before) || NOT_A_NAME_WORD.test(before)) return;
        name = `${before} ${word}`;
      } else if (!/^\p{Lu}/u.test(word)) return;
      const normalized = normalizeName(name);
      if (normalized.length >= 4 && !GENERIC_WAY.has(normalized) && !names.includes(normalized)) {
        names.push(normalized);
      }
    });
  }
  return names;
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
  stated: { refs: string[]; names?: string[]; prose?: string },
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
  if (stated.prose !== undefined && wayName.length >= 5 && stated.prose.includes(wayName)) return 1;
  // A stated number decides alone: a segment without one is not ruled out by its name.
  return national.length > 0 ? 0.5 : 0;
}
