import type { ConditionEvent, Measurement, Observation } from "@openconditions/core";
import type { Feature, FeatureCollection } from "geojson";
import { type FeedInfo, isEvent, roadFields } from "./types.js";

/** A FeatureCollection plus the optional `feed_info` foreign member (RFC 7946 §6.1). */
export type ConditionsFeatureCollection = FeatureCollection & { feed_info?: FeedInfo };

function properties(o: Observation): Record<string, unknown> {
  const rf = roadFields(o);
  const att = o.origin.attribution;
  const base: Record<string, unknown> = {
    id: o.id,
    source: o.source,
    domain: o.domain,
    kind: o.kind,
    status: o.status,
    validFrom: o.validFrom ?? null,
    validTo: o.validTo ?? null,
    dataUpdatedAt: o.dataUpdatedAt,
    isStale: o.isStale,
    provider: att.provider,
    license: att.license,
    attributionUrl: att.url ?? null,
  };
  if (isEvent(o)) {
    const e = o as ConditionEvent;
    base.type = e.type;
    base.category = e.category;
    base.severity = e.severity;
    base.headline = e.headline;
    base.description = e.description ?? null;
    if (rf.roadState) base.roadState = rf.roadState;
    if (rf.roads) base.roads = rf.roads;
    if (rf.direction) base.direction = rf.direction;
  } else {
    const m = o as Measurement;
    base.metric = m.metric;
    base.value = m.value ?? null;
    base.unit = m.unit ?? null;
  }
  return base;
}

/**
 * Projects observations to a GeoJSON FeatureCollection (RFC 7946) — the
 * universal baseline emitter. Feed-level attribution/license travel as the
 * `feed_info` foreign member (and should also be set as HTTP headers).
 */
export function observationsToGeoJSON(
  obs: Observation[],
  info: FeedInfo = {}
): ConditionsFeatureCollection {
  const fc: ConditionsFeatureCollection = {
    type: "FeatureCollection",
    features: obs.map(
      (o): Feature => ({
        type: "Feature",
        id: o.id,
        geometry: o.geometry,
        properties: properties(o),
      })
    ),
  };
  if (Object.keys(info).length > 0) fc.feed_info = info;
  return fc;
}
