import fc from "fast-check";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

/**
 * Random documents for the parsers and exporters: real fixtures and records
 * the standards allow, changed at random in the ways publishers get them
 * wrong or merely unusual. A run is seeded, so CI sees the same documents
 * every time and a failure names the seed and path that reproduce it.
 */

/** The seed every run starts from unless `FUZZ_SEED` names another. */
export const FUZZ_SEED = 20_261_020;

const scale = (): number => {
  const raw = Number(process.env["FUZZ_SCALE"] ?? "1");
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
};

/**
 * The fast-check parameters for a property: `runs` documents, multiplied by
 * `FUZZ_SCALE` for a longer search, from `FUZZ_SEED` (a number, or `random`
 * for a new one each run, which the failure report names).
 */
export function fuzzParameters<T>(runs: number): fc.Parameters<T> {
  const seedEnv = process.env["FUZZ_SEED"];
  const seed =
    seedEnv === "random"
      ? Math.floor(Math.random() * 0x7fffffff)
      : seedEnv !== undefined && Number.isInteger(Number(seedEnv))
        ? Number(seedEnv)
        : FUZZ_SEED;
  return { seed, numRuns: Math.max(1, Math.round(runs * scale())) };
}

/** A test timeout for a property that takes about `ms` at the default scale. */
export const fuzzTimeout = (ms: number): number => Math.round(ms * scale()) + 10_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
/** Where a value sits in a document: object keys and array indexes from the root. */
export type JsonPath = readonly (string | number)[];

/** Keys every plain object answers through its prototype: a lookup table read with them must not. */
export const INHERITED_KEYS = [
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "prototype",
] as const;

/** Language tags that are odd but well formed, malformed, or not tags at all. */
export const ODD_LANGUAGE_TAGS = [
  "",
  "x",
  "EN",
  "en_GB",
  "de-DE-u-co-phonebk",
  "zh-Hant-TW",
  "sr-Latn-RS",
  "i-klingon",
  "x-private",
  "und",
  "mul",
  "zxx",
  "en-",
  "-en",
  "en--gb",
  "en-GB-oxendict-x-a-very-long-private-use-subtag",
  `a-${"b".repeat(80)}`,
  "constructor",
] as const;

/** Text that is legal JSON but hard on whatever reads or re-encodes it. */
export const AWKWARD_TEXT = [
  "",
  " ",
  "\t\n",
  "\u0000",
  "a\u0001b\u0008c\u000bd\u000ce\u001ff",
  "\u007f\u0085\u009f",
  "\uD800",
  "x\uDC00y",
  "\uFFFE\uFFFF",
  "\u200b\u200e\u2028\u2029",
  "😀👨‍👩‍👧",
  "ﬁ Å Å",
  "<b>&amp;</b>]]>",
  "' OR 1=1 --",
  "%s%n",
  "-0",
  "NaN",
  "1e309",
  "null",
  "x".repeat(10_000),
] as const;

/** Times at the edges of what ISO 8601 and RFC 3339 allow, and some just past them. */
export const AWKWARD_TIMES = [
  "0000-01-01T00:00:00Z",
  "0001-01-01T00:00:00Z",
  "9999-12-31T23:59:59Z",
  "1970-01-01T00:00:00Z",
  "2026-02-29T00:00:00Z",
  "2024-02-29T12:00:00Z",
  "2026-10-20T25:00:00Z",
  "2016-12-31T23:59:60Z",
  "2026-10-20",
  "2026-10-20T10:00",
  "2026-10-20T10:00:00",
  "2026-10-20T10:00:00.123456789Z",
  "2026-10-20T10:00:00+14:00",
  "2026-10-20T10:00:00-12:00",
  "2026-10-20T10:00:00+0200",
  "2026-03-29T02:30:00",
  "2026-10-25T02:30:00",
  "2026-10-20 10:00:00",
  "20261020T100000Z",
  "+012026-10-20T10:00:00Z",
] as const;

