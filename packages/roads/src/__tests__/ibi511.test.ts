import { describe, expect, it } from "vitest";
import { parseIbi511, parseIbi511Conditions } from "../ibi511.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "ca-on-511",
  attribution: "Ontario 511",
  country: "CA",
  license: "OGL-ON",
};

describe("parseIbi511", () => {
  it("maps EventType buckets to canonical types and decodes the polyline geometry", () => {
    // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" is Google's reference polyline (3 points).
    const out = parseIbi511(
      JSON.stringify([
        {
          ID: 101,
          RoadwayName: "Highway 401",
          EventType: "roadwork",
          EventSubType: "Construction",
          Description: "Lane reductions for paving",
          Severity: "Major",
          EncodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
          LastUpdated: "2026-06-25T10:00:00Z",
        },
      ]),
      SRC
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "ca-on-511:101",
      sourceFormat: "ibi511",
      type: "roadworks",
      severity: "high",
      headline: "Lane reductions for paving",
    });
    expect(out[0]!.geometry!.type).toBe("LineString");
    expect(out[0]!.roads).toEqual([{ name: "Highway 401" }]);
  });

  it("treats IsFullClosure as a road_closure regardless of EventType", () => {
    const out = parseIbi511(
      [
        {
          ID: 2,
          EventType: "accidentsAndIncidents",
          IsFullClosure: true,
          Latitude: 43.65,
          Longitude: -79.38,
        },
      ],
      SRC
    );
    expect(out[0]!.type).toBe("road_closure");
    expect(out[0]!.geometry).toEqual({ type: "Point", coordinates: [-79.38, 43.65] });
  });

  it("maps accidentsAndIncidents to accident and builds a 2-point line from secondary coords", () => {
    const out = parseIbi511(
      [
        {
          ID: 3,
          EventType: "accidentsAndIncidents",
          Latitude: 43.6,
          Longitude: -79.4,
          LatitudeSecondary: 43.61,
          LongitudeSecondary: -79.41,
        },
      ],
      SRC
    );
    expect(out[0]!.type).toBe("accident");
    expect(out[0]!.geometry!.type).toBe("LineString");
  });

  it("converts epoch-seconds dates (the real API shape) to ISO timestamps", () => {
    // The live /api/v2/get/event feed returns StartDate/PlannedEndDate/LastUpdated
    // as Unix epoch SECONDS (numbers), not ISO strings. Passing them through raw
    // crashed the on-511 batch insert ("date/time field value out of range").
    const out = parseIbi511(
      [
        {
          ID: 7,
          EventType: "roadwork",
          Latitude: 43.65,
          Longitude: -79.38,
          StartDate: 1757502000,
          PlannedEndDate: 1785538800,
          LastUpdated: 1757532060,
        },
      ],
      SRC
    );
    expect(out[0]!.validFrom).toBe("2025-09-10T11:00:00.000Z");
    expect(out[0]!.validTo).toBe(new Date(1785538800 * 1000).toISOString());
    expect(out[0]!.dataUpdatedAt).toBe(new Date(1757532060 * 1000).toISOString());
  });

  it("skips events without usable geometry and tolerates malformed input", () => {
    expect(parseIbi511([{ ID: 9, EventType: "closures" }], SRC)).toEqual([]);
    expect(parseIbi511("not json", SRC)).toEqual([]);
    expect(parseIbi511(JSON.stringify({ not: "an array" }), SRC)).toEqual([]);
  });
});

describe("parseIbi511 — Ontario construction projects", () => {
  const CONSTRUCTION_SRC: SourceDescriptor = { ...SRC, id: "ca-on-511-construction" };

  // Verbatim from one live /constructionprojects record; the endpoint returns a
  // bare array whose field set is a subset of /event's plus the recurrence and
  // link fields, which ride along in sourceRaw.
  const RECORD = {
    ID: 395,
    SourceId: "2022-2017-809023677",
    Organization: "MTO-constructions",
    RoadwayName: "400",
    DirectionOfTravel: "N/A",
    Description: "Highway 400 - South of King Road to north of Canal Road",
    Reported: 1652241600,
    LastUpdated: 1784846059,
    StartDate: 1652241600,
    PlannedEndDate: 1782792000,
    LanesAffected: "No Data",
    Latitude: 43.9205568869433,
    Longitude: -79.5660099009156,
    LatitudeSecondary: null,
    LongitudeSecondary: null,
    EventType: "roadwork",
    IsFullClosure: false,
    Comment: null,
    EncodedPolyline: "ofakGpfsdNoUjDkAPiIlA_LbB{u@~KoG~@}KbBkBVqWzD_C^cFr@gTbD",
    Recurrence: "",
    RecurrenceSchedules: "",
    LinkId: "29602591",
  };

  it("maps a construction project to planned roadworks with a decoded LineString", () => {
    const [ev] = parseIbi511([RECORD], CONSTRUCTION_SRC);
    expect(ev).toBeDefined();
    expect(ev!.id).toBe("ca-on-511-construction:395");
    expect(ev!.type).toBe("roadworks");
    expect(ev!.category).toBe("planned");
    expect(ev!.isPlanned).toBe(true);
    expect(ev!.geometry.type).toBe("LineString");
    expect((ev!.geometry as { coordinates: unknown[] }).coordinates.length).toBeGreaterThan(1);
    expect(ev!.roads?.map((r) => r.name)).toContain("400");
  });

  it("reads the epoch-seconds validity window and update time", () => {
    const [ev] = parseIbi511([RECORD], CONSTRUCTION_SRC);
    expect(ev!.validFrom).toBe(new Date(1652241600 * 1000).toISOString());
    expect(ev!.validTo).toBe(new Date(1782792000 * 1000).toISOString());
    expect(ev!.dataUpdatedAt).toBe(new Date(1784846059 * 1000).toISOString());
  });

  it("keeps the construction-only recurrence fields in sourceRaw", () => {
    const [ev] = parseIbi511([{ ...RECORD, Recurrence: "Weekly" }], CONSTRUCTION_SRC);
    expect(ev!.sourceRaw).toMatchObject({ Recurrence: "Weekly", LinkId: "29602591" });
  });
});

