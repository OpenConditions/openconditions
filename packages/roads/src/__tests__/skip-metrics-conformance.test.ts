import { beforeEach, describe, expect, it } from "vitest";
import { FEED_SOURCES, parserFor } from "../feeds.js";
import { __resetSkipMetrics, drainSkippedNoGeometry } from "../skip-metrics.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Every event parser must report the records it drops for want of coordinates.
 *
 * This is a default-DENY gate, and that is the point. A per-parser counter is
 * easy to forget, and forgetting is invisible: an absent
 * `lastSkippedNoGeometry` reads as "this feed loses nothing" when it actually
 * means "nobody measured this feed". Lower Saxony sat at 100% loss for months
 * behind exactly that ambiguity. So rather than trusting the next parser author
 * to remember, a format with no sample below FAILS — you cannot add an event
 * feed without either instrumenting its parser or writing down why it needs no
 * instrumentation.
 *
 * Each sample is the smallest payload of its format carrying exactly ONE record
 * that has no usable geometry.
 */
const GEOMETRYLESS_SAMPLE: Record<string, string> = {
  datex2: `<?xml version="1.0" encoding="UTF-8"?>
<d2:payloadPublication xmlns:d2="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="d2:SituationPublication">
  <d2:situation id="S1"><d2:situationRecord xsi:type="d2:Accident" id="R1">
    <d2:situationRecordCreationTime>2026-07-31T00:00:00Z</d2:situationRecordCreationTime>
    <d2:validity><d2:validityStatus>active</d2:validityStatus></d2:validity>
    <d2:groupOfLocations xsi:type="d2:AlertCLinear"><d2:alertCLocationCountryCode>de</d2:alertCLocationCountryCode></d2:groupOfLocations>
  </d2:situationRecord></d2:situation>
</d2:payloadPublication>`,

  open511: JSON.stringify({ events: [{ id: "no-geo", status: "ACTIVE", headline: "x" }] }),

  wzdx: JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        id: "no-geo",
        type: "Feature",
        properties: { core_details: { event_type: "work-zone" } },
        geometry: null,
      },
    ],
  }),

  geojson: JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { id: "no-geo" }, geometry: null }],
  }),

  flatjson: JSON.stringify([{ id: "no-geo" }]),

  ibi511: JSON.stringify([{ ID: 1, EventType: "closures", RoadwayName: "x" }]),

  "ibi511-conditions": JSON.stringify([{ RoadwayName: "x", Condition: ["Snow Covered"] }]),

  lta: JSON.stringify({ value: [{ Message: "x", Type: "Accident" }] }),

  gddkia: `<?xml version="1.0"?><utrudnienia><utr><id>1</id><typ>x</typ></utr></utrudnienia>`,

  trafikverket: JSON.stringify({
    RESPONSE: { RESULT: [{ Situation: [{ Id: "1", Deviation: [{ Id: "d1", Message: "x" }] }] }] },
  }),

  autobahn: JSON.stringify({ warning: [{ identifier: "no-geo", title: "x" }] }),

  digitraffic: JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: null,
        properties: {
          situationId: "no-geo",
          situationType: "TRAFFIC_ANNOUNCEMENT",
          announcements: [],
        },
      },
    ],
  }),

  "ohgo-events": JSON.stringify({ Results: [{ id: "no-geo", description: "x" }] }),

  "vic-disruptions": JSON.stringify({ disruptions: [{ id: "no-geo", name: "x" }] }),
};

/**
 * Formats that legitimately need no instrumentation, with the reason. Empty
 * today — listed here so an exemption is a deliberate, reviewed entry rather
 * than a silent omission.
 */
const EXEMPT: Record<string, string> = {};

const src = (id: string): SourceDescriptor => ({
  id,
  attribution: "t",
  country: "XX",
  license: "CC0-1.0",
  // A few declarative parsers need a mapping before they emit anything.
  geojson: { idField: "id" },
});

/** Every format an EVENT feed actually ingests with (flow feeds are measurements). */
function eventFormats(): string[] {
  return [
    ...new Set(FEED_SOURCES.filter((f) => f.produces !== "flow").map((f) => String(f.format))),
  ].sort();
}

describe("no-geometry accounting is instrumented for every event format in use", () => {
  beforeEach(() => __resetSkipMetrics());

  it("every event format a feed uses has a geometry-less sample or a written exemption", () => {
    const missing = eventFormats().filter((f) => !(f in GEOMETRYLESS_SAMPLE) && !(f in EXEMPT));
    expect(missing, `add a sample to GEOMETRYLESS_SAMPLE for: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(eventFormats().filter((f) => f in GEOMETRYLESS_SAMPLE))(
    "%s drops the record AND reports the loss",
    (format) => {
      const id = `conformance-${format}`;
      const events = parserFor(format as never)(GEOMETRYLESS_SAMPLE[format]!, src(id));

      expect(events, `${format} should emit no event for a geometry-less record`).toEqual([]);
      expect(
        drainSkippedNoGeometry(id),
        `${format} dropped a record without reporting it — an absent count reads as "loses nothing"`
      ).toBeGreaterThan(0);
    }
  );
});
