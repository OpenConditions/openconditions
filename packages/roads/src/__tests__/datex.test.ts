import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";

const NDW_FIXTURE_PATH = join(import.meta.dirname, "fixtures/ndw/actueel_beeld.xml");

const NDW_SOURCE = {
  id: "ndw",
  attribution: "NDW / Rijkswaterstaat",
  country: "NL",
  license: "CC0-1.0",
  licenseUrl: "https://www.ndw.nu",
} as const;

describe("parseDatexSituations — NDW actueel_beeld.xml fixture", () => {
  it("parses at least one RoadEvent with a Point geometry", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    expect(events.length).toBeGreaterThan(0);

    const pointEvent = events.find((ev) => ev.geometry?.type === "Point");
    expect(pointEvent).toBeDefined();
  });

  it("emits sourceFormat:'datex2' and domain:'roads' on every event", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    expect(events.every((ev) => ev.sourceFormat === "datex2")).toBe(true);
    expect(events.every((ev) => ev.domain === "roads")).toBe(true);
  });

  it("maps at least one event to a non-other type", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    const nonOther = events.filter((ev) => ev.type !== "other");
    expect(nonOther.length).toBeGreaterThan(0);
  });

  it("carries CC0-1.0 license from the source descriptor", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.origin.kind).toBe("feed");
      if (ev.origin.kind === "feed") {
        expect(ev.origin.attribution.license).toBe("CC0-1.0");
      }
    }
  });

  it("sets kind:'event' and isStale:false on every event", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    expect(events.every((ev) => ev.kind === "event")).toBe(true);
    expect(events.every((ev) => ev.isStale === false)).toBe(true);
  });

  it("reads situation-level overallSeverity so at least one event has severity !== 'unknown'", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    const nonUnknown = events.filter((ev) => ev.severity !== "unknown");
    expect(nonUnknown.length).toBeGreaterThan(0);
  });
});

describe("parseDatexSituations — v2/v3 root tolerance", () => {
  it("handles DATEX II v2 D2LogicalModel root", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D2LogicalModel modelBaseVersion="2">
  <payloadPublication xsi:type="SituationPublication"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <publicationTime>2024-01-01T00:00:00Z</publicationTime>
    <situation id="S1">
      <situationRecord xsi:type="Accident" id="R1" version="1">
        <situationRecordVersionTime>2024-01-01T00:00:00Z</situationRecordVersionTime>
        <probabilityOfOccurrence>certain</probabilityOfOccurrence>
        <validity>
          <validityStatus>active</validityStatus>
          <validityTimeSpecification>
            <overallStartTime>2024-01-01T00:00:00Z</overallStartTime>
          </validityTimeSpecification>
        </validity>
        <locationReference xsi:type="PointLocation">
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>52.0</latitude>
              <longitude>4.5</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </locationReference>
      </situationRecord>
    </situation>
  </payloadPublication>
</D2LogicalModel>`;

    const events = parseDatexSituations(xml, NDW_SOURCE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("accident");
    expect(events[0]!.geometry?.type).toBe("Point");
  });

  it("handles DATEX II v3 messageContainer/payload root", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<messageContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  modelBaseVersion="3">
  <payload xsi:type="SituationPublication">
    <publicationTime>2024-01-01T00:00:00Z</publicationTime>
    <situation id="S2">
      <situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" id="R2" version="1">
        <situationRecordVersionTime>2024-01-01T00:00:00Z</situationRecordVersionTime>
        <probabilityOfOccurrence>certain</probabilityOfOccurrence>
        <validity>
          <validityStatus>active</validityStatus>
          <validityTimeSpecification>
            <overallStartTime>2024-01-01T00:00:00Z</overallStartTime>
          </validityTimeSpecification>
        </validity>
        <locationReference xsi:type="PointLocation">
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>51.5</latitude>
              <longitude>4.0</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </locationReference>
      </situationRecord>
    </situation>
  </payload>
</messageContainer>`;

    const events = parseDatexSituations(xml, NDW_SOURCE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("lane_closure");
    expect(events[0]!.geometry?.type).toBe("Point");
  });
});

