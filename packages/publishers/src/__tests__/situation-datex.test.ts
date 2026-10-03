import { toCatalogFeed } from "@openconditions/ingest-framework";
import { parseEvents, type RoadFeed } from "@openconditions/roads";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { datexRecordsOf, situationsToDatex } from "../situation-datex.js";

type Rec = Record<string, unknown>;

const AT = new Date("2026-09-06T10:00:00Z");
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

const effect = (id: string, kind: string, fields: Rec = {}): Rec => ({
  id,
  kind,
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  ...fields,
});

const closure = (over: Rec = {}): Rec =>
  situation({
    kind: "closure",
    type: "closure",
    subtype: "full",
    effects: [effect("c/closure", "closure", { scope: "road" })],
    ...over,
  });

function situation(over: Rec = {}): Rec {
  return {
    id: "oc:situation:de-autobahn-events:a46",
    revision: 3,
    class: "situation",
    kind: "roadworks",
    type: "works",
    temporality: "live",
    certainty: "observed",
    severity: { label: "major", source: "derived" },
    headline: [{ lang: "de", text: "Bauarbeiten A 46" }],
    validity: { status: "active", start: "2026-09-06T08:00:00Z", end: "2026-09-07T08:00:00Z" },
    effects: [
      effect("a46/lanes", "lane_restriction", {
        vehicleImpact: "some_lanes_closed",
        lanesTotal: 3,
        lanesClosed: 1,
        sourceRecordRef: "NLRWS_a46_2",
      }),
      effect("a46/speed", "speed_limit", { limit: { value: 60, unit: "km/h" } }),
    ],
    location: {
      geometry: { type: "Point", coordinates: [6.81, 51.2] },
      roads: [{ ref: "A46", name: [{ lang: "de", text: "Autobahn 46" }] }],
    },
    provenance: { sourceUpdatedAt: "2026-09-06T09:00:00Z" },
    freshness: { fetchedAt: "2026-09-06T09:30:00Z" },
    ...over,
  };
}