/** Numbers at the edges of a double and of coordinate ranges. */
export const AWKWARD_NUMBERS = [
  0,
  -0,
  -1,
  1,
  0.5,
  1e308,
  -1e308,
  5e-324,
  Number.MAX_SAFE_INTEGER + 2,
  -Number.MAX_SAFE_INTEGER - 2,
  90.0000001,
  -90.0000001,
  180.0000001,
  -180.0000001,
  1e15,
  2_147_483_648,
] as const;

/** Whether a string is probably a timestamp, so a mutation offers times for it. */
const looksLikeTime = (s: string) => /^\d{4}-\d\d-\d\d/.test(s);

/** One change to a document, applied where `at` lands among its mutable places. */
export interface Mutation {
  /** Which place, modulo their number. */
  at: number;
  op: MutationOp;
}

/** What a mutation does at its place. */
export type MutationOp =
  | { kind: "delete" }
  | { kind: "null" }
  | { kind: "enum"; pick: number }
  | { kind: "text"; value: string }
  | { kind: "time"; value: string }
  | { kind: "language"; value: string }
  | { kind: "number"; value: number }
  | { kind: "flip" }
  | { kind: "empty" }
  | { kind: "duplicate"; index: number }
  | { kind: "drop"; index: number }
  | { kind: "inherited-key"; key: string }
  | { kind: "retype"; to: "string" | "number" | "object" | "array" | "boolean" };

const opArbitrary = (keepTypes: boolean): fc.Arbitrary<MutationOp> => {
  const ops: fc.Arbitrary<MutationOp>[] = [
    fc.constant({ kind: "delete" as const }),
    fc.nat().map((pick) => ({ kind: "enum" as const, pick })),
    fc.nat().map((pick) => ({ kind: "enum" as const, pick })),
    fc
      .oneof(fc.constantFrom(...AWKWARD_TEXT), fc.string({ unit: "binary", maxLength: 40 }))
      .map((value) => ({ kind: "text" as const, value })),
    fc.constantFrom(...AWKWARD_TIMES).map((value) => ({ kind: "time" as const, value })),
    fc.constantFrom(...ODD_LANGUAGE_TAGS).map((value) => ({ kind: "language" as const, value })),
    fc
      .oneof(
        fc.constantFrom(...AWKWARD_NUMBERS),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.integer(),
      )
      .map((value) => ({ kind: "number" as const, value })),
    fc.constant({ kind: "flip" as const }),
    fc.constant({ kind: "empty" as const }),
    fc.nat().map((index) => ({ kind: "duplicate" as const, index })),
    fc.nat().map((index) => ({ kind: "drop" as const, index })),
    fc.constantFrom(...INHERITED_KEYS).map((key) => ({ kind: "inherited-key" as const, key })),
  ];
  if (!keepTypes) {
    ops.push(
      fc.constant({ kind: "null" as const }),
      fc
        .constantFrom("string", "number", "object", "array", "boolean" as const)
        .map((to) => ({ kind: "retype" as const, to })),
    );
  }
  return fc.oneof(...ops);
};

/** A list of mutations to apply in order. */
export const mutations = (
  options: { keepTypes?: boolean; max?: number } = {},
): fc.Arbitrary<Mutation[]> =>
  fc.array(fc.record({ at: fc.nat(), op: opArbitrary(options.keepTypes ?? false) }), {
    minLength: 1,
    maxLength: options.max ?? 4,
  });

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Sets an own property, even one named `__proto__`, which plain assignment would not create. */
function own(obj: JsonObject, key: string, value: Json): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Every place below the root a mutation may land on, in document order. */
function places(doc: Json, within: (path: JsonPath) => boolean): JsonPath[] {
  const out: JsonPath[] = [];
  const walk = (node: Json, path: (string | number)[]) => {
    if (path.length > 0 && within(path)) out.push([...path]);
    if (Array.isArray(node)) for (const [i, child] of node.entries()) walk(child, [...path, i]);
    else if (isObject(node))
      for (const [k, child] of Object.entries(node)) walk(child, [...path, k]);
  };
  walk(doc, []);
  return out;
}

