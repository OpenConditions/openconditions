import type { LinkingRules } from "../registry/define.js";
import { haversineMetres, tokenSimilarity } from "./similarity.js";

/** How a link was established (`oc.feature_link.method`). */
export const LINK_METHODS = ["external_id", "spatial_attribute", "manual"] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

/** Whether a link holds. A rejected link is never re-created by recomputation. */
export const LINK_STATUSES = ["accepted", "rejected", "pending"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** The part of a feature identity linking reads. */
export interface LinkableFeature {
  id: string;
  kind: string;
  type?: string;
  name?: readonly { lang: string; text: string }[];
  operator?: { name: readonly { lang: string; text: string }[] };
  externalIds?: readonly { scheme: string; id: string; authority?: string }[];
  /** The ids of its sub-units; a charging site is also known by its charge points' ids. */
  components?: readonly { externalIds?: readonly { scheme: string; id: string }[] }[];
  location: {
    geometry: unknown;
    fuzziness: string;
    address?: {
      street?: string;
      houseNumber?: string;
      postalCode?: string;
      city?: string;
      text?: string;
    };
  };
  provenance: { sourceId: string; sourceFormat?: string; accessMode?: string };
}

export interface FeatureLink {
  /** The lower id of the pair in code point order, so one pair is one row (`CHECK (a_id < b_id COLLATE "C")`). */
  aId: string;
  bId: string;
  method: LinkMethod;
  confidence: number;
  status: LinkStatus;
  /** What decided it, in evaluation order; kept so a reviewer sees the evidence. */
  reasons: readonly string[];
}

const EXTERNAL_ID_CONFIDENCE = 1;
const NEAR_CONFIDENCE = 0.9;
const ATTRIBUTE_CONFIDENCE = 0.7;
const PENDING_CONFIDENCE = 0.4;

const textOf = (value: readonly { text: string }[] | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value[0]!.text;

const addressOf = (f: LinkableFeature): string | undefined => {
  const a = f.location.address;
  if (a === undefined) return undefined;
  const parts = [a.street, a.houseNumber, a.postalCode, a.city].filter((p) => p !== undefined);
  return parts.length > 0 ? parts.join(" ") : a.text;
};

/** A number, a letter after it, a range (`6`, `2F`, `49-51`) at the end of a street. */
const TRAILING_HOUSE_NUMBER = /\s(\d+\s*[a-z]?(?:\s*[-–/]\s*\d+\s*[a-z]?)?)$/i;

/** A road named by a short letter code and a number (`B 3`, `N7`), which is no house number. */
const ROAD_NUMBER = /^[a-z]{1,3}\s*\d+$/i;

/** The street and house number linking compares. */
export interface HouseAddress {
  street?: string;
  houseNumber?: string;
}

const spaced = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The house number an address gives, by its own field or at the end of its
 * street. A street's trailing number is part of its name when the street is
 * a road number (`B 3`), or when the other address's street starts with the
 * whole street (`Straße 101` against `Straße 101 5`).
 */
function houseNumberOf(a: HouseAddress, other: HouseAddress): string | undefined {
  let written = a.houseNumber;
  const street = a.street?.trim();
  if (written === undefined && street !== undefined && !ROAD_NUMBER.test(street)) {
    const otherStreet = other.street === undefined ? "" : spaced(other.street);
    const named = otherStreet === spaced(street) || otherStreet.startsWith(`${spaced(street)} `);
    if (!named) written = street.match(TRAILING_HOUSE_NUMBER)?.[1];
  }
  const number = written?.replace(/\s+/g, "").toLowerCase();
  return number === undefined || number === "" ? undefined : number;
}

/** `49-51` as 49 to 51, `2F` as 2 with its letter; undefined for anything else. */
function houseSpan(number: string): { from: number; to: number; letter: string } | undefined {
  const m = number.match(/^(\d+)([a-z]?)(?:[-–/](\d+)[a-z]?)?$/);
  if (m === null) return undefined;
  const from = Number(m[1]);
  const to = m[3] === undefined ? from : Number(m[3]);
  return {
    from: Math.min(from, to),
    to: Math.max(from, to),
    letter: m[3] === undefined ? (m[2] ?? "") : "",
  };
}

/**
 * Whether two addresses name different houses: both give a house number and
 * the numbers cannot be one house. A letter one side leaves off (`2F`, `2`)
 * and a number within the other's range (`49`, `49-51`) are one house; two
 * letters (`2a`, `2b`) are two.
 */
export function houseNumbersDiffer(a: HouseAddress, b: HouseAddress): boolean {
  const na = houseNumberOf(a, b);
  const nb = houseNumberOf(b, a);
  if (na === undefined || nb === undefined || na === nb) return false;
  const sa = houseSpan(na);
  const sb = houseSpan(nb);
  if (sa === undefined || sb === undefined) return true;
  if (sa.to < sb.from || sb.to < sa.from) return true;
  return sa.from === sa.to && sb.from === sb.to && sa.letter !== "" && sb.letter !== ""
    ? sa.letter !== sb.letter
    : false;
}

/**
 * How far two addresses agree. Two different house numbers are two
 * addresses, however much of the rest they share: the street, postcode and
 * city of neighbours are the same words.
 */
function addressSimilarity(a: LinkableFeature, b: LinkableFeature): number {
  if (houseNumbersDiffer(a.location.address ?? {}, b.location.address ?? {})) return 0;
  return tokenSimilarity(addressOf(a), addressOf(b));
}

/**
 * A position to measure from: the point itself, else the mean of the
 * geometry's vertices. The mean is not the area centroid, but linking only
 * needs a stable representative point a few metres from the site's middle,
 * and sources publish a parking site as a point, an outline or an entrance.
 */
export function representativePoint(geometry: unknown): [number, number] | undefined {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (g === null || g === undefined || typeof g.type !== "string") return undefined;
  const positions: number[][] = [];
  const walk = (value: unknown, depth: number): void => {
    if (!Array.isArray(value)) return;
    if (depth === 0) {
      if (typeof value[0] === "number" && typeof value[1] === "number") {
        positions.push(value as number[]);
      }
      return;
    }
    for (const v of value) walk(v, depth - 1);
  };
  const depth = { Point: 0, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 }[
    g.type
  ];
  if (depth === undefined) return undefined;
  walk(g.coordinates, depth);
  if (positions.length === 0) return undefined;
  const lon = positions.reduce((s, p) => s + p[0]!, 0) / positions.length;
  const lat = positions.reduce((s, p) => s + p[1]!, 0) / positions.length;
  return [lon, lat];
}

type ExternalIdRef = { scheme: string; id: string; authority?: string };

/**
 * Two ids are comparable when one issuer stands behind both: the same scheme
 * and the same authority, or no authority on either side (a global scheme).
 * An aggregator's row id or an OCPI uid means something only within its
 * authority, so the same value from two authorities is two things, and an id
 * whose authority one side does not state is no evidence either way.
 */
const comparable = (a: ExternalIdRef, b: ExternalIdRef) =>
  a.scheme === b.scheme && a.authority === b.authority;

/**
 * Whether two features name different things under one id scheme. Two
 * charging sites that each carry an `ocpi:location` id, but different ones,
 * are different sites however close they stand: the publisher of that scheme
 * already told us they are two.
 */
function conflictingIds(a: LinkableFeature, b: LinkableFeature, schemes: readonly string[]) {
  for (const scheme of schemes) {
    const pairs = (a.externalIds ?? [])
      .filter((e) => e.scheme === scheme)
      .flatMap((l) => (b.externalIds ?? []).filter((r) => comparable(l, r)).map((r) => [l, r]));
    if (pairs.length === 0) continue;
    if (!pairs.some(([l, r]) => l!.id === r!.id)) return scheme;
  }
  return undefined;
}

/**
 * Whether `a` comes before `b` in code point order, the order of their UTF-8
 * bytes, in which the database keeps a link's pair (`COLLATE "C"`). `<`
 * compares UTF-16 code units, which put a character beyond the BMP before
 * U+E000–U+FFFF.
 */
function before(a: string, b: string): boolean {
  let i = 0;
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length < b.length;
}

const ordered = (a: LinkableFeature, b: LinkableFeature) => (before(a.id, b.id) ? [a, b] : [b, a]);

/**
 * The link two per-source features get, or undefined when they stay separate
 * Tier 1 is a shared authoritative external id; tier 2 a conservative
 * spatial match, close enough on its own or supported by a name, operator or
 * address that agrees; anything weaker is left `pending` for a human or the
 * crowd, never auto-accepted. Both sides must be the same kind with
 * compatible types and exactly located positions: a coarsened position never
 * links spatially.
 */
export function proposeLink(
  first: LinkableFeature,
  second: LinkableFeature,
  rules: LinkingRules | undefined,
): FeatureLink | undefined {
  if (rules === undefined || first.kind !== second.kind || first.id === second.id) return undefined;
  const [a, b] = ordered(first, second) as [LinkableFeature, LinkableFeature];
  const link = (method: LinkMethod, confidence: number, status: LinkStatus, reasons: string[]) => ({
    aId: a.id,
    bId: b.id,
    method,
    confidence,
    status,
    reasons,
  });

  const conflict = conflictingIds(a, b, rules.idSchemes);
  if (conflict !== undefined) return undefined;

  for (const scheme of rules.idSchemes) {
    const shared = (a.externalIds ?? []).find(
      (l) =>
        l.scheme === scheme && (b.externalIds ?? []).some((r) => comparable(l, r) && l.id === r.id),
    );
    if (shared !== undefined) {
      return link("external_id", EXTERNAL_ID_CONFIDENCE, "accepted", [`${scheme} ${shared.id}`]);
    }
  }

  if (
    (rules.typeCompatible ?? ((x, y) => x === y || x === undefined || y === undefined))(
      a.type,
      b.type,
    ) === false
  ) {
    return undefined;
  }
  if (a.location.fuzziness !== "exact" || b.location.fuzziness !== "exact") return undefined;
  const pa = representativePoint(a.location.geometry);
  const pb = representativePoint(b.location.geometry);
  if (pa === undefined || pb === undefined) return undefined;
  const distance = haversineMetres(pa, pb);
  if (distance >= rules.neverMetres) return undefined;

  const stopwords = new Set(rules.nameStopwords ?? []);
  const scores = {
    name: tokenSimilarity(textOf(a.name), textOf(b.name), stopwords),
    operator: tokenSimilarity(textOf(a.operator?.name), textOf(b.operator?.name)),
    address: addressSimilarity(a, b),
  };
  const metres = `${distance.toFixed(1)} m`;
  const agreeing = (thresholds: LinkingRules["attribute"]) =>
    (Object.entries(thresholds) as [keyof typeof scores, number][])
      .filter(([field, min]) => scores[field] >= min)
      .map(([field]) => `${field} ${scores[field].toFixed(2)}`);

  if (distance <= rules.alwaysMetres) {
    return link("spatial_attribute", NEAR_CONFIDENCE, "accepted", [metres]);
  }
  // An attribute that may decide only nearby says nothing further out.
  const within = rules.attributeWithinMetres ?? {};
  const accepted = agreeing(rules.attribute).filter((reason) => {
    const limit = within[reason.split(" ")[0] as keyof typeof scores];
    return limit === undefined || distance <= limit;
  });
  if (accepted.length > 0) {
    return link("spatial_attribute", ATTRIBUTE_CONFIDENCE, "accepted", [metres, ...accepted]);
  }
  const pending = agreeing(rules.pendingAttribute ?? {});
  if (pending.length > 0) {
    return link("spatial_attribute", PENDING_CONFIDENCE, "pending", [metres, ...pending]);
  }
  return undefined;
}