describe("datexRecordsOf", () => {
  it("writes the nature record, then one management record per effect, keeping the DATEX ids read", () => {
    const records = datexRecordsOf(situation(), AT);
    expect(records.map((r) => [r["@_xsi:type"], r["@_id"], r["@_version"]])).toEqual([
      ["sit:MaintenanceWorks", "oc:situation:de-autobahn-events:a46", "3"],
      ["sit:RoadOrCarriagewayOrLaneManagement", "NLRWS_a46_2", "3"],
      ["sit:SpeedManagement", "oc:situation:de-autobahn-events:a46#a46/speed", "3"],
    ]);
    expect(records[1]).toMatchObject({
      "sit:roadOrCarriagewayOrLaneManagementType": "laneClosures",
      "sit:impact": { "sit:numberOfLanesRestricted": 1, "sit:numberOfOperationalLanes": 2 },
    });
    expect(records[2]).toMatchObject({ "sit:temporarySpeedLimit": 60 });
  });

  it("puts what describes the whole situation on its leading record only, before validity", () => {
    const [lead, lanes] = datexRecordsOf(situation(), AT);
    expect(Object.keys(lead!).indexOf("sit:severity")).toBeLessThan(
      Object.keys(lead!).indexOf("sit:validity"),
    );
    expect(lead).toMatchObject({
      "sit:probabilityOfOccurrence": "certain",
      "sit:severity": "high",
      "sit:generalPublicComment": expect.anything(),
    });
    expect(lanes).not.toHaveProperty("sit:severity");
  });

  it("folds an effect into the nature record when both are the same DATEX record", () => {
    const records = datexRecordsOf(closure(), AT);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "@_xsi:type": "sit:RoadOrCarriagewayOrLaneManagement",
      "sit:roadOrCarriagewayOrLaneManagementType": "roadClosed",
      "sit:severity": "high",
    });
  });

  it("leads with the first effect's record when the nature has no record of its own", () => {
    const records = datexRecordsOf(
      closure({ kind: "road_hazard", type: "hazard", subtype: undefined }),
      AT,
    );
    expect(records).toEqual([
      expect.objectContaining({
        "@_xsi:type": "sit:RoadOrCarriagewayOrLaneManagement",
        "@_id": "oc:situation:de-autobahn-events:a46#c/closure",
        "sit:severity": "high",
      }),
    ]);
  });

  it("reduces a line to its first point, never inventing a linear location", () => {
    const line = situation({
      location: {
        geometry: {
          type: "LineString",
          coordinates: [
            [6.81, 51.2],
            [6.83, 51.21],
          ],
        },
        roads: [{ ref: "A46" }],
      },
    });
    expect(datexRecordsOf(line, AT)[0]!["sit:locationReference"]).toEqual({
      "@_xsi:type": "loc:PointLocation",
      "loc:roadNumber": "A46",
      "loc:pointByCoordinates": {
        "loc:pointCoordinates": { "loc:latitude": 51.2, "loc:longitude": 6.81 },
      },
    });
  });

  it("places an effect with its own location there, not at its situation", () => {
    const elsewhere = effect("a46/speed", "speed_limit", {
      limit: { value: 60, unit: "km/h" },
      location: {
        geometry: { type: "Point", coordinates: [6.9, 51.3] },
        extent: "point",
        geometryOrigin: "source",
      },
    });
    const [nature, speed] = datexRecordsOf(situation({ effects: [elsewhere] }), AT);
    expect(nature!["sit:locationReference"]).toMatchObject({
      "loc:pointByCoordinates": {
        "loc:pointCoordinates": { "loc:latitude": 51.2, "loc:longitude": 6.81 },
      },
    });
    expect(speed!["sit:locationReference"]).toMatchObject({
      "loc:pointByCoordinates": {
        "loc:pointCoordinates": { "loc:latitude": 51.3, "loc:longitude": 6.9 },
      },
    });
  });

  it("leaves out a situation it cannot tell without widening a vehicle condition", () => {
    const hgv = effect("x", "closure", {
      scope: "road",
      applicability: { kind: "classes", include: [{ class: "hgv" }] },
    });
    expect(datexRecordsOf(situation({ effects: [hgv] }), AT)).toEqual([]);
  });
});

describe("DATEX II round-trip through the ingest parser", () => {
  const feed = toCatalogFeed(
    {
      operator: "rt",
      product: "events",
      name: "DATEX II round trip",
      format: "datex2",
      tier: "authoritative",
      endpoints: { main: { url: "https://example.test/feed", cadenceSec: 300 } },
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      attribution: "OpenConditions",
      privacyUrl: "https://example.test/privacy",
    },
    { domain: "roads", region: "de", file: "feeds/roads/de.jsonc", maintainers: [] },
  ) as RoadFeed;

  it("re-ingests a full closure as a full closure, with its validity and place", () => {
    const xml = situationsToDatex([closure()], AT);
    expect(parser.parse(xml).messageContainer.payload["sit:situation"]).toBeDefined();
    const [draft] = parseEvents(feed, [Buffer.from(xml)]).situations;
    expect(draft).toMatchObject({
      kind: "closure",
      type: "closure",
      subtype: "full",
      validity: { start: "2026-09-06T08:00:00Z", end: "2026-09-07T08:00:00Z" },
      location: { geometry: { type: "Point", coordinates: [6.81, 51.2] } },
    });
    expect((draft!["effects"] as Rec[]).map((e) => e["kind"])).toContain("closure");
  });

  it("re-ingests roadworks with a lane closure and a speed limit as one situation with both effects", () => {
    const xml = situationsToDatex([situation()], AT);
    const { situations } = parseEvents(feed, [Buffer.from(xml)]);
    expect(situations).toHaveLength(1);
    expect(situations[0]).toMatchObject({ kind: "roadworks", type: "works" });
    expect((situations[0]!["effects"] as Rec[]).map((e) => e["kind"]).sort()).toEqual([
      "lane_restriction",
      "speed_limit",
    ]);
  });
});
