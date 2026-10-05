import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseDatexParkingStatus, parseDatexParkingTable, parseXmlDocument } from "../index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseDatexParkingTable", () => {
  test("a v2 parking table yields records with groups, facilities and tariffs", () => {
    const records = parseDatexParkingTable(parseXmlDocument(fixture("ndw-truck-table.xml")));
    expect(records.map((r) => r.id)).toEqual(["NL-12_421", "NL-12_8"]);
    const venlo = records[0]!;
    expect(venlo.groups.length).toBeGreaterThan(0);
    expect(venlo.point).toBeDefined();
    expect(venlo).toMatchObject({
      id: "NL-12_421",
      version: "2",
      type: "InterUrbanParkingSite",
      names: [{ lang: "nl", value: "Truckstop Venlo" }],
      point: [6.108905, 51.39038],
      address: "James Cookweg 31, 5928LJ Venlo",
      usage: ["usageScenario:truckParking"],
      layoutCodes: ["interUrbanParkingSiteLocation:motorway"],
      security: ["cctv", "fences", "lighting", "guard24hours"],
      supervision: "patrol",
      labelSecurityLevel: "securityLevel3",
      freeOfCharge: false,
      tariffs: [{ currency: "EUR", amount: 1, intervalSec: 3600, name: "Tarief per uur" }],
    });
    expect(venlo.operator).toBeUndefined();
    expect(venlo.totalSpaces).toBeUndefined();
    expect(venlo.groups).toEqual([
      { index: "0", vehicleTypes: ["lorry"], userGroups: [], characterised: true, spaces: 390 },
      // Reefer bays: vehicles characterised by their load, of no vehicle type.
      { index: "1", vehicleTypes: [], userGroups: [], characterised: true, spaces: 12 },
      {
        index: "2",
        vehicleTypes: ["heavyHaulageVehicle"],
        userGroups: [],
        characterised: true,
        spaces: 0,
      },
    ]);
    expect(venlo.facilities).toEqual([
      "equipmentType:electricChargingStation",
      "serviceFacilityType:restaurant",
      "equipmentType:freshWater",
      "equipmentType:wasteDisposal",
      "equipmentType:internetWireless",
      "equipmentType:toilet",
      "equipmentType:shower",
    ]);
    expect(records[1]!.tariffs).toEqual([]);
    expect(records[1]!.freeOfCharge).toBeUndefined();
  });

  test("CITA's v2 static file decodes", () => {
    const records = parseDatexParkingTable(parseXmlDocument(fixture("cita-static.xml")));
    expect(records.map((r) => r.id)).toEqual([
      "G-MB-B",
      "B-MB-G",
      "C-WC-W",
      "W-WC-C",
      "N-TW-W",
      "W-TW-N",
    ]);
    expect(records.every((r) => r.point !== undefined && r.freeOfCharge === true)).toBe(true);
    const berchem = records[0]!;
    expect(berchem).toMatchObject({
      names: [{ lang: "fr", value: "Aire de Berchem direction France" }],
      point: [6.1201115, 49.543915],
      operator: "Administration des Ponts et Chaussées",
      address: "Along the motorway",
      usage: ["usageScenario:truckParking", "usageScenario:restArea", "usageScenario:serviceArea"],
      security: ["areaSeperatedFromSurroundings", "lighting", "fences"],
      labelSecurityLevel: "unknown",
    });
    // A charging point the publisher marks unavailable is not offered.
    expect(berchem.facilities).toEqual([
      "equipmentType:toilet",
      "serviceFacilityType:petrolStation",
    ]);
    expect(berchem.groups).toEqual([
      { index: "0", vehicleTypes: ["lorry"], userGroups: [], characterised: true, spaces: 106 },
      { index: "1", vehicleTypes: [], userGroups: [], characterised: true, spaces: 0 },
    ]);
  });

  test("a v3 table's charge bands decode with their intervals", () => {
    const xml = `<?xml version="1.0"?>
      <d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:par="http://datex2.eu/schema/3/parking"
          xmlns:fac="http://datex2.eu/schema/3/facilities" xmlns:com="http://datex2.eu/schema/3/common"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="par:ParkingTablePublication">
        <com:publicationTime>2026-10-01T00:00:00Z</com:publicationTime>
        <par:parkingTable id="T" version="1">
          <par:parkingRecord xsi:type="par:UrbanParkingSite" id="P1" version="1">
            <fac:tariffsAndPayment>
              <fac:chargeBand id="B" version="1">
                <fac:chargeBandName><com:values><com:value lang="nl">Tarief per half uur</com:value></com:values></fac:chargeBandName>
                <fac:chargeCurrency>eur</fac:chargeCurrency>
                <fac:charge><fac:charge>2.50</fac:charge><fac:chargeInterval>1800</fac:chargeInterval></fac:charge>
                <fac:charge><fac:charge>20.00</fac:charge></fac:charge>
              </fac:chargeBand>
            </fac:tariffsAndPayment>
          </par:parkingRecord>
        </par:parkingTable>
      </d2:payload>`;
    const [record] = parseDatexParkingTable(parseXmlDocument(xml));
    expect(record!.tariffs).toEqual([
      { currency: "EUR", amount: 2.5, intervalSec: 1800, name: "Tarief per half uur" },
      { currency: "EUR", amount: 20, name: "Tarief per half uur" },
    ]);
  });

  test("a record at 0,0 has no point", () => {
    const xml = `<d2LogicalModel><payloadPublication><parkingTable>
      <parkingRecord id="Z"><parkingLocation><pointByCoordinates><pointCoordinates>
        <latitude>0</latitude><longitude>0</longitude>
      </pointCoordinates></pointByCoordinates></parkingLocation></parkingRecord>
    </parkingTable></payloadPublication></d2LogicalModel>`;
    const [record] = parseDatexParkingTable(parseXmlDocument(xml));
    expect(record!.id).toBe("Z");
    expect(record!.point).toBeUndefined();
  });

  test("a v3 table with prefixed elements decodes like v2", () => {
    const xml = `<?xml version="1.0"?>
      <d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:par="http://datex2.eu/schema/3/parking"
          xmlns:com="http://datex2.eu/schema/3/common" xmlns:loc="http://datex2.eu/schema/3/locationReferencing"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="par:ParkingTablePublication">
        <com:publicationTime>2026-10-01T00:00:00Z</com:publicationTime>
        <par:parkingTable id="T" version="1">
          <par:parkingRecord xsi:type="par:UrbanParkingSite" id="P1" version="4">
            <par:parkingName><com:values><com:value lang="de">Parkhaus Mitte</com:value></com:values></par:parkingName>
            <par:parkingNumberOfSpaces>500</par:parkingNumberOfSpaces>
            <par:parkingLocation xsi:type="loc:PointLocation">
              <loc:pointByCoordinates><loc:pointCoordinates>
                <loc:latitude>49.0</loc:latitude><loc:longitude>8.4</loc:longitude>
              </loc:pointCoordinates></loc:pointByCoordinates>
            </par:parkingLocation>
            <par:groupOfParkingSpaces groupIndex="7">
              <par:parkingSpaceBasics xsi:type="par:GroupOfParkingSpaces">
                <par:onlyAssignedParking>
                  <par:applicableForUser>disabled</par:applicableForUser>
                  <par:vehicleCharacteristics><com:vehicleType>car</com:vehicleType></par:vehicleCharacteristics>
                </par:onlyAssignedParking>
                <par:parkingNumberOfSpaces>12</par:parkingNumberOfSpaces>
              </par:parkingSpaceBasics>
            </par:groupOfParkingSpaces>
            <par:parkingLayout>multiStorey</par:parkingLayout>
            <par:urbanParkingSiteType>offStreetParking</par:urbanParkingSiteType>
          </par:parkingRecord>
        </par:parkingTable>
      </d2:payload>`;
    expect(parseDatexParkingTable(parseXmlDocument(xml))).toEqual([
      expect.objectContaining({
        id: "P1",
        version: "4",
        type: "UrbanParkingSite",
        names: [{ lang: "de", value: "Parkhaus Mitte" }],
        point: [8.4, 49],
        totalSpaces: 500,
        layoutCodes: ["parkingLayout:multiStorey", "urbanParkingSiteType:offStreetParking"],
        groups: [
          {
            index: "7",
            vehicleTypes: ["car"],
            userGroups: ["disabled"],
            characterised: true,
            spaces: 12,
          },
        ],
      }),
    ]);
  });

  test("a status publication has no table records", () => {
    expect(parseDatexParkingTable(parseXmlDocument(fixture("ndw-truck-status.xml")))).toEqual([]);
  });
});

