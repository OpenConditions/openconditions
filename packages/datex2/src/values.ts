import { isPlausibleWgs84, reprojectorFor } from "@openconditions/ingest-framework";
import {
  getXmlAttribute,
  getXmlChildText,
  isXmlObject,
  stripXmlNamespace,
  type XmlObject,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

/**
 * Value decoders shared by every DATEX II publication.
 *
 * DATEX documents arrive parsed two ways: with namespace prefixes stripped (the
 * roads situation parser) and with them kept (`par:parkingRecord`). The
 * `local*` readers match an element or attribute by its local name, trying the
 * exact name first, so they read either form.
 */

function localKey(node: XmlObject, name: string, prefix = ""): string | undefined {
  if (`${prefix}${name}` in node) return `${prefix}${name}`;
  for (const key of Object.keys(node)) {
    if (!key.startsWith(prefix)) continue;
    if (prefix === "" && key.startsWith("@_")) continue;
    if (stripXmlNamespace(key.slice(prefix.length)) === name) return key;
  }
  return undefined;
}

/** The single child element with this local name, when it is an element. */
export function localChild(node: unknown, name: string): XmlObject | undefined {
  if (!isXmlObject(node)) return undefined;
  const key = localKey(node, name);
  if (key === undefined) return undefined;
  const child = node[key];
  return isXmlObject(child) ? child : undefined;
}

/** Every child element with this local name, in document order. */
export function localChildren(node: unknown, name: string): XmlObject[] {
  if (!isXmlObject(node)) return [];
  const key = localKey(node, name);
  return key === undefined ? [] : xmlNodeToArray(node[key]).filter(isXmlObject);
}

/** Text of every child with this local name, leaves and attributed elements alike. */
export function localChildTexts(node: unknown, name: string): string[] {
  if (!isXmlObject(node)) return [];
  const key = localKey(node, name);
  if (key === undefined) return [];
  return xmlNodeToArray(node[key])
    .map((v) => xmlText(v)?.trim())
    .filter((v): v is string => v !== undefined && v !== "");
}

/** Text of the first child with this local name. */
export function localChildText(node: unknown, name: string): string | undefined {
  return localChildTexts(node, name)[0];
}

/** An attribute by its local name (`type` reads `xsi:type`). */
export function localAttribute(node: unknown, name: string): string | undefined {
  if (!isXmlObject(node)) return undefined;
  const key = localKey(node, name, "@_");
  return key === undefined ? undefined : xmlText(node[key]);
}

/** The record's class from its `xsi:type`, without the namespace prefix. */
export function elementType(rec: XmlObject): string {
  const raw = localAttribute(rec, "type") ?? "";
  const colonIdx = raw.indexOf(":");
  return colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
}

/**
 * The publisher's own record identity, or an empty string when it supplied
 * none. Identity must never be invented: a generated id would look like a new
 * record on every poll, and the previous one would look withdrawn.
 */
export function recId(rec: XmlObject): string {
  // xsi-typed records carry an `id` attribute; substitution-group records (e.g.
  // National Highways) carry a stable `<idG>` leaf instead.
  return (
    getXmlAttribute(rec, "id") ?? getXmlChildText(rec, "idG") ?? getXmlChildText(rec, "id") ?? ""
  );
}

export interface RecordBodyOptions {
  /** Field names that mark a node as the record body rather than a wrapper. */
  markers: readonly string[];
  /** The substitution-group prefix on the wrapper's name (`sit` in `sitAccident`). */
  classPrefix: string;
}

/**
 * Resolve the effective record body and its class name. Most DATEX feeds put the
 * fields directly on the record element with an `xsi:type`. Others use the v3
 * substitution group: `<record><sit{Class}>…fields…</sit{Class}></record>` with
 * no `xsi:type`. There the real body is one level down, and the wrapper element
 * name carries the record class.
 */
export function recordBody(
  rawRec: XmlObject,
  { markers, classPrefix }: RecordBodyOptions,
): { body: XmlObject; className?: string } {
  if (markers.some((m) => m in rawRec)) return { body: rawRec };
  for (const [key, value] of Object.entries(rawRec)) {
    if (key.startsWith("@_")) continue;
    const child = xmlNodeToArray(value).find(isXmlObject);
    if (child && markers.some((m) => m in child)) {
      const stripped = stripXmlNamespace(key);
      const className = stripped.startsWith(classPrefix)
        ? stripped.slice(classPrefix.length)
        : stripped;
      return { body: child, className };
    }
  }
  return { body: rawRec };
}

const BCP47 = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * A DATEX multilingual block in every language it carries, in document order
 * (the publisher's primary first). A value without a usable `lang` is
 * undetermined (`und`); a block with no `values` is its plain text.
 */
export function multilingual(node: unknown): { lang: string; value: string }[] {
  const out: { lang: string; value: string }[] = [];
  const values = localChild(node, "values");
  if (values) {
    for (const v of localChildren(values, "value")) {
      const value = xmlText(v)?.trim();
      if (!value) continue;
      const lang = localAttribute(v, "lang")?.trim();
      const entry = { lang: lang && BCP47.test(lang) ? lang : "und", value };
      if (!out.some((e) => e.lang === entry.lang && e.value === entry.value)) out.push(entry);
    }
  } else {
    const value = xmlText(node)?.trim();
    if (value) out.push({ lang: "und", value });
  }
  return out;
}

export type Reprojector = (p: [number, number]) => [number, number];

/**
 * GML `posList` / `pos` to `[lon,lat]` pairs (finite only). Under WGS84 the
 * values are "lat lon" → swapped to GeoJSON order, unless `lonFirst` (the feed
 * publishes "lon lat", e.g. Trafikverket) → kept as-is. When a `reproject` is
 * given (the feed's geometry is a projected grid, e.g. Flanders EPSG:31370) the
 * values are "easting northing" in CRS axis order → reprojected to [lon,lat].
 */
export function parseLatLonList(
  raw: string | undefined,
  reproject?: Reprojector | null,
  lonFirst = false,
): [number, number][] {
  if (!raw) return [];
  const nums = raw.trim().split(/\s+/).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const a = nums[i]!;
    const b = nums[i + 1]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push(reproject ? reproject([a, b]) : lonFirst ? [a, b] : [b, a]);
  }
  return out;
}

/** The first projected `srsName` in the document, as a reprojector to WGS84
 * (null when the feed is already WGS84). Feeds use a single CRS throughout. */
export function detectReprojector(input: string | Buffer): Reprojector | null {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const matches = text.match(/srsName="([^"]+)"/g);
  if (!matches) return null;
  for (const m of matches) {
    const r = reprojectorFor(m.slice(9, -1));
    if (r) return r;
  }
  return null;
}

