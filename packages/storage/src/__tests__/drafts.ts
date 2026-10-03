/**
 * Minimal valid drafts of each record class, for the storage suites. They
 * are what a parser hands the write seam: no canonical id, domain, content
 * hash, revision or instance id.
 */
import { observationId } from "@openconditions/model";

type Rec = Record<string, unknown>;

export const FETCHED_AT = "2026-10-01T10:00:00.000Z";

const provenance = (sourceId: string, format: string, recordId: string) => ({
  origin: "feed",
  sourceId,
  sourceFormat: format,
  accessMode: "bulk",
  recordId,
  attribution: { provider: "Test publisher", license: "CC0-1.0" },
  privacy: { class: "authoritative" },
});

/** An accident on the A2 near Amsterdam, from the NDW situation feed. */
export function situationDraft(local: string, over: Rec = {}): Rec {
  return {
    id: `oc:situation:nl-ndw-events:${local}`,
    class: "situation",
    kind: "incident",
    type: "accident",
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "major", source: "declared", declaredRaw: "high" },
    headline: [{ lang: "nl", text: "Ongeval" }],
    validity: { status: "active", start: "2026-10-01T09:00:00Z" },
    effects: [
      {
        id: `${local}/closure`,
        kind: "closure",
        v: 1,
        scope: "carriageway",
        applicability: { kind: "all" },
        compliance: "mandatory",
        normalization: "complete",
      },
    ],
    details: { kind: "incident", v: 1 },
    location: {
      geometry: { type: "Point", coordinates: [4.9, 52.37] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      admin: { country: "NL" },
    },
    provenance: provenance("nl-ndw-events", "datex2", local),
    freshness: { fetchedAt: FETCHED_AT },
    ...over,
  };
}

/** Works with a phase whose lane closure applies only during the phase. */
export function roadworksDraft(local: string): Rec {
  return situationDraft(local, {
    kind: "roadworks",
    type: "works",
    planned: true,
    severity: { label: "minor", source: "derived" },
    effects: [],
    details: {
      kind: "roadworks",
      v: 1,
      phases: [
        {
          id: "p1",
          validity: {
            status: "planned",
            start: "2026-10-05T20:00:00Z",
            end: "2026-10-06T05:00:00Z",
          },
          effects: [
            {
              id: `${local}/lane_restriction`,
              kind: "lane_restriction",
              v: 1,
              vehicleImpact: "some_lanes_closed",
              lanesClosed: 1,
              applicability: { kind: "all" },
              compliance: "mandatory",
              normalization: "complete",
            },
          ],
        },
      ],
    },
  });
}

/** An NDW measurement site with one channel per lane. */
export function featureDraft(local: string, lanes = 2, over: Rec = {}): Rec {
  return {
    id: `oc:feature:nl-ndw-flow:${local}`,
    class: "feature",
    kind: "measurement_site",
    type: "traffic",
    temporality: "static",
    lifecycle: "operational",
    details: { kind: "measurement_site", v: 1, measuredProperties: ["traffic.speed"] },
    components: Array.from({ length: lanes }, (_, i) => ({
      key: `lane${i + 1}`,
      kind: "sensor_channel",
      position: { type: "Point", coordinates: [4.536, 52.0235] },
      details: { kind: "sensor_channel", v: 1, index: i + 1, property: "traffic.speed" },
    })),
    location: {
      geometry: { type: "Point", coordinates: [4.536069, 52.0235558] },
      extent: "point",
      geometryOrigin: "site_table",
      fuzziness: "exact",
    },
    relations: [
      { ref: { class: "situation", id: "oc:situation:nl-ndw-events:works" }, relation: "related" },
    ],
    provenance: provenance("nl-ndw-flow", "datex2", local),
    freshness: { fetchedAt: FETCHED_AT },
    ...over,
  };
}

/**
 * A reading of one property, with its derived id. `subject` defaults to an
 * NDW measurement site; a location subject takes the location's geocode.
 */
export function observationDraft(
  property: string,
  result: Rec,
  over: Rec & { at?: string; sourceId?: string; subject?: Rec } = {},
): Rec {
  const { at, sourceId, ...rest } = over;
  const source = sourceId ?? "nl-ndw-flow";
  const draft: Rec = {
    class: "observation",
    kind: "observation",
    property,
    subject: { kind: "feature", featureId: "oc:feature:nl-ndw-flow:s1" },
    result,
    phenomenonTime: { instant: at ?? "2026-10-01T10:00:00.000Z" },
    aggregation: "instantaneous",
    temporality: "live",
    location: {
      geometry: { type: "Point", coordinates: [4.536069, 52.0235558] },
      extent: "point",
      geometryOrigin: "site_table",
      fuzziness: "exact",
    },
    provenance: provenance(source, "datex2", "s1"),
    freshness: { fetchedAt: FETCHED_AT },
    ...rest,
  };
  draft["id"] = observationId(source, draft as Parameters<typeof observationId>[1]);
  return draft;
}

/** A car park's day rate. */
export function offerDraft(local: string, over: Rec = {}): Rec {
  return {
    id: `oc:offer:de-parking:${local}`,
    class: "offer",
    kind: "parking_rate",
    temporality: "static",
    subject: { class: "feature", id: "oc:feature:de-parking:p1" },
    currency: "EUR",
    elements: [
      { components: [{ type: "parking_time", price: { amount: "2.50", currency: "EUR" } }] },
    ],
    minPrice: { amount: "2.50", currency: "EUR" },
    maxPrice: { amount: "20.00", currency: "EUR" },
    validity: { status: "active" },
    location: {
      geometry: { type: "Point", coordinates: [8.4, 49.0] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
    provenance: provenance("de-parking", "datex2", local),
    freshness: { fetchedAt: FETCHED_AT },
    ...over,
  };
}