describe("parseIbi511Conditions", () => {
  const ON: SourceDescriptor = { ...SRC, id: "ca-on-511-conditions" };
  const NY: SourceDescriptor = { ...SRC, id: "us-ny-511-conditions", country: "US" };

  // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" is Google's reference polyline (3 points).
  const LINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

  it("maps an adverse Ontario record (array polyline) to a MultiLineString conditions event", () => {
    const [ev] = parseIbi511Conditions(
      [
        {
          LocationDescription: "From Highway 17 to Pukaskwa Park",
          Condition: ["Snow Covered"],
          Region: "NWR - Marathon - 212",
          RoadwayName: "627",
          EncodedPolyline: [LINE, LINE],
          LastUpdated: 1779729425,
        },
      ],
      ON
    );
    expect(ev).toBeDefined();
    expect(ev!.type).toBe("weather");
    expect(ev!.category).toBe("conditions");
    expect(ev!.severity).toBe("high");
    expect(ev!.geometry.type).toBe("MultiLineString");
    expect(ev!.roads).toEqual([{ name: "627" }]);
    expect(ev!.headline).toContain("Snow Covered");
    expect(ev!.dataUpdatedAt).toBe(new Date(1779729425 * 1000).toISOString());
  });

  it("emits a LineString when only one polyline is given", () => {
    const [ev] = parseIbi511Conditions(
      [{ RoadwayName: "17", Condition: ["Slushy"], EncodedPolyline: [LINE] }],
      ON
    );
    expect(ev!.geometry.type).toBe("LineString");
    expect(ev!.severity).toBe("medium");
  });

  it("reads 511NY's `Polyline` alias and its single-string Condition", () => {
    const [ev] = parseIbi511Conditions(
      [
        {
          Condition: "Snow / Ice",
          AreaName: "NYS THRUWAY",
          LocationDescription: "NYS Thruway New England Section Exits 8 - 22",
          RoadwayName: "I-95",
          Polyline: LINE,
          LastUpdated: 1785482707,
        },
      ],
      NY
    );
    expect(ev).toBeDefined();
    expect(ev!.geometry.type).toBe("LineString");
    expect(ev!.severity).toBe("high");
    expect(ev!.headline).toContain("NYS Thruway");
  });

  it("treats a closed road as a critical closure rather than a weather note", () => {
    const [ev] = parseIbi511Conditions(
      [{ RoadwayName: "11", Condition: ["Closed"], EncodedPolyline: [LINE] }],
      ON
    );
    expect(ev!.type).toBe("road_closure");
    expect(ev!.category).toBe("incident");
    expect(ev!.severity).toBe("critical");
    expect(ev!.roadState).toBe("closed");
  });

  it("skips records whose conditions are all nominal", () => {
    // The live summer feeds are entirely "No Report" / "Generally Clear & Dry".
    const out = parseIbi511Conditions(
      [
        { RoadwayName: "627", Condition: ["No Report"], EncodedPolyline: [LINE] },
        { RoadwayName: "I-95", Condition: "Generally Clear & Dry", Polyline: LINE },
        { RoadwayName: "I-90", Condition: "Update Pending", Polyline: LINE },
        { RoadwayName: "17", Condition: ["Bare and Dry"], EncodedPolyline: [LINE] },
      ],
      ON
    );
    expect(out).toEqual([]);
  });

  it("skips records with no usable geometry and tolerates malformed input", () => {
    expect(parseIbi511Conditions([{ RoadwayName: "9", Condition: ["Icy"] }], ON)).toEqual([]);
    expect(
      parseIbi511Conditions([{ RoadwayName: "9", Condition: ["Icy"], Polyline: null }], ON)
    ).toEqual([]);
    expect(parseIbi511Conditions("not json", ON)).toEqual([]);
    expect(parseIbi511Conditions(JSON.stringify({ not: "an array" }), ON)).toEqual([]);
  });
});