/** Wrap one situationRecord body in a minimal DATEX II v3 document. */
function v3Record(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<messageContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="3">
  <payload xsi:type="SituationPublication">
    <situation id="S">
      <situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" id="R" version="1">
        <situationRecordVersionTime>2024-01-01T00:00:00Z</situationRecordVersionTime>
        <validity><validityStatus>active</validityStatus></validity>
        ${inner}
      </situationRecord>
    </situation>
  </payload>
</messageContainer>`;
}

const POINT_LOC = `<locationReference xsi:type="PointLocation"><pointByCoordinates><pointCoordinates><latitude>52</latitude><longitude>13</longitude></pointCoordinates></pointByCoordinates></locationReference>`;

describe("parseDatexSituations — GML geometry", () => {
  it("reads a gmlLineString/posList as a LineString (lat-lon → [lon,lat])", () => {
    const xml = v3Record(
      `<locationReference xsi:type="LinearLocation"><gmlLineString srsName="WGS 84"><posList>52.0 13.0 52.1 13.1 52.2 13.2</posList></gmlLineString></locationReference>`
    );
    const [ev] = parseDatexSituations(xml, NDW_SOURCE);
    expect(ev!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [13.0, 52.0],
        [13.1, 52.1],
        [13.2, 52.2],
      ],
    });
  });

  it("reads an ItineraryByIndexedLocations of line segments as a MultiLineString", () => {
    const xml = v3Record(
      `<locationReference xsi:type="ItineraryByIndexedLocations">` +
        `<locationContainedInItinerary index="0"><location xsi:type="LinearLocation"><gmlLineString><posList>52.0 13.0 52.1 13.1</posList></gmlLineString></location></locationContainedInItinerary>` +
        `<locationContainedInItinerary index="1"><location xsi:type="LinearLocation"><gmlLineString><posList>52.2 13.2 52.3 13.3</posList></gmlLineString></location></locationContainedInItinerary>` +
        `</locationReference>`
    );
    const [ev] = parseDatexSituations(xml, NDW_SOURCE);
    expect(ev!.geometry?.type).toBe("MultiLineString");
    expect(ev!.geometry).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [13.0, 52.0],
          [13.1, 52.1],
        ],
        [
          [13.2, 52.2],
          [13.3, 52.3],
        ],
      ],
    });
  });
});

describe("parseDatexSituations — road management details", () => {
  it("reads roadState from the (leaf-text) management type", () => {
    const closed = parseDatexSituations(
      v3Record(
        `<roadOrCarriagewayOrLaneManagementType>carriagewayClosures</roadOrCarriagewayOrLaneManagementType>${POINT_LOC}`
      ),
      NDW_SOURCE
    );
    expect(closed[0]!.roadState).toBe("closed");

    const lanes = parseDatexSituations(
      v3Record(
        `<roadOrCarriagewayOrLaneManagementType>laneClosures</roadOrCarriagewayOrLaneManagementType>${POINT_LOC}`
      ),
      NDW_SOURCE
    );
    expect(lanes[0]!.roadState).toBe("some_lanes_closed");
  });

  it("reads lanesAffected from the nested <impact> element", () => {
    const [ev] = parseDatexSituations(
      v3Record(
        `<impact><numberOfLanesRestricted>2</numberOfLanesRestricted><numberOfOperationalLanes>1</numberOfOperationalLanes></impact>${POINT_LOC}`
      ),
      NDW_SOURCE
    );
    expect(ev!.lanesAffected?.closed).toBe(2);
  });
});

describe("parseDatexSituations — NDW real-feed coverage", () => {
  it("extracts most records incl. line geometries, road states and lane info", () => {
    const events = parseDatexSituations(readFileSync(NDW_FIXTURE_PATH), NDW_SOURCE);
    expect(events.length).toBeGreaterThan(400); // was ~206 (points only)
    expect(
      events.some((e) => e.geometry?.type === "LineString" || e.geometry?.type === "MultiLineString")
    ).toBe(true);
    expect(events.some((e) => e.roadState != null)).toBe(true);
    expect(events.some((e) => e.lanesAffected != null)).toBe(true);
  });
});

describe("parseDatexSituations — extended field extraction", () => {
  it("maps causeType to subtype and temporarySpeedLimit to speedLimitKph", () => {
    const xml = v3Record(
      `<cause><causeType>roadMaintenance</causeType></cause><temporarySpeedLimit>60</temporarySpeedLimit>${POINT_LOC}`
    );
    const [ev] = parseDatexSituations(xml, NDW_SOURCE);
    expect(ev!.subtype).toBe("roadMaintenance");
    expect(ev!.speedLimitKph).toBe(60);
  });

  it("maps rerouting description to detour and creation reference to relatedIds", () => {
    const xml = v3Record(
      `<situationRecordCreationReference>PARENT_1</situationRecordCreationReference><reroutingItineraryDescription>Use A4</reroutingItineraryDescription>${POINT_LOC}`
    );
    const [ev] = parseDatexSituations(xml, NDW_SOURCE);
    expect(ev!.detour).toBe("Use A4");
    expect(ev!.relatedIds).toEqual(["PARENT_1"]);
  });

  it("maps probabilityOfOccurrence to confidence and preserves the raw record", () => {
    const xml = v3Record(`<probabilityOfOccurrence>probable</probabilityOfOccurrence>${POINT_LOC}`);
    const [ev] = parseDatexSituations(xml, NDW_SOURCE);
    expect(ev!.confidence).toBe("likely");
    expect(ev!.sourceRaw).toBeDefined();
    expect(ev!.sourceRaw?.["probabilityOfOccurrence"]).toBe("probable");
  });
});

describe("parseDatexSituations — deeper field extraction", () => {
  it("maps vehicles, height restriction, lane total, delay, safety severity, alertC TMC", () => {
    const xml = v3Record(
      `<impact><numberOfLanesRestricted>1</numberOfLanesRestricted><delays><delayTimeValue>600</delayTimeValue></delays></impact>` +
        `<supplementaryPositionalDescription><carriageway><originalNumberOfLanes>3</originalNumberOfLanes></carriageway></supplementaryPositionalDescription>` +
        `<safetyRelatedMessage>true</safetyRelatedMessage>` +
        `<obstructingVehicle><vehicleCharacteristics><vehicleType>lorry</vehicleType></vehicleCharacteristics></obstructingVehicle>` +
        `<forVehiclesWithCharacteristicsOf><vehicleCharacteristics><heightCharacteristic><comparisonOperator>greaterThan</comparisonOperator><vehicleHeight>4.5</vehicleHeight></heightCharacteristic></vehicleCharacteristics></forVehiclesWithCharacteristicsOf>` +
        `<locationReference xsi:type="ItineraryByIndexedLocations"><locationContainedInItinerary><location>` +
        `<alertCLinear><alertCLocationCountryCode>8</alertCLocationCountryCode><alertCLocationTableNumber>6.13</alertCLocationTableNumber>` +
        `<alertCMethod4PrimaryPointLocation><alertCLocation><specificLocation>7324</specificLocation></alertCLocation></alertCMethod4PrimaryPointLocation></alertCLinear>` +
        `<gmlLineString><posList>52 13 52.1 13.1</posList></gmlLineString></location></locationContainedInItinerary></locationReference>`
    );
    const [ev] = parseDatexSituations(xml, NDW_SOURCE);
    expect(ev!.vehiclesAffected).toContain("lorry");
    expect(ev!.restrictions).toContainEqual({ type: "height", value: 4.5, unit: "m" });
    expect(ev!.lanesAffected?.total).toBe(3);
    expect(ev!.lanesAffected?.closed).toBe(1);
    expect(ev!.delaySeconds).toBe(600);
    expect(ev!.severity).toBe("medium"); // bumped: safetyRelatedMessage + no declared severity
    expect(ev!.externalRefs?.tmc?.code).toBe(7324);
    expect(ev!.externalRefs?.tmc?.country).toBe("8");
  });
});

describe("parseDatexSituations — OpenLR unresolved markers", () => {
  it("emits an unresolved marker when a record has openlrBinary but no coordinate", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<messageContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="3">
  <payload xsi:type="SituationPublication">
    <situation id="S_OLR">
      <situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" id="R_OLR" version="1">
        <situationRecordVersionTime>2024-01-01T00:00:00Z</situationRecordVersionTime>
        <validity><validityStatus>active</validityStatus></validity>
        <locationReference xsi:type="OpenlrPointAlongLine">
          <openlrBinary>ABcDefGHiJkL==</openlrBinary>
        </locationReference>
      </situationRecord>
    </situation>
  </payload>
</messageContainer>`;

    const events = parseDatexSituations(xml, NDW_SOURCE);
    expect(events).toHaveLength(1);
    expect(events[0]!.externalRefs?.openlr).toBe("ABcDefGHiJkL==");
    expect(events[0]!.geometry).toBeUndefined();
  });

  it("does NOT emit an unresolved marker when a record has neither coordinates nor openlrBinary", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<messageContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="3">
  <payload xsi:type="SituationPublication">
    <situation id="S_NONE">
      <situationRecord xsi:type="Accident" id="R_NONE" version="1">
        <situationRecordVersionTime>2024-01-01T00:00:00Z</situationRecordVersionTime>
        <validity><validityStatus>active</validityStatus></validity>
        <locationReference xsi:type="AlertCPoint">
          <alertCPoint><alertCLocationCountryCode>8</alertCLocationCountryCode></alertCPoint>
        </locationReference>
      </situationRecord>
    </situation>
  </payload>
</messageContainer>`;

    const events = parseDatexSituations(xml, NDW_SOURCE);
    expect(events).toHaveLength(0);
  });

  it("does NOT regress coordinate-bearing records — they still get geometry", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<messageContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="3">
  <payload xsi:type="SituationPublication">
    <situation id="S_COORD">
      <situationRecord xsi:type="Accident" id="R_COORD" version="1">
        <situationRecordVersionTime>2024-01-01T00:00:00Z</situationRecordVersionTime>
        <validity><validityStatus>active</validityStatus></validity>
        <locationReference xsi:type="PointLocation">
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>52.0</latitude>
              <longitude>4.5</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </locationReference>
      </situationRecord>
    </situation>
  </payload>
</messageContainer>`;

    const events = parseDatexSituations(xml, NDW_SOURCE);
    expect(events).toHaveLength(1);
    expect(events[0]!.geometry).toBeDefined();
    expect(events[0]!.geometry?.type).toBe("Point");
    expect(events[0]!.externalRefs?.openlr).toBeUndefined();
  });
});