/** The value at a path and its parent, when the path still resolves. */
function locate(doc: Json, path: JsonPath): { parent: Json; key: string | number } | undefined {
  let node: Json = doc;
  for (const step of path.slice(0, -1)) {
    if (Array.isArray(node) && typeof step === "number" && step < node.length) node = node[step]!;
    else if (isObject(node) && typeof step === "string" && Object.hasOwn(node, step))
      node = node[step]!;
    else return undefined;
  }
  const key = path[path.length - 1]!;
  if (
    Array.isArray(node)
      ? typeof key === "number" && key < node.length
      : isObject(node) && Object.hasOwn(node, key as string)
  )
    return { parent: node, key };
  return undefined;
}

/** The property name a path ends in, or the one holding the array it ends in. */
const propertyOf = (path: JsonPath): string | undefined => {
  for (let i = path.length - 1; i >= 0; i--)
    if (typeof path[i] === "string") return path[i] as string;
  return undefined;
};

export interface JsonMutationOptions {
  /** Where a mutation may land: below a document's records, so its envelope stays readable. */
  within?: (path: JsonPath) => boolean;
  /** Enumerated values by the property name they are the value of, from the standard's schema. */
  enums?: ReadonlyMap<string, readonly string[]>;
  /** Values to swap any string for, where its property has no enumeration of its own. */
  pool?: readonly string[];
}

/**
 * A mutated copy of a JSON document and what was done to it. Mutations that
 * no longer find their place (a parent deleted by an earlier one) do nothing.
 */
export function mutateJson(
  doc: unknown,
  list: readonly Mutation[],
  options: JsonMutationOptions = {},
): { doc: unknown; applied: string[] } {
  const copy = structuredClone(doc) as Json;
  const all = places(copy, options.within ?? (() => true));
  const applied: string[] = [];
  if (all.length === 0) return { doc: copy, applied };
  for (const { at, op } of list) {
    const path = all[at % all.length]!;
    const found = locate(copy, path);
    if (!found) continue;
    const { parent, key } = found;
    const current = (parent as Record<string | number, Json>)[key]!;
    const set = (value: Json) => {
      if (Array.isArray(parent)) parent[key as number] = value;
      else own(parent as JsonObject, key as string, value);
    };
    const property = propertyOf(path);
    const enumValues =
      (property !== undefined && options.enums?.get(property)) || options.pool || [];
    let done: string | undefined;
    switch (op.kind) {
      case "delete":
        if (Array.isArray(parent)) parent.splice(key as number, 1);
        else delete (parent as JsonObject)[key as string];
        done = "delete";
        break;
      case "null":
        set(null);
        done = "null";
        break;
      case "enum":
        if (typeof current === "string" && enumValues.length > 0) {
          set(enumValues[op.pick % enumValues.length]!);
          done = `enum ${JSON.stringify(enumValues[op.pick % enumValues.length])}`;
        }
        break;
      case "text":
      case "language":
        if (typeof current === "string") {
          set(op.value);
          done = `${op.kind} ${JSON.stringify(op.value.slice(0, 60))}`;
        }
        break;
      case "time":
        if (typeof current === "string" && looksLikeTime(current)) {
          set(op.value);
          done = `time ${op.value}`;
        }
        break;
      case "number":
        if (typeof current === "number") {
          set(op.value);
          done = `number ${op.value}`;
        }
        break;
      case "flip":
        if (typeof current === "boolean") {
          set(!current);
          done = "flip";
        }
        break;
      case "empty":
        if (Array.isArray(current)) set([]);
        else if (isObject(current)) set({});
        else if (typeof current === "string") set("");
        else break;
        done = "empty";
        break;
      case "duplicate":
        if (Array.isArray(current) && current.length > 0) {
          const i = op.index % current.length;
          current.splice(i, 0, structuredClone(current[i]!));
          done = `duplicate [${i}]`;
        }
        break;
      case "drop":
        if (Array.isArray(current) && current.length > 0) {
          current.splice(op.index % current.length, 1);
          done = "drop";
        }
        break;
      case "inherited-key":
        if (isObject(current)) {
          own(current, op.key, "x");
          done = `add key ${op.key}`;
        } else if (typeof current === "string") {
          set(op.key);
          done = `value ${op.key}`;
        }
        break;
      case "retype": {
        const to: Json =
          op.to === "string"
            ? // An object given its own `toString` key has no string conversion of its own.
              typeof current === "object" && current !== null
              ? JSON.stringify(current)
              : String(current)
            : op.to === "number"
              ? 1
              : op.to === "boolean"
                ? true
                : op.to === "object"
                  ? {}
                  : [];
        set(to);
        done = `retype ${op.to}`;
        break;
      }
    }
    if (done) applied.push(`${path.join(".")}: ${done}`);
  }
  return { doc: copy, applied };
}

