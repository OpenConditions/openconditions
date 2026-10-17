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

  it("states probability on every record and the rest of the whole on the leading one", () => {
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
    expect(lanes).not.toHaveProperty("sit:generalPublicComment");
    expect(lanes).toHaveProperty("sit:probabilityOfOccurrence", "certain");
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

  it("preserves matching-nature effects separately with their own validity and compliance", () => {
    const records = datexRecordsOf(
      closure({
        effects: [
          effect("first", "closure", {
            scope: "road",
            compliance: "advisory",
            validity: { status: "active", start: "2026-09-06T09:00:00Z" },
          }),
          effect("second", "closure", {
            scope: "road",
            compliance: "mandatory",
            validity: { status: "active", start: "2026-09-06T09:30:00Z" },
          }),
        ],
      }),
      AT,
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      "sit:complianceOption": "advisory",
      "sit:validity": {
        "com:validityTimeSpecification": { "com:overallStartTime": "2026-09-06T09:00:00Z" },
      },
    });
    expect(records[1]).toMatchObject({
      "@_id": "oc:situation:de-autobahn-events:a46#second",
      "sit:complianceOption": "mandatory",
      "sit:validity": {
        "com:validityTimeSpecification": { "com:overallStartTime": "2026-09-06T09:30:00Z" },
      },
    });
  });

  it.each([false, true])("never borrows lane counts across same-type records (%s)", (reverse) => {
    const effects = [
      effect("a", "lane_restriction", {
        vehicleImpact: "some_lanes_closed",
        lanesTotal: 3,
        lanesClosed: 1,
      }),
      effect("b", "lane_restriction", { vehicleImpact: "some_lanes_closed", lanesClosed: 2 }),
    ];
    if (reverse) effects.reverse();
    const records = datexRecordsOf(closure({ subtype: "lane", effects }), AT);
    expect(records).toHaveLength(2);
    const impacts = records.map((r) => r["sit:impact"]);
    expect(impacts).toContainEqual({
      "sit:numberOfLanesRestricted": 1,
      "sit:numberOfOperationalLanes": 2,
    });
    expect(impacts).toContainEqual({ "sit:numberOfLanesRestricted": 2 });
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
      "loc:supplementaryPositionalDescription": {
        "loc:roadInformation": [{ "loc:roadNumber": "A46" }],
      },
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

  it("names every road, each by its first name", () => {
    const junction = situation({
      location: {
        geometry: { type: "Point", coordinates: [4.36, 50.85] },
        roads: [
          {
            name: [
              { lang: "fr", text: "Boulevard du Jardin Botanique" },
              { lang: "nl", text: "Kruidtuinlaan" },
            ],
          },
          { ref: "R20", name: [{ lang: "fr", text: "Petite ceinture" }] },
          { class: "primary" },
        ],
      },
    });
    expect(datexRecordsOf(junction, AT)[0]!["sit:locationReference"]).toMatchObject({
      "loc:supplementaryPositionalDescription": {
        "loc:roadInformation": [
          { "loc:roadName": "Boulevard du Jardin Botanique" },
          { "loc:roadName": "Petite ceinture", "loc:roadNumber": "R20" },
        ],
      },
    });
  });
});

describe("datexRecordsOf — lifecycle and operator action status", () => {
  const status = (records: Rec[]) =>
    records.map((r) => (r["sit:validity"] as Rec)["com:validityStatus"]);

  it("leaves an active lifecycle to the time specification it writes", () => {
    // DATEX `active` would hold the record in force regardless of its window.
    const scheduled = closure({
      validity: { status: "active", start: "2026-09-07T08:00:00Z", end: "2026-09-08T08:00:00Z" },
    });
    expect(status(datexRecordsOf(scheduled, AT))).toEqual(["definedByValidityTimeSpec"]);
    expect(status(datexRecordsOf(closure(), AT))).toEqual(["definedByValidityTimeSpec"]);
  });

  it.each(["planned", "suspended"])(
    "states a %s lifecycle on every record, including its management records",
    (lifecycle) => {
      // As the parser reads it: every effect restates the declared status.
      const issue = {
        code: "unsupported_status",
        sourcePath: "situationRecord.validity.validityStatus",
        sourceTokens: { validityStatus: lifecycle },
      };
      const s = situation({
        validity: { status: lifecycle, start: "2026-09-06T08:00:00Z" },
        effects: [
          effect("a46/lanes", "lane_restriction", {
            vehicleImpact: "some_lanes_closed",
            issues: [issue],
          }),
        ],
      });
      const records = datexRecordsOf(s, AT);
      expect(records.map((r) => r["@_xsi:type"])).toEqual([
        "sit:MaintenanceWorks",
        "sit:RoadOrCarriagewayOrLaneManagement",
      ]);
      expect(status(records)).toEqual([lifecycle, lifecycle]);
    },
  );

  it("states the operator action's status on its management record", () => {
    const s = closure({
      effects: [effect("c/closure", "closure", { scope: "road", actionStatus: "approved" })],
    });
    const [record] = datexRecordsOf(s, AT);
    expect(record).toMatchObject({
      "@_xsi:type": "sit:RoadOrCarriagewayOrLaneManagement",
      "sit:operatorActionStatus": "approved",
      "sit:complianceOption": "mandatory",
    });
    const keys = Object.keys(record!);
    expect(keys.indexOf("sit:operatorActionStatus")).toBeLessThan(
      keys.indexOf("sit:complianceOption"),
    );
  });
});

describe("situationsToDatex — publication language", () => {
  const langOf = (situations: Rec[]) =>
    parser.parse(situationsToDatex(situations, AT)).messageContainer.payload["@_lang"];

  it("is the one language every headline and road name is in", () => {
    expect(langOf([situation()])).toBe("de");
  });

  it("is `mul` when the text is in several languages", () => {
    const bilingual = situation({
      headline: [
        { lang: "de", text: "Bauarbeiten A 46" },
        { lang: "en", text: "Roadworks A 46" },
      ],
    });
    expect(langOf([bilingual])).toBe("mul");
    const undetermined = situation({
      location: {
        geometry: { type: "Point", coordinates: [6.81, 51.2] },
        roads: [{ name: [{ lang: "und", text: "A46" }] }],
      },
    });
    expect(langOf([situation(), undetermined])).toBe("mul");
  });

  it("is `und` with no text, and ignores situations left out", () => {
    expect(langOf([])).toBe("und");
    const hgv = effect("x", "closure", {
      scope: "road",
      applicability: { kind: "classes", include: [{ class: "hgv" }] },
    });
    const english = situation({
      headline: [{ lang: "en", text: "Closed to lorries" }],
      effects: [hgv],
    });
    expect(langOf([situation(), english])).toBe("de");
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
    // roadInformation/roadName is a plain string in DATEX v3, so the name comes
    // back with an undetermined language.
    expect((draft!["location"] as Rec)["roads"]).toEqual([
      { ref: "A46", name: [{ lang: "und", text: "Autobahn 46" }] },
    ]);
    expect((draft!["effects"] as Rec[]).map((e) => e["kind"])).toContain("closure");
  });

  it("re-ingests the lifecycle and operator action status it wrote", () => {
    const planned = closure({
      validity: { status: "planned", start: "2026-09-06T08:00:00Z" },
      effects: [effect("c/closure", "closure", { scope: "carriageway", actionStatus: "approved" })],
    });
    const [draft] = parseEvents(feed, [Buffer.from(situationsToDatex([planned], AT))]).situations;
    expect(draft).toMatchObject({ validity: { status: "planned" } });
    expect(draft!["effects"]).toEqual([
      expect.objectContaining({ kind: "closure", scope: "carriageway", actionStatus: "approved" }),
    ]);
  });

  it("re-ingests a road that has a name but no number", () => {
    const named = closure({
      location: {
        geometry: { type: "Point", coordinates: [6.81, 51.2] },
        roads: [{ name: [{ lang: "de", text: "Hauptstraße" }] }],
      },
    });
    const [draft] = parseEvents(feed, [Buffer.from(situationsToDatex([named], AT))]).situations;
    expect((draft!["location"] as Rec)["roads"]).toEqual([
      { name: [{ lang: "und", text: "Hauptstraße" }] },
    ]);
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
