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
      "sit:impact": { "sit:numberOfLanesRestricted": 1 },
      "sit:locationReference": {
        "loc:supplementaryPositionalDescription": {
          "loc:carriageway": {
            "loc:carriageway": "unspecifiedCarriageway",
            "loc:originalNumberOfLanes": 3,
          },
        },
      },
    });
    expect(records[1]!["sit:impact"]).not.toHaveProperty("sit:numberOfOperationalLanes");
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
    const lanes = records.map((r) => [
      r["sit:impact"],
      ((r["sit:locationReference"] as Rec)["loc:supplementaryPositionalDescription"] as Rec)[
        "loc:carriageway"
      ],
    ]);
    expect(lanes).toContainEqual([
      { "sit:numberOfLanesRestricted": 1 },
      { "loc:carriageway": "unspecifiedCarriageway", "loc:originalNumberOfLanes": 3 },
    ]);
    expect(lanes).toContainEqual([{ "sit:numberOfLanesRestricted": 2 }, undefined]);
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

  it("writes a line as a linear location of its coordinates, latitude first", () => {
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
      "@_xsi:type": "loc:LinearLocation",
      "loc:supplementaryPositionalDescription": {
        "loc:roadInformation": [{ "loc:roadNumber": "A46" }],
      },
      "loc:gmlLineString": { "loc:posList": "51.2 6.81 51.21 6.83" },
    });
  });

  it("writes a line's coordinates near zero as decimals, which a posList requires", () => {
    const line = situation({
      location: {
        geometry: {
          type: "LineString",
          coordinates: [
            [-1e-7, 0],
            [5e-324, -0],
          ],
        },
      },
    });
    expect(datexRecordsOf(line, AT)[0]!["sit:locationReference"]).toMatchObject({
      "loc:gmlLineString": { "loc:posList": "0 -0.0000001 0 0" },
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
    // DATEX states one group of characteristics, and no exception to it.
    for (const applicability of [
      { kind: "classes", include: [{ class: "hgv" }, { class: "bus" }] },
      { kind: "all", except: [{ usage: "local_access" }] },
      { kind: "classes", include: [{ hovMin: 2 }] },
      { kind: "classes", include: [{ fuel: "cng" }] },
    ]) {
      const closed = effect("x", "closure", { scope: "road", applicability });
      expect(datexRecordsOf(situation({ effects: [closed] }), AT)).toEqual([]);
    }
  });

  it("states the vehicles a measure applies to as one group of characteristics", () => {
    const heavy = effect("x", "closure", {
      scope: "road",
      applicability: {
        kind: "classes",
        include: [
          {
            class: "truck",
            fuel: "diesel",
            emission: { scheme: "euro", values: ["euro5"] },
            when: [
              { dimension: "gross_weight", operator: "gt", value: { value: 7500, unit: "kg" } },
              { dimension: "height", operator: "gte", value: { value: 4, unit: "m" } },
            ],
          },
        ],
      },
    });
    const [, record] = datexRecordsOf(situation({ effects: [heavy] }), AT);
    expect(record!["sit:forVehiclesWithCharacteristicsOf"]).toEqual({
      "com:fuelType": "diesel",
      "com:vehicleType": "lorry",
      "com:grossWeightCharacteristic": [
        {
          "com:comparisonOperator": "greaterThan",
          "com:grossVehicleWeight": 7.5,
          "com:typeOfWeight": "maximumPermitted",
        },
      ],
      "com:heightCharacteristic": [
        { "com:comparisonOperator": "greaterThanOrEqualTo", "com:vehicleHeight": 4 },
      ],
      "com:emissions": { "com:emissionClassificationEuro": "euro5" },
    });
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
      applicability: { kind: "classes", include: [{ class: "hgv" }, { class: "bus" }] },
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

  it("re-ingests a rating of no impact as none, not as an unknown one", () => {
    const none = closure({ severity: { label: "none", source: "declared" } });
    const [lead] = datexRecordsOf(none, AT);
    expect(lead).toHaveProperty("sit:severity", "none");
    const [draft] = parseEvents(feed, [Buffer.from(situationsToDatex([none], AT))]).situations;
    expect(draft!["severity"]).toEqual({ label: "none", source: "declared", declaredRaw: "none" });
  });

  it("re-ingests a delay's length, band and description", () => {
    const delayed = situation({
      effects: [
        ...(situation()["effects"] as Rec[]),
        effect("a46/delay", "delay", {
          compliance: "unknown",
          delay: { value: 2400, unit: "s" },
          delayBand: "between_thirty_minutes_and_one_hour",
          delayType: "long_delays",
        }),
      ],
    });
    const [lead] = datexRecordsOf(delayed, AT);
    expect((lead!["sit:impact"] as Rec)["sit:delays"]).toEqual({
      "sit:delayBand": "betweenThirtyMinutesAndOneHour",
      "sit:delaysType": "longDelays",
      "sit:delayTimeValue": 2400,
    });
    const [draft] = parseEvents(feed, [Buffer.from(situationsToDatex([delayed], AT))]).situations;
    expect(draft!["effects"]).toContainEqual(
      expect.objectContaining({
        kind: "delay",
        delay: { value: 2400, unit: "s" },
        delayBand: "between_thirty_minutes_and_one_hour",
        delayType: "long_delays",
      }),
    );
  });

  it("re-ingests restricted lanes as restricted, and closed lanes as restricted of the total", () => {
    const restricted = situation({
      effects: [
        effect("a46/lanes", "lane_restriction", {
          vehicleImpact: "unknown",
          lanesTotal: 3,
          lanesRestricted: 2,
          lanesOperational: 1,
        }),
      ],
    });
    const records = datexRecordsOf(restricted, AT);
    // Restricted lanes may be open: they are managed lanes, not lane closures.
    expect(records[1]).toMatchObject({
      "sit:roadOrCarriagewayOrLaneManagementType": "other",
      "sit:impact": { "sit:numberOfLanesRestricted": 2, "sit:numberOfOperationalLanes": 1 },
    });
    const [draft] = parseEvents(feed, [
      Buffer.from(situationsToDatex([restricted], AT)),
    ]).situations;
    expect(draft!["effects"]).toEqual([
      expect.objectContaining({
        kind: "lane_restriction",
        vehicleImpact: "unknown",
        lanesTotal: 3,
        lanesRestricted: 2,
        lanesOperational: 1,
      }),
    ]);
    const [closed] = parseEvents(feed, [
      Buffer.from(situationsToDatex([situation()], AT)),
    ]).situations;
    // The total travels with the carriageway, not as operational lanes nobody stated.
    expect(closed!["effects"]).toContainEqual(
      expect.objectContaining({
        kind: "lane_restriction",
        vehicleImpact: "some_lanes_closed",
        lanesTotal: 3,
        lanesRestricted: 1,
      }),
    );
    expect((closed!["effects"] as Rec[])[0]).not.toHaveProperty("lanesOperational");
  });

  it("re-ingests every lane of a lane closure open, with the lanes of the carriageway", () => {
    const open = closure({
      subtype: "lane",
      effects: [
        effect("c/lanes", "lane_restriction", { vehicleImpact: "all_lanes_open", lanesTotal: 2 }),
      ],
    });
    const [record] = datexRecordsOf(open, AT);
    expect(record).toMatchObject({
      "sit:roadOrCarriagewayOrLaneManagementType": "laneClosures",
      "sit:impact": { "sit:numberOfLanesRestricted": 0 },
    });
    const [draft] = parseEvents(feed, [Buffer.from(situationsToDatex([open], AT))]).situations;
    expect(draft).toMatchObject({ kind: "closure", type: "closure", subtype: "lane" });
    expect(draft!["effects"]).toEqual([
      expect.objectContaining({
        kind: "lane_restriction",
        vehicleImpact: "all_lanes_open",
        lanesTotal: 2,
        lanesRestricted: 0,
      }),
    ]);
  });

  it("re-ingests what the works are, the informant and a measure's direction of traffic", () => {
    const described = situation({
      details: {
        kind: "roadworks",
        v: 1,
        scale: "major",
        durationClass: "long_term",
        urgent: false,
        underTraffic: true,
      },
      provenance: {
        sourceUpdatedAt: "2026-09-06T09:00:00Z",
        informationSource: {
          type: "road_operator_patrol",
          name: [{ lang: "de", text: "Autobahnmeisterei" }],
          id: "AM-7",
          country: "DE",
          reliable: true,
        },
      },
      effects: [
        effect("a46/speed", "speed_limit", {
          limit: { value: 60, unit: "km/h" },
          direction: { value: "unknown", basis: "compass", compass: "W", text: "westBound" },
        }),
      ],
    });
    const records = datexRecordsOf(described, AT);
    expect(records[0]).toMatchObject({
      "sit:source": {
        "com:sourceCountry": "de",
        "com:sourceIdentification": "AM-7",
        "com:sourceType": "roadOperatorPatrol",
        "com:reliable": true,
      },
      "sit:roadworksDurationClassification": "longTerm",
      "sit:roadworksScale": "major",
      "sit:underTraffic": true,
      "sit:urgentRoadworks": false,
    });
    expect(records[1]).toHaveProperty("sit:applicableForTrafficDirection", "westBound");
    const [draft] = parseEvents(feed, [Buffer.from(situationsToDatex([described], AT))]).situations;
    expect(draft!["details"]).toMatchObject({
      scale: "major",
      durationClass: "long_term",
      urgent: false,
      underTraffic: true,
    });
    expect((draft!["provenance"] as Rec)["informationSource"]).toEqual(
      (described["provenance"] as Rec)["informationSource"],
    );
    expect(draft!["effects"]).toEqual([
      expect.objectContaining({
        kind: "speed_limit",
        direction: { value: "unknown", basis: "compass", compass: "W", text: "westBound" },
      }),
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

  const snapshot = { ...feed, snapshot: { completeness: "complete" } } as RoadFeed;
  const reread = (situations: Rec[], via: RoadFeed = feed) =>
    parseEvents(via, [Buffer.from(situationsToDatex(situations, AT))]).situations;
  const ID = "oc:situation:de-autobahn-events:a46";

  it("keeps a source record's id without its version, and gives a second effect of it its own", () => {
    const shared = situation({
      effects: [
        effect("r/lanes", "lane_restriction", {
          vehicleImpact: "unknown",
          lanesTotal: 4,
          sourceRecordRef: "R-2/7",
        }),
        effect("r/contraflow", "contraflow", { sourceRecordRef: "R-2/7" }),
      ],
    });
    expect(datexRecordsOf(shared, AT).map((r) => r["@_id"])).toEqual([
      ID,
      "R-2",
      `${ID}#r/contraflow`,
    ]);
    // A complete snapshot refuses two records of one id and version that differ.
    const [draft] = reread([shared], snapshot);
    expect(draft!["effects"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "lane_restriction",
          lanesTotal: 4,
          sourceRecordRef: "R-2/3",
        }),
        expect.objectContaining({ kind: "contraflow", sourceRecordRef: `${ID}#r/contraflow/3` }),
      ]),
    );
  });

  it("keeps the source record of an effect folded into the nature record", () => {
    const folded = closure({
      effects: [effect("c/closure", "closure", { scope: "road", sourceRecordRef: "C-1/4" })],
    });
    expect(datexRecordsOf(folded, AT).map((r) => r["@_id"])).toEqual(["C-1"]);
    const [draft] = reread([folded], snapshot);
    expect(draft!["effects"]).toEqual([
      expect.objectContaining({ kind: "closure", sourceRecordRef: "C-1/3" }),
    ]);
  });

  it("states an unknown certainty and a declared unknown severity as DATEX's own unknowns", () => {
    const unknown = situation({
      kind: "incident",
      type: "breakdown",
      details: undefined,
      effects: [],
      certainty: "unknown",
      severity: { label: "unknown", declaredRaw: "unknown" },
    });
    const [record] = datexRecordsOf(unknown, AT);
    expect(record).toMatchObject({
      "sit:probabilityOfOccurrence": { "@__extendedValue": "unknown", "#text": "_extended" },
      "sit:severity": "unknown",
    });
    const [draft] = reread([unknown]);
    expect(draft).toMatchObject({
      certainty: "unknown",
      severity: { label: "unknown", declaredRaw: "unknown" },
    });
    // A severity nobody stated is not written at all.
    const unstated = closure({ severity: { label: "unknown" } });
    expect(datexRecordsOf(unstated, AT)[0]).not.toHaveProperty("sit:severity");
  });

  it("re-ingests the cause, the description and the public comments, in that order", () => {
    const described = situation({
      causes: [{ type: "maintenance" }],
      description: [{ lang: "de", text: "Fahrbahnerneuerung" }],
      comments: [
        { type: "public", text: [{ lang: "de", text: "Umleitung ausgeschildert" }] },
        { type: "internal", text: [{ lang: "de", text: "Nur für die Leitstelle" }] },
      ],
    });
    const [lead] = datexRecordsOf(described, AT);
    expect(lead).toMatchObject({ "sit:cause": { "sit:causeType": "roadMaintenance" } });
    expect(lead!["sit:generalPublicComment"]).toHaveLength(3);
    const [draft] = reread([described]);
    expect(draft).toMatchObject({
      causes: [{ type: "maintenance" }],
      headline: described["headline"],
      description: [{ lang: "de", text: "Fahrbahnerneuerung" }],
      comments: [{ type: "public", text: [{ lang: "de", text: "Umleitung ausgeschildert" }] }],
    });
  });

  it("states the description's comment type, so one repeating the headline reads back as it", () => {
    const repeated = situation({ description: situation()["headline"] });
    const [lead] = datexRecordsOf(repeated, AT);
    expect(lead!["sit:generalPublicComment"]).toEqual([
      expect.not.objectContaining({ "sit:commentType": expect.anything() }),
      expect.objectContaining({ "sit:commentType": "description" }),
    ]);
    const [draft] = reread([repeated]);
    expect(draft).toMatchObject({
      headline: repeated["headline"],
      description: repeated["headline"],
    });
    expect(draft).not.toHaveProperty("comments");
  });

  it("re-ingests a queue on abnormal traffic, with the capacity that remains", () => {
    const queue = situation({
      kind: "congestion",
      type: "congestion",
      subtype: "queuing",
      details: undefined,
      effects: [
        effect("q/delay", "delay", {
          compliance: "unknown",
          queueLength: { value: 2616, unit: "m" },
          capacityRemainingPct: 50,
        }),
      ],
    });
    const [record] = datexRecordsOf(queue, AT);
    expect(record).toMatchObject({
      "@_xsi:type": "sit:AbnormalTraffic",
      "sit:impact": { "sit:capacityRemaining": 50 },
      "sit:queueLength": 2616,
    });
    const [draft] = reread([queue]);
    expect(draft!["effects"]).toEqual([
      expect.objectContaining({
        kind: "delay",
        queueLength: { value: 2616, unit: "m" },
        capacityRemainingPct: 50,
      }),
    ]);
  });

  it("supplements the record a delay was read with, not the leading one", () => {
    const accident = situation({
      kind: "incident",
      type: "accident",
      details: undefined,
      effects: [
        effect("r/closure", "closure", {
          scope: "carriageway",
          actionStatus: "implemented",
          sourceRecordRef: "R-1/2",
        }),
        effect("r/delay", "delay", {
          compliance: "unknown",
          actionStatus: "implemented",
          delayBand: "up_to_ten_minutes",
          sourceRecordRef: "R-1/2",
        }),
      ],
    });
    const [lead, closed] = datexRecordsOf(accident, AT);
    expect(lead).not.toHaveProperty("sit:impact");
    expect(closed).toMatchObject({
      "@_id": "R-1",
      "sit:impact": { "sit:delays": { "sit:delayBand": "upToTenMinutes" } },
    });
    const [draft] = reread([accident], snapshot);
    expect(draft!["effects"]).toContainEqual(
      expect.objectContaining({
        kind: "delay",
        delayBand: "up_to_ten_minutes",
        actionStatus: "implemented",
        sourceRecordRef: "R-1/3",
      }),
    );
  });

  it("re-ingests a diversion's description and route", () => {
    const route = {
      type: "LineString",
      coordinates: [
        [6.8, 51.2],
        [6.85, 51.25],
      ],
    };
    const diverted = situation({
      effects: [
        effect("d/detour", "detour", {
          compliance: "advisory",
          description: [{ lang: "und", text: "Volg route A" }],
          geometry: route,
        }),
      ],
    });
    const [, record] = datexRecordsOf(diverted, AT);
    expect(record).toMatchObject({
      "sit:reroutingManagementType": "followDiversionSigns",
      "sit:reroutingItineraryDescription": {
        "com:values": { "com:value": [{ "@_lang": "und", "#text": "Volg route A" }] },
      },
      "sit:alternativeRoute": {
        "@_xsi:type": "loc:ItineraryByIndexedLocations",
        "loc:locationContainedInItinerary": {
          "loc:location": { "loc:gmlLineString": { "loc:posList": "51.2 6.8 51.25 6.85" } },
        },
      },
    });
    const [draft] = reread([diverted]);
    expect(draft!["effects"]).toEqual([
      expect.objectContaining({
        kind: "detour",
        description: [{ lang: "und", text: "Volg route A" }],
        geometry: route,
      }),
    ]);
  });

  it("re-ingests a line, a point's bearing and external location codes", () => {
    const line = {
      type: "LineString",
      coordinates: [
        [4.734491, 52.294051],
        [4.734088, 52.293863],
      ],
    };
    const lined = closure({ location: { geometry: line } });
    expect(reread([lined])[0]!["location"]).toMatchObject({ geometry: line, extent: "linear" });
    const bearing = { value: "unknown", basis: "bearing", bearingDeg: 308 };
    const pointed = closure({
      location: {
        geometry: { type: "Point", coordinates: [5.05293, 52.110115] },
        direction: bearing,
        external: [{ system: "RIS-index", code: "NLTNZ001300522000264" }],
      },
    });
    expect(datexRecordsOf(pointed, AT)[0]!["sit:locationReference"]).toMatchObject({
      "loc:externalReferencing": [
        {
          "loc:externalLocationCode": "NLTNZ001300522000264",
          "loc:externalReferencingSystem": "RIS-index",
        },
      ],
      "loc:pointByCoordinates": { "loc:bearing": 308 },
    });
    expect(reread([pointed])[0]!["location"]).toMatchObject({
      direction: bearing,
      external: [{ system: "RIS-index", code: "NLTNZ001300522000264" }],
    });
  });

  it("states a place a location table gave as its Alert-C point, which the reader looks up again", () => {
    const tmc = { country: "8", table: 6, version: "6.13.A", code: 22370, direction: 0, method: 2 };
    const vild = {
      geometry: { type: "Point", coordinates: [5.717227, 50.8408564] },
      extent: "point",
      geometryOrigin: "tmc_table",
      fuzziness: "low_res",
      direction: { value: "positive", basis: "alert_c" },
      tmc,
      locationTable: {
        ref: "VILD",
        version: "6.13.A",
        attribution: "Rijkswaterstaat / Nationaal Dataportaal Wegverkeer — VILD 6.13.A",
        license: "CC0-1.0",
      },
    };
    const placed = closure({ location: vild });
    const [record] = datexRecordsOf(placed, AT);
    expect(record!["sit:locationReference"]).toEqual({
      "@_xsi:type": "loc:PointLocation",
      "loc:alertCPoint": {
        "@_xsi:type": "loc:AlertCMethod2Point",
        "loc:alertCLocationCountryCode": "8",
        "loc:alertCLocationTableNumber": "6.13",
        "loc:alertCLocationTableVersion": "A",
        "loc:alertCDirection": {
          "loc:alertCDirectionCoded": "positive",
          "loc:alertCAffectedDirection": "unknown",
        },
        "loc:alertCMethod2PrimaryPointLocation": {
          "loc:alertCLocation": { "loc:specificLocation": 22370 },
        },
      },
    });
    const { admin: _, ...read } = reread([placed])[0]!["location"] as Rec;
    expect(read).toEqual(vild);
    // A coarse place DATEX cannot state by its reference is still withheld.
    const { direction: _bit, ...undirected } = tmc;
    const coarse = closure({ location: { ...vild, direction: undefined, tmc: undirected } });
    expect(datexRecordsOf(coarse, AT)).toEqual([]);
  });

  it("re-ingests a closure for lorries as one for trucks, and a ban on them as a closure for them", () => {
    const lorries = { kind: "classes", include: [{ class: "truck" }] };
    const closed = closure({
      effects: [effect("c/closure", "closure", { scope: "road", applicability: lorries })],
    });
    const [record] = datexRecordsOf(closed, AT);
    expect(record).toMatchObject({
      "sit:roadOrCarriagewayOrLaneManagementType": "roadClosed",
      "sit:forVehiclesWithCharacteristicsOf": { "com:vehicleType": "lorry" },
    });
    expect(reread([closed])[0]!["effects"]).toEqual([
      expect.objectContaining({ kind: "closure", applicability: { ...lorries, raw: ["lorry"] } }),
    ]);
    const banned = situation({
      effects: [effect("b/access", "access", { mode: "prohibited", applicability: lorries })],
    });
    expect(datexRecordsOf(banned, AT)[1]).toMatchObject({
      "sit:roadOrCarriagewayOrLaneManagementType": "roadClosed",
      "sit:forVehiclesWithCharacteristicsOf": { "com:vehicleType": "lorry" },
    });
  });

  it("re-ingests a line's Alert-C reference: linear with its offsets, or a point on the line", () => {
    const geometry = {
      type: "LineString",
      coordinates: [
        [4.900625, 52.33224],
        [4.890899, 52.337415],
      ],
    };
    const linear = {
      country: "8",
      table: 6,
      version: "6.13.A",
      code: 7201,
      secondary: 7194,
      direction: 0,
      affectedDirection: "aligned",
      method: 4,
      primaryOffsetM: 85,
      secondaryOffsetM: 1597,
    };
    const lined = closure({ location: { geometry, tmc: linear } });
    expect(datexRecordsOf(lined, AT)[0]!["sit:locationReference"]).toMatchObject({
      "@_xsi:type": "loc:SingleRoadLinearLocation",
      "loc:alertCLinear": {
        "@_xsi:type": "loc:AlertCMethod4Linear",
        "loc:alertCMethod4SecondaryPointLocation": {
          "loc:alertCLocation": { "loc:specificLocation": 7194 },
          "loc:offsetDistance": { "loc:offsetDistance": 1597 },
        },
      },
    });
    expect(reread([lined])[0]!["location"]).toMatchObject({ geometry, tmc: linear });
    const point = {
      country: "8",
      table: 6,
      version: "6.13.A",
      code: 7201,
      direction: 1,
      method: 2,
    };
    const pointed = closure({ location: { geometry, tmc: point } });
    expect(datexRecordsOf(pointed, AT)[0]!["sit:locationReference"]).toMatchObject({
      "@_xsi:type": "loc:ItineraryByIndexedLocations",
    });
    expect(reread([pointed])[0]!["location"]).toMatchObject({ geometry, tmc: point });
  });

  it("re-ingests periods and exceptions in the zone of the record's place", () => {
    const weekly = {
      repeatFrequency: "P1W",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      startTime: "20:00:00",
      endTime: "05:00:00",
      duration: "PT9H",
      byDay: ["MO", "TU"],
      scheduleTimezone: "Europe/Berlin",
    };
    const once = {
      startDate: "2026-09-15",
      endDate: "2026-09-15",
      startTime: "22:00:00",
      duration: "P1DT2H",
      scheduleTimezone: "Europe/Berlin",
    };
    const nightly = closure({
      validity: {
        status: "active",
        start: "2026-09-01T00:00:00Z",
        end: "2026-10-01T00:00:00Z",
        periods: [weekly],
        exceptions: [once],
      },
    });
    const [record] = datexRecordsOf(nightly, AT);
    expect((record!["sit:validity"] as Rec)["com:validityTimeSpecification"]).toMatchObject({
      "com:validPeriod": [
        {
          // From the first night's start to the last night's end.
          "com:startOfPeriod": "2026-09-01T18:00:00.000Z",
          "com:endOfPeriod": "2026-10-01T03:00:00.000Z",
          "com:recurringTimePeriodOfDay": {
            "com:startTimeOfPeriod": "20:00:00",
            "com:endTimeOfPeriod": "05:00:00",
          },
          "com:recurringDayWeekMonthPeriod": { "com:applicableDay": ["monday", "tuesday"] },
        },
      ],
      "com:exceptionPeriod": [
        {
          "com:startOfPeriod": "2026-09-15T20:00:00.000Z",
          "com:endOfPeriod": "2026-09-16T22:00:00.000Z",
        },
      ],
    });
    const [draft] = reread([nightly]);
    expect(draft!["validity"]).toMatchObject({ periods: [weekly], exceptions: [once] });
    // A period that only starts is the time from its start on, to the second.
    const from = {
      repeatFrequency: "P1D",
      startDate: "2026-09-01",
      startTime: "18:21:35",
      duration: "PT25H",
      scheduleTimezone: "Europe/Berlin",
    };
    const open = closure({
      validity: { status: "active", start: "2026-09-01T00:00:00Z", periods: [from] },
    });
    expect(
      (
        (datexRecordsOf(open, AT)[0]!["sit:validity"] as Rec)[
          "com:validityTimeSpecification"
        ] as Rec
      )["com:validPeriod"],
    ).toEqual([{ "com:startOfPeriod": "2026-09-01T16:21:35.000Z" }]);
    expect(reread([open])[0]!["validity"]).toMatchObject({ periods: [from] });
    // Times of day in another zone than the place's cannot be stated.
    const elsewhere = closure({
      validity: {
        ...(nightly["validity"] as Rec),
        periods: [{ ...weekly, scheduleTimezone: "America/New_York" }],
      },
    });
    const diagnostics: string[] = [];
    expect(datexRecordsOf(elsewhere, AT, (d) => diagnostics.push(`${d.code} ${d.path}`))).toEqual(
      [],
    );
    expect(diagnostics).toContain("unsupported_timing /validity/periods");
  });

  it("re-ingests a movable bridge open, traffic held and a rockfall as what they are", () => {
    for (const subtype of ["bridge", "intermittent"]) {
      const closed = closure({ subtype });
      expect(datexRecordsOf(closed, AT)).toHaveLength(1);
      const [draft] = reread([closed]);
      expect(draft).toMatchObject({ kind: "closure", type: "closure", subtype });
      expect(draft!["effects"]).toEqual([
        expect.objectContaining({ kind: "closure", scope: "road", compliance: "mandatory" }),
      ]);
    }
    const rockfall = situation({
      kind: "incident",
      type: "obstruction",
      subtype: "rockfall",
      details: undefined,
      effects: [],
    });
    expect(reread([rockfall])[0]).toMatchObject({ subtype: "rockfall" });
  });

  it("re-ingests a related situation as a relation to it, and reports any other kind", () => {
    const other = `oc:situation:${feed.id}:M1_D2`;
    const related = closure({
      relations: [
        { ref: { class: "situation", id: other }, relation: "related" },
        { ref: { class: "situation", id: `${other}-detour` }, relation: "detour_for" },
      ],
    });
    const xml = situationsToDatex([related], AT);
    expect(parser.parse(xml).messageContainer.payload["sit:situation"]).toMatchObject({
      "sit:relatedSituation": {
        "sit:objectReference": { "@_targetClass": "sit:Situation", "@_id": other },
      },
    });
    const diagnostics: string[] = [];
    datexRecordsOf(related, AT, (d) => diagnostics.push(`${d.code} ${d.path}`));
    expect(diagnostics).toContain("field_not_exported /relations/1");
    // The related situation's id in the export is its OpenConditions id, which
    // a re-ingest prefixes with its source as it does every situation id.
    expect(reread([related])[0]!["relations"]).toEqual([
      { ref: { class: "situation", id: `oc:situation:${feed.id}:${other}` }, relation: "related" },
    ]);
  });
});