describe("parseDatexParkingStatus", () => {
  test("a v3 status yields site and per-group counts with prefixed status codes", () => {
    const statuses = parseDatexParkingStatus(parseXmlDocument(fixture("ndw-truck-status.xml")));
    expect(statuses.map((s) => s.recordId)).toEqual(["NL-12_421", "NL-12_8"]);
    const [s] = statuses;
    expect(s!.statusCodes).toContain("parkingSiteStatus:spacesAvailable");
    expect(s).toMatchObject({
      at: "2026-09-22T11:06:57.472809998Z",
      vacant: 1746,
      occupied: 0,
      occupancyPct: 14.571428,
      statusCodes: ["parkingSiteStatus:spacesAvailable"],
    });
    expect(s!.trendCode).toBeUndefined();
    expect(s!.groups.map((g) => g.index)).toEqual(["1", "2", "3", "4", "5", "8", "1000"]);
    expect(s!.groups[0]).toEqual({ index: "1", vacant: 291, occupied: 0, occupancyPct: 17 });
  });

  test("a negative count is no count", () => {
    const [, asten] = parseDatexParkingStatus(parseXmlDocument(fixture("ndw-truck-status.xml")));
    expect(asten).toMatchObject({ recordId: "NL-12_8", vacant: 1601 });
    expect(asten!.occupied).toBeUndefined();
    expect(asten!.occupancyPct).toBeUndefined();
    expect(asten!.groups).toEqual([
      { index: "3", vacant: 217, occupied: 23, occupancyPct: 10 },
      { index: "4", vacant: 1384 },
    ]);
  });

  test("CITA's v2 dynamic file decodes with vacant spaces, status and trend", () => {
    const statuses = parseDatexParkingStatus(parseXmlDocument(fixture("cita-dynamic.xml")));
    expect(statuses).toEqual([
      {
        recordId: "G-MB-B",
        at: "2026-10-05T04:40:00+02:00",
        vacant: 3,
        occupied: 38,
        occupancyPct: 92,
        statusCodes: ["parkingSiteStatus:full"],
        trendCode: "parkingOccupancyTrend:stable",
        groups: [],
      },
      expect.objectContaining({
        recordId: "B-MB-G",
        vacant: 18,
        statusCodes: ["parkingSiteStatus:spacesAvailable"],
      }),
    ]);
    const records = parseDatexParkingTable(parseXmlDocument(fixture("cita-static.xml")));
    const ids = new Set(records.map((r) => r.id));
    expect(statuses.every((s) => ids.has(s.recordId) && s.vacant !== undefined)).toBe(true);
  });

  test("v2 opening, overcrowding and graded statuses keep their enumeration prefix", () => {
    const xml = `<d2LogicalModel><payloadPublication xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ParkingStatusPublication">
      <parkingRecordStatus xsi:type="ParkingSiteStatus">
        <parkingRecordReference id="A"/>
        <parkingOccupancy><parkingNumberOfVacantSpacesGraded>lessThan10SpacesAvailable</parkingNumberOfVacantSpacesGraded></parkingOccupancy>
        <parkingSiteOpeningStatus>open</parkingSiteOpeningStatus>
        <parkingSiteOvercrowdingStatus>noOvercrowding</parkingSiteOvercrowdingStatus>
      </parkingRecordStatus>
    </payloadPublication></d2LogicalModel>`;
    expect(parseDatexParkingStatus(parseXmlDocument(xml))[0]!.statusCodes).toEqual([
      "openingStatus:open",
      "overcrowdingStatus:noOvercrowding",
      "vacantSpaces:lessThan10SpacesAvailable",
    ]);
  });

  test("v3.7 status information merges per facility into the v3 status codes", () => {
    const xml = `<?xml version="1.0"?>
      <d2:payload xmlns:d2="d" xmlns:prk="p" xmlns:fac="f" xmlns:com="c"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="prk:ParkingStatusPublication">
        <prk:parkingStatusInformation xsi:type="prk:PlaceStatus">
          <fac:reference id="S1"/>
          <fac:lastUpdated>2026-10-01T08:00:00Z</fac:lastUpdated>
          <fac:openingStatus>open</fac:openingStatus>
          <prk:occupancy>
            <prk:numberOfVacantSpaces>40</prk:numberOfVacantSpaces>
            <prk:numberOfOccupiedSpaces>60</prk:numberOfOccupiedSpaces>
            <prk:occupancy>60</prk:occupancy>
            <prk:occupancyTrend>increasing</prk:occupancyTrend>
          </prk:occupancy>
          <prk:operatingPatternStatus><prk:operationStatus>inOperation</prk:operationStatus></prk:operatingPatternStatus>
          <prk:status>spacesAvailable</prk:status>
        </prk:parkingStatusInformation>
      </d2:payload>`;
    expect(parseDatexParkingStatus(parseXmlDocument(xml))).toEqual([
      {
        recordId: "S1",
        at: "2026-10-01T08:00:00Z",
        vacant: 40,
        occupied: 60,
        occupancyPct: 60,
        statusCodes: [
          "openingStatus:open",
          "operationStatus:inOperation",
          "placeStatus:spacesAvailable",
        ],
        trendCode: "parkingOccupancyTrend:increasing",
        groups: [],
      },
    ]);
  });
});
