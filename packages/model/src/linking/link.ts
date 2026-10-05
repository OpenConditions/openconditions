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
  /** The lower id of the pair, so one pair is one row (`CHECK (a_id < b_id)`). */
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

const ordered = (a: LinkableFeature, b: LinkableFeature) => (a.id < b.id ? [a, b] : [b, a]);

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
    address: tokenSimilarity(addressOf(a), addressOf(b)),
  };
  const metres = `${distance.toFixed(1)} m`;
  const agreeing = (thresholds: LinkingRules["attribute"]) =>
    (Object.entries(thresholds) as [keyof typeof scores, number][])
      .filter(([field, min]) => scores[field] >= min)
      .map(([field]) => `${field} ${scores[field].toFixed(2)}`);

  if (distance <= rules.alwaysMetres) {
    return link("spatial_attribute", NEAR_CONFIDENCE, "accepted", [metres]);
  }
  const accepted = agreeing(rules.attribute);
  if (accepted.length > 0) {
    return link("spatial_attribute", ATTRIBUTE_CONFIDENCE, "accepted", [metres, ...accepted]);
  }
  const pending = agreeing(rules.pendingAttribute ?? {});
  if (pending.length > 0) {
    return link("spatial_attribute", PENDING_CONFIDENCE, "pending", [metres, ...pending]);
  }
  return undefined;
}
