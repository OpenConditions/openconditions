import type { LinkingRules } from "../registry/define.js";
import { type LinkableFeature, representativePoint } from "./link.js";
import { haversineMetres, tokenSimilarity } from "./similarity.js";

/** An OSM element a feature could be: its id, its tags and where it is. */
export interface OsmCandidate {
  id: { scheme: "osm:node" | "osm:way" | "osm:relation"; id: string };
  tags: Readonly<Record<string, string>>;
  geometry: unknown;
}

/** What `Feature.osmMatch` records: which element, how it was found, how sure. */
export interface OsmMatch {
  id: { scheme: string; id: string };
  method: "id" | "spatial_tag";
  confidence: number;
}

const ID_CONFIDENCE = 1;
const NEAR_CONFIDENCE = 0.85;
const ATTRIBUTE_CONFIDENCE = 0.65;

const normalizeId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s*-]/g, "");
/** A reference tag may hold several ids, separated by semicolons. */
const taggedIds = (value: string) => value.split(";").map(normalizeId);
const textOf = (value: readonly { text: string }[] | undefined) => value?.[0]?.text;

/** Whether an element carries one of the kind's `tag=value` filters. */
function hasKindTag(candidate: OsmCandidate, tags: readonly string[]): boolean {
  return tags.some((filter) => {
    const [key, value] = filter.split("=");
    return key !== undefined && candidate.tags[key] === value;
  });
}

/**
 * The OSM element a feature is, or undefined. An id match is either side
 * asserting the other's identity: the source publishing an `osm:*` external
 * id, or the element carrying the publisher's own reference under a tag the
 * kind declares (`ref:EU:EVSE` holds an eMI3 EVSE id). Everything else is a
 * spatial match against elements tagged as this kind, under the same
 * thresholds as feature linking — and, like them, an inexact position never
 * matches spatially.
 */
export function matchOsm(
  feature: LinkableFeature,
  candidates: readonly OsmCandidate[],
  rules: LinkingRules | undefined,
): OsmMatch | undefined {
  if (rules?.osm === undefined) return undefined;
  const asserted = new Set((feature.externalIds ?? []).map((e) => `${e.scheme}\u0000${e.id}`));
  const ids = new Map<string, string[]>();
  const ownIds = [
    ...(feature.externalIds ?? []),
    ...(feature.components ?? []).flatMap((c) => c.externalIds ?? []),
  ];
  for (const [tag, scheme] of Object.entries(rules.osm.idTags ?? {})) {
    const values = ownIds.filter((e) => e.scheme === scheme).map((e) => normalizeId(e.id));
    if (values.length > 0) ids.set(tag, values);
  }
  for (const candidate of candidates) {
    if (asserted.has(`${candidate.id.scheme}\u0000${candidate.id.id}`)) {
      return { id: candidate.id, method: "id", confidence: ID_CONFIDENCE };
    }
    for (const [tag, values] of ids) {
      const tagged = candidate.tags[tag];
      if (tagged !== undefined && taggedIds(tagged).some((id) => values.includes(id))) {
        return { id: candidate.id, method: "id", confidence: ID_CONFIDENCE };
      }
    }
  }

  if (feature.location.fuzziness !== "exact") return undefined;
  const point = representativePoint(feature.location.geometry);
  if (point === undefined) return undefined;
  const stopwords = new Set(rules.nameStopwords ?? []);
  let best: (OsmMatch & { distance: number }) | undefined;
  for (const candidate of candidates) {
    if (!hasKindTag(candidate, rules.osm.tags)) continue;
    const other = representativePoint(candidate.geometry);
    if (other === undefined) continue;
    const distance = haversineMetres(point, other);
    if (distance >= rules.neverMetres) continue;
    const name = tokenSimilarity(textOf(feature.name), candidate.tags["name"], stopwords);
    const operator = tokenSimilarity(textOf(feature.operator?.name), candidate.tags["operator"]);
    const near = distance <= rules.alwaysMetres;
    const agrees =
      name >= (rules.attribute.name ?? 1) || operator >= (rules.attribute.operator ?? 1);
    if (!near && !agrees) continue;
    const match = {
      id: candidate.id,
      method: "spatial_tag" as const,
      confidence: near ? NEAR_CONFIDENCE : ATTRIBUTE_CONFIDENCE,
      distance,
    };
    if (best === undefined || match.confidence > best.confidence || distance < best.distance) {
      best = match;
    }
  }
  if (best === undefined) return undefined;
  return { id: best.id, method: best.method, confidence: best.confidence };
}
