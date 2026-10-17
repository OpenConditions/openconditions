import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import {
  parseDatexCameraDevices,
  parseDatexEnergyStatus,
  parseDatexEnergyTable,
  parseDatexParkingStatus,
  parseDatexParkingTable,
  parseXmlDocument,
} from "../index.js";

const FEED = "test-datex";
const options = { sourceId: FEED };
const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

const payload = (type: string, body: string) =>
  parseXmlDocument(
    `<payload xmlns="http://datex2.eu/schema/3/d2Payload" ${XSI} xsi:type="${type}" lang="en" modelBaseVersion="3"><publicationTime>2026-10-17T00:00:00Z</publicationTime>${body}</payload>`,
  );

beforeEach(() => __resetSkips());

describe("what the decoders cannot read is counted under the feed", () => {
  test("energy table: a site, station, point or connector without identity or type, a rate without its currency", () => {
    const point = (id: string, inner: string) =>
      `<refillPoint xsi:type="ElectricChargingPoint"${id}>${inner}</refillPoint>`;
    const sites = parseDatexEnergyTable(
      payload(
        "EnergyInfrastructureTablePublication",
        `<energyInfrastructureTable id="t" version="1">
          <energyInfrastructureSite version="1"/>
          <energyInfrastructureSite id="s" version="1">
            <energyInfrastructureStation version="1"/>
            <energyInfrastructureStation id="st" version="1">
              ${point("", "")}
              ${point(
                ' id="p"',
                `<connector><maxPowerAtSocket>11000</maxPowerAtSocket></connector>
                 <connector><connectorType>iec62196T2</connectorType></connector>
                 <rates xsi:type="RateTable"><rateLineCollection><rateLine><rateLineType>flatRate</rateLineType><value>1</value></rateLine></rateLineCollection></rates>
                 <energyProduct><energyRate><ratePolicy>adHoc</ratePolicy><applicableCurrency>EUR</applicableCurrency><energyPrice><priceGroupIndex>0</priceGroupIndex><priceType>pricePerKWh</priceType></energyPrice></energyRate></energyProduct>`,
              )}
              ${point(' id="q"', "")}
            </energyInfrastructureStation>
          </energyInfrastructureSite>
        </energyInfrastructureTable>`,
      ),
      options,
    );
    const points = sites.flatMap((s) => s.stations.flatMap((st) => st.points));
    expect(points.map((p) => [p.id, p.connectors.length, p.rates.length])).toEqual([
      ["p", 1, 0],
      ["q", 0, 0],
    ]);
    // Site, station, point and connector, and both rates.
    expect(drainSkipped(FEED)).toEqual({ malformed: 6 });
  });

  test("energy status: a status naming no refill point or no status", () => {
    const statuses = parseDatexEnergyStatus(
      payload(
        "EnergyInfrastructureStatusPublication",
        `<energyInfrastructureSiteStatus><reference id="s" version="1"/>
          <energyInfrastructureStationStatus><reference id="st" version="1"/>
            <refillPointStatus><reference id="p" version="1"/><status>available</status></refillPointStatus>
            <refillPointStatus><status>available</status></refillPointStatus>
            <refillPointStatus><reference id="q" version="1"/></refillPointStatus>
          </energyInfrastructureStationStatus>
        </energyInfrastructureSiteStatus>`,
      ),
      options,
    );
    expect(statuses.map((s) => s.refillPointId)).toEqual(["p"]);
    expect(drainSkipped(FEED)).toEqual({ malformed: 2 });
  });

  test("parking: a v3.7 facility hierarchy is an unsupported version, a record without id malformed", () => {
    const records = parseDatexParkingTable(
      payload(
        "ParkingTablePublication",
        `<parkingTable id="t" version="1"><versionTime>2026-10-17T00:00:00Z</versionTime>
          <hierarchyElementGeneral xsi:type="Place" id="a" version="1"/>
          <hierarchyElementGeneral xsi:type="Place" id="b" version="1"/>
          <parkingRecord xsi:type="UrbanParkingSite" version="1"/>
          <parkingRecord xsi:type="UrbanParkingSite" id="r" version="1"/>
        </parkingTable>`,
      ),
      options,
    );
    expect(records.map((r) => r.id)).toEqual(["r"]);
    expect(drainSkipped(FEED)).toEqual({ unsupported_version: 2, malformed: 1 });
  });

  test("parking: a group's embedded sites are records of their own", () => {
    const records = parseDatexParkingTable(
      parseXmlDocument(
        `<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" ${XSI} modelBaseVersion="2"><payloadPublication xsi:type="ParkingTablePublication" lang="en"><publicationTime>2026-10-17T00:00:00Z</publicationTime><parkingTable id="t" version="1"><parkingRecord xsi:type="GroupOfParkingSites" id="g" version="1"><parkingSite xsi:type="UrbanParkingSite" id="g1" version="1"/></parkingRecord></parkingTable></payloadPublication></d2LogicalModel>`,
      ),
      options,
    );
    expect(records.map((r) => [r.id, r.type])).toEqual([
      ["g", "GroupOfParkingSites"],
      ["g1", "UrbanParkingSite"],
    ]);
    expect(drainSkipped(FEED)).toEqual({});
  });

  test("parking status: a status naming no record", () => {
    const statuses = parseDatexParkingStatus(
      payload(
        "ParkingStatusPublication",
        `<parkingRecordStatus xsi:type="ParkingSiteStatus"><parkingStatusOriginTime>2026-10-17T00:00:00Z</parkingStatusOriginTime></parkingRecordStatus>
         <parkingStatusInformation xsi:type="PlaceStatus"><status>full</status></parkingStatusInformation>
         <parkingStatusInformation xsi:type="PlaceStatus"><reference id="r" version="1"/><status>full</status></parkingStatusInformation>`,
      ),
      options,
    );
    expect(statuses.map((s) => s.recordId)).toEqual(["r"]);
    expect(drainSkipped(FEED)).toEqual({ malformed: 2 });
  });

  test("devices: a camera without id is malformed; another device is left out", () => {
    const devices = parseDatexCameraDevices(
      payload(
        "DevicePublication",
        `<device><typeOfDevice>camera</typeOfDevice></device>
         <device id="v" version="1"><typeOfDevice>vms</typeOfDevice></device>
         <device id="c" version="1"><typeOfDevice>camera</typeOfDevice></device>`,
      ),
      options,
    );
    expect(devices.map((d) => d.id)).toEqual(["c"]);
    expect(drainSkipped(FEED)).toEqual({ malformed: 1 });
  });

  test("without a feed nothing is counted", () => {
    parseDatexCameraDevices(
      payload("DevicePublication", "<device><typeOfDevice>camera</typeOfDevice></device>"),
    );
    expect(drainSkipped(FEED)).toEqual({});
  });
});