/**
 * Enumerated values by the property name holding them, from the pointers
 * {@link jsonSchemaEnums} returns: a value list under `properties/<name>`
 * (or its `items`) is offered for any property of that name.
 */
export function enumsByProperty(
  enums: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const [pointer, values] of enums) {
    const match = /\/properties\/([^/]+)(?:\/(?:items|allOf\/\d+|anyOf\/\d+|oneOf\/\d+))*$/.exec(
      pointer,
    );
    const name = match?.[1];
    if (name === undefined) continue;
    const set = out.get(name) ?? new Set<string>();
    for (const v of values) set.add(v);
    out.set(name, set);
  }
  return new Map([...out].map(([name, set]) => [name, [...set]]));
}

type XmlNode = Record<string, unknown>;

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
});

const xmlBuilder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: true,
  suppressEmptyNode: false,
});

/** A node's element name: its one key that is neither attributes nor text. */
const elementName = (node: XmlNode): string | undefined =>
  Object.keys(node).find((k) => k !== ":@" && k !== "#text" && k !== "?xml");

/** Characters XML 1.0 cannot carry, which no well-formed document holds. */
const NOT_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

interface XmlPlace {
  /** The sibling list holding the element. */
  siblings: XmlNode[];
  index: number;
  name: string;
  /** Element names from the root, for a mutation's description. */
  path: string;
}

function xmlPlaces(nodes: XmlNode[], within: (path: string) => boolean): XmlPlace[] {
  const out: XmlPlace[] = [];
  const walk = (list: XmlNode[], prefix: string, depth: number) => {
    list.forEach((node, index) => {
      const name = elementName(node);
      if (name === undefined) return;
      const path = prefix ? `${prefix}/${name}` : name;
      if (depth > 0 && within(path)) out.push({ siblings: list, index, name, path });
      const children = node[name];
      if (Array.isArray(children)) walk(children as XmlNode[], path, depth + 1);
    });
  };
  walk(nodes, "", 0);
  return out;
}

/** An element's text when it holds text alone. */
function textOf(node: XmlNode, name: string): XmlNode | undefined {
  const children = node[name];
  if (!Array.isArray(children) || children.length !== 1) return undefined;
  const only = children[0] as XmlNode;
  return "#text" in only ? only : undefined;
}

export interface XmlMutationOptions {
  /** Which elements, by their slash-separated path of local names from the root, may change. */
  within?: (path: string) => boolean;
  /** The standard's enumerations: a text that is one value of a list may become another. */
  enumerations?: readonly (readonly string[])[];
}

/**
 * A mutated copy of an XML document and what was done to it: elements
 * deleted or duplicated, texts swapped for another value of the enumeration
 * they belong to or for awkward but legal text, numbers, times and language
 * tags. The result is always well formed.
 */
