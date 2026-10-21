import {
  type EffectState,
  effectStateAt,
  situationEffects,
  type Validity,
} from "@openconditions/model";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { geoJsonLdContext, recordIri } from "./geojson-ld.js";
import { rfc7946Geometry } from "./rfc7946.js";
import type { FeedInfo } from "./types.js";

type Rec = Record<string, unknown>;

/** An effect's state at the instant a collection was evaluated for. */
export interface EffectStateAt {
  state: EffectState;
  nextTransitionAt: string | null;
}

/** Every effect of a situation with its state at `at`, by effect id. */
export function effectStatesAt(situation: Rec, at: Date): Record<string, EffectStateAt> {
  const validity = situation["validity"] as Validity;
  return Object.fromEntries(
    situationEffects(situation).map((e) => [e.id, effectStateAt(e, validity, at)]),
  );
}

/** The earliest instant after `at` at which any effect of `situations` changes state. */
export function nextEffectTransition(situations: readonly Rec[], at: Date): string | null {
  let best: string | null = null;
  for (const situation of situations) {
    for (const { nextTransitionAt } of Object.values(effectStatesAt(situation, at))) {
      if (nextTransitionAt !== null && (best === null || nextTransitionAt < best)) {
        best = nextTransitionAt;
      }
    }
  }
  return best;
}

export type SituationFeatureCollection = FeatureCollection<Geometry | null, Rec> & {
  attribution?: string;
  license?: string;
  url?: string;
  timestamp?: string;
  /** The cursor of the next page; null when this page is the last. */
  next?: string | null;
};

export interface SituationGeoJsonOptions {
  /** The instant effect states are evaluated at. Default now. */
  at?: Date;
  next?: string | null;
}

/**
 * Situations as a GeoJSON FeatureCollection: each record as a feature whose
 * geometry is its location's, whose properties are the record itself (its
 * location without the geometry the feature already carries), plus the state
 * of each effect at `at`. Records are never rebuilt, only wrapped; a
 * geometry is only put in the form RFC 7946 asks of a producer
 * (`rfc7946Geometry`).
 */
export function situationsToGeoJSON(
  situations: readonly Rec[],
  info: FeedInfo = {},
  opts: SituationGeoJsonOptions = {},
): SituationFeatureCollection {
  const at = opts.at ?? new Date();
  const features = situations.map((situation): Feature<Geometry | null, Rec> => {
    const { geometry, ...location } = (situation["location"] as Rec | undefined) ?? {};
    return {
      type: "Feature",
      id: String(situation["id"]),
      geometry: rfc7946Geometry((geometry as Geometry | null | undefined) ?? null),
      properties: { ...situation, location, effectStates: effectStatesAt(situation, at) },
    };
  });
  return {
    type: "FeatureCollection",
    ...(info.attribution ? { attribution: info.attribution } : {}),
    ...(info.license ? { license: info.license } : {}),
    ...(info.url ? { url: info.url } : {}),
    ...(info.timestamp ? { timestamp: info.timestamp } : {}),
    ...(opts.next !== undefined ? { next: opts.next } : {}),
    features,
  };
}

/** The schema.org and SOSA terms a situation's fields map to. */
const CONTEXT = geoJsonLdContext({
  kind: "oc:kind",
  subtype: "oc:subtype",
  severity: "oc:severity",
  certainty: "oc:certainty",
  validity: "oc:validity",
  effects: "oc:effects",
  // Keyed by effect id: each state names its effect (`oc:effect`) rather than
  // a property. The index is a term, which processors compact back to a key.
  effectStates: { "@id": "oc:effectStates", "@container": "@index", "@index": "effect" },
  headline: "schema:headline",
  description: "schema:description",
  provenance: "oc:provenance",
  recordedAt: "schema:dateModified",
});

export type SituationJsonLdCollection = SituationFeatureCollection & { "@context": unknown };

/**
 * Situations as GeoJSON-LD: the GeoJSON collection with a schema.org/SOSA
 * `@context`, each feature identified by its record's IRI and typed a
 * `schema:SpecialAnnouncement`, so semantic-web, research and search-index
 * consumers can read it as RDF. The record id stays in the properties.
 */
export function situationsToJsonLd(
  situations: readonly Rec[],
  info: FeedInfo = {},
  opts: SituationGeoJsonOptions = {},
): SituationJsonLdCollection {
  const fc = situationsToGeoJSON(situations, info, opts);
  return {
    "@context": CONTEXT,
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      id: recordIri(f.id),
      "@type": "schema:SpecialAnnouncement",
    })) as SituationFeatureCollection["features"],
  };
}