/**
 * Coordinate lists hiding in leaves that no element name identifies.
 *
 * Hamburg publishes its geometry as a bare `posList` wrapped in an element
 * literally called `any` — an XSD wildcard the publisher never named — so
 * nothing keyed on element names could find it. Content identifies it instead:
 * a whitespace-separated run of numbers that reads as a sequence of plausible
 * WGS84 pairs is a coordinate list, whatever it is called. Requiring at least
 * two valid pairs keeps arbitrary numeric text from qualifying.
 */
export function unnamedCoordinateLists(
  node: unknown,
  reproject?: Reprojector | null,
  lonFirst = false,
): [number, number][][] {
  const out: [number, number][][] = [];

  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isXmlObject(n)) return;
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_")) continue;
      if (isXmlObject(value) || Array.isArray(value)) {
        walk(value);
        continue;
      }
      const raw = xmlText(value);
      if (!raw || !/^[\d\s.eE+-]+$/.test(raw)) continue;
      const coords = parseLatLonList(raw, reproject, lonFirst);
      if (coords.length >= 2 && coords.every(isPlausibleWgs84)) out.push(coords);
    }
  };

  walk(node);
  return out;
}

/**
 * Every coordinate in a subtree expressed as explicit latitude/longitude
 * leaves, whatever element carries them.
 *
 * Deliberately name-agnostic: allow-listing element names one at a time is what
 * lost `locationForDisplay`, and the next publisher will use a name nobody has
 * seen. An element carrying both a finite latitude and longitude is a
 * coordinate regardless of what it is called.
 */
export function displayCoordinates(
  node: unknown,
  reproject?: Reprojector | null,
): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<string>();

  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isXmlObject(n)) return;

    const lat = Number(getXmlChildText(n, "latitude"));
    const lon = Number(getXmlChildText(n, "longitude"));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const p = reproject ? reproject([lon, lat]) : ([lon, lat] as [number, number]);
      const key = `${p[0]},${p[1]}`;
      // The same position is often repeated (an area's display point echoed by
      // an extension); one place should not become several markers.
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (!key.startsWith("@_")) walk(value);
    }
  };

  walk(node);
  return out;
}

/**
 * The point a location names, as WGS84 `[lon, lat]`: the first element in the
 * subtree carrying latitude and longitude leaves (`pointCoordinates` under a
 * `pointByCoordinates`, a v3 `locationForDisplay`). A point at 0,0 is a
 * publisher's placeholder and a point outside WGS84 range is a projected grid
 * nobody declared; neither is a place.
 */
export function pointOf(node: unknown): [number, number] | undefined {
  let found: [number, number] | null | undefined;

  const walk = (n: unknown): void => {
    if (found !== undefined) return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isXmlObject(n)) return;
    const latRaw = localChildText(n, "latitude");
    const lonRaw = localChildText(n, "longitude");
    if (latRaw !== undefined && lonRaw !== undefined) {
      const point: [number, number] = [Number(lonRaw), Number(latRaw)];
      found = isPlausibleWgs84(point) && !(point[0] === 0 && point[1] === 0) ? point : null;
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (!key.startsWith("@_")) walk(value);
    }
  };

  walk(node);
  return found ?? undefined;
}