export function mutateXml(
  xml: string,
  list: readonly Mutation[],
  options: XmlMutationOptions = {},
): { xml: string; applied: string[] } {
  const tree = xmlParser.parse(xml) as XmlNode[];
  const all = xmlPlaces(tree, options.within ?? (() => true));
  const applied: string[] = [];
  const enumerations = options.enumerations ?? [];
  for (const { at, op } of list) {
    if (all.length === 0) break;
    const place = all[at % all.length]!;
    const node = place.siblings[place.index];
    if (node === undefined || elementName(node) !== place.name) continue;
    const text = textOf(node, place.name);
    const current = text === undefined ? undefined : String(text["#text"]);
    const setText = (value: string) => {
      if (text !== undefined) text["#text"] = value;
    };
    let done: string | undefined;
    switch (op.kind) {
      case "delete":
        place.siblings.splice(place.index, 1);
        done = "delete";
        break;
      case "duplicate":
        place.siblings.splice(place.index, 0, structuredClone(node));
        done = "duplicate";
        break;
      case "enum":
        if (current !== undefined) {
          const lists = enumerations.filter((values) => values.includes(current.trim()));
          const values = lists.flat();
          if (values.length > 0) {
            setText(values[op.pick % values.length]!);
            done = `enum ${values[op.pick % values.length]}`;
          }
        }
        break;
      case "text":
        if (current !== undefined && !NOT_XML.test(op.value)) {
          setText(op.value);
          done = `text ${JSON.stringify(op.value.slice(0, 60))}`;
        }
        break;
      case "time":
        if (current !== undefined && looksLikeTime(current.trim())) {
          setText(op.value);
          done = `time ${op.value}`;
        }
        break;
      case "number":
        if (current !== undefined && current.trim() !== "" && Number.isFinite(Number(current))) {
          setText(String(op.value));
          done = `number ${op.value}`;
        }
        break;
      case "empty":
        if (current !== undefined) {
          setText("");
          done = "empty";
        }
        break;
      case "language": {
        const attrs = node[":@"] as Record<string, string> | undefined;
        const langKey = attrs && Object.keys(attrs).find((k) => /(^|:)lang$/.test(k));
        if (attrs && langKey) {
          attrs[langKey] = op.value;
          done = `lang ${JSON.stringify(op.value)}`;
        }
        break;
      }
      case "inherited-key":
        if (current !== undefined) {
          setText(op.key);
          done = `text ${op.key}`;
        }
        break;
      default:
        break;
    }
    if (done) applied.push(`${place.path}: ${done}`);
  }
  return { xml: xmlBuilder.build(tree) as string, applied };
}

/** The model's time fields: `fetchedAt`, `expiresAt` and the like, and the bounds of a period. */
const TIME_FIELD = /^(?:\w+At|start|end|instant)$/;
const ISO_INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;
const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

function positionProblems(p: unknown, at: string): string[] {
  if (!Array.isArray(p) || p.length < 2 || p.length > 3) return [`${at}: not a position`];
  if (!p.every((n) => typeof n === "number" && Number.isFinite(n)))
    return [`${at}: non-finite coordinate ${JSON.stringify(p)}`];
  const [lon, lat] = p as number[];
  return Math.abs(lon!) > 180 || Math.abs(lat!) > 90
    ? [`${at}: coordinate out of range ${JSON.stringify(p)}`]
    : [];
}

/** Why a GeoJSON geometry is not a valid one, empty when it is. */
export function geometryProblems(g: Record<string, unknown>, at = "geometry"): string[] {
  const c = g["coordinates"];
  const line = (l: unknown, where: string, min: number): string[] =>
    !Array.isArray(l) || l.length < min
      ? [`${where}: fewer than ${min} positions`]
      : l.flatMap((p, i) => positionProblems(p, `${where}[${i}]`));
  const ring = (r: unknown, where: string): string[] => {
    const problems = line(r, where, 4);
    if (problems.length > 0) return problems;
    const ps = r as number[][];
    const [a, b] = [ps[0]!, ps[ps.length - 1]!];
    return a[0] === b[0] && a[1] === b[1] ? [] : [`${where}: ring not closed`];
  };
  const many = (xs: unknown, where: string, each: (x: unknown, w: string) => string[]) =>
    Array.isArray(xs) ? xs.flatMap((x, i) => each(x, `${where}[${i}]`)) : [`${where}: not a list`];
  switch (g["type"]) {
    case "Point":
      return positionProblems(c, at);
    case "MultiPoint":
      return many(c, at, positionProblems);
    case "LineString":
      return line(c, at, 2);
    case "MultiLineString":
      return many(c, at, (l, w) => line(l, w, 2));
    case "Polygon":
      return many(c, at, ring);
    case "MultiPolygon":
      return many(c, at, (p, w) => many(p, w, ring));
    case "GeometryCollection":
      return many(g["geometries"], at, (x, w) =>
        isObject(x) ? geometryProblems(x as Record<string, unknown>, w) : [`${w}: not a geometry`],
      );
    default:
      return [`${at}: unknown geometry type`];
  }
}

/**
 * What is wrong with a parser's drafts beyond what sealing checks: values
 * JSON cannot carry (a function looked up through a prototype, a non-finite
 * number), times in the model's time fields that are not RFC 3339 instants,
 * and geometries that are not valid GeoJSON. Empty when nothing is. Only the
 * model's time fields are held to be instants: ids, names and source values
 * are the publisher's words, which may begin with a date without being one.
 */
export function draftProblems(drafts: readonly unknown[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string, key = ""): void => {
    if (typeof v === "function") out.push(`${at}: a function`);
    else if (typeof v === "number" && !Number.isFinite(v)) out.push(`${at}: ${v}`);
    else if (typeof v === "string") {
      if (TIME_FIELD.test(key) && (!ISO_INSTANT.test(v) || !Number.isFinite(Date.parse(v))))
        out.push(`${at}: not an instant ${JSON.stringify(v)}`);
    } else if (Array.isArray(v)) for (const [i, x] of v.entries()) walk(x, `${at}[${i}]`, key);
    else if (typeof v === "object" && v !== null) {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        out.push(`${at}: a ${(v as object).constructor?.name ?? "non-plain"} object`);
      const o = v as Record<string, unknown>;
      if (
        typeof o["type"] === "string" &&
        GEOMETRY_TYPES.has(o["type"]) &&
        ("coordinates" in o || "geometries" in o)
      )
        out.push(...geometryProblems(o, at));
      for (const [k, x] of Object.entries(o)) {
        // A JSON-LD context maps the record's terms to IRIs; it holds no values.
        if (k !== "@context") walk(x, `${at}.${k}`, k);
      }
    }
  };
  for (const [i, d] of drafts.entries()) {
    walk(d, `[${i}]${isObject(d) && typeof d["id"] === "string" ? `(${d["id"]})` : ""}`);
  }
  return out;
}

/** Characters XML 1.0 forbids, found anywhere in a serialized document. */
export function xmlCharProblems(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(new RegExp(NOT_XML.source, "gu"))) {
    out.push(`U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} at ${m.index}`);
    if (out.length >= 5) break;
  }
  for (const m of xml.matchAll(/&#(x[0-9a-fA-F]+|\d+);/g)) {
    const cp = m[1]!.startsWith("x") ? Number.parseInt(m[1]!.slice(1), 16) : Number(m[1]);
    const ch = cp <= 0x10ffff ? String.fromCodePoint(cp) : "\u0000";
    if (NOT_XML.test(ch)) out.push(`character reference ${m[0]} at ${m.index}`);
  }
  return out;
}
