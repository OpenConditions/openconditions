import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  datexPublications,
  parseDatexEnergyStatus,
  parseDatexEnergyTable,
  parseXmlDocument,
} from "../index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseDatexEnergyTable", () => {
  test("DGT's table decodes sites, stations, refill points and connectors in watts", () => {
    const sites = parseDatexEnergyTable(parseXmlDocument(fixture("es-dgt-energy.xml")));
    expect(sites.map((s) => s.id)).toEqual([
      "9TOKBPBKRBJVLI0RR4XG",
      "IXBKAMF4GUCULLK2GRK4",
      "LUYQXKE5OUXG1ZADLPMV",
    ]);
    const callao = sites[0]!;
    expect(callao).toMatchObject({
      id: "9TOKBPBKRBJVLI0RR4XG",
      names: [{ lang: "es", value: "Carrer_del_Callao" }],
      point: [2.670856, 39.564915],
      address: { street: "Carrer Del Callao, S/N", postalCode: "7006", city: "Palma" },
      operator: { id: "ES*EMA", name: "EMAYA, S.A." },
      siteType: "siteType:onstreet",
      lastUpdated: "2026-07-15T13:48:52.000+02:00",
    });
    expect(callao.version).toBeUndefined();
    expect(callao.stations).toHaveLength(1);
    const station = callao.stations[0]!;
    expect(station.id).toBe("9TOKBPBKRBJVLI0RR4XG_1");
    expect(station.authMethods).toEqual(["debitCard", "creditCard", "apps"]);
    expect(station.points).toHaveLength(1);
    expect(station.points[0]).toMatchObject({
      id: "0T6GSUNCAEWDLSXMVATHV1QTOOJ",
      emi3: "ES*EMA*EMELIBMALLO531",
      connectors: [
        {
          type: "iec62196T2",
          format: "socket",
          chargingMode: "mode3AC3p",
          maxPowerW: 22170,
          voltage: 400,
          maxCurrentA: 32,
        },
        { type: "iec62196T2", maxPowerW: 22170 },
      ],
      rates: [],
    });
    expect(callao.stations.flatMap((s) => s.points).length).toBeGreaterThan(0);
    expect(sites[2]!.stations[0]!.points.length).toBeGreaterThan(1);
  });

  test("a root EnergyInfrastructureTablePublication (Slovenia) is found", () => {
    const doc = parseXmlDocument(fixture("si-nap-energy.xml"));
    expect(datexPublications(doc)).toEqual([
      expect.objectContaining({
        version: 3,
        type: "EnergyInfrastructureTablePublication",
        publicationTime: "2025-12-04T15:12:33.7057479Z",
      }),
    ]);
    const sites = parseDatexEnergyTable(doc);
    expect(sites.map((s) => s.id)).toEqual([
      "246ea408-3f25-4378-95a5-b9829851edc2",
      expect.any(String),
      "SI*EVT*P326P",
    ]);
    expect(sites[0]).toMatchObject({
      version: "v1",
      names: [{ lang: "sl", value: "BS AC ČATEŽ - JUG" }],
      point: [15.59736, 45.89166],
      address: { street: "RIMSKA CESTA 11", postalCode: "8250", city: "BREŽICE", country: "SI" },
      operator: { id: "SI*PET", name: "PETROL, d.d", legalName: "PETROL, d.d" },
    });
    const first = sites[0]!.stations[0]!;
    expect(first.id).toBe("50349049-59d3-41ff-80a5-ae5e556c2142");
    expect(first.authMethods).toEqual(["rfid"]);
    expect(first.points[0]).toMatchObject({
      id: "SIPETE0166*02*1",
      emi3: "SIPETE0166*02*1",
      connectors: [
        { type: "chademo", format: "otherCable", maxPowerW: 50000, voltage: 400, maxCurrentA: 125 },
      ],
    });
  });

  test("Slovenia's RateTable becomes rate lines with currency and policy", () => {
    const sites = parseDatexEnergyTable(parseXmlDocument(fixture("si-nap-energy.xml")));
    const points = sites.flatMap((s) => s.stations.flatMap((st) => st.points));
    const priced = points.filter((p) => p.rates.length > 0);
    expect(priced.length).toBeGreaterThan(0);
    const point = points.find((p) => p.id === "SI*GNE*E1297")!;
    expect(point.externalId).toBe("1297");
    expect(point.emi3).toBe("SI*GNE*E1297");
    expect(point.rates).toEqual([
      {
        id: "ea9984e6-8786-4c9e-913b-aebe4c167073-rp-c",
        currency: "EUR",
        pricingPolicy: "pricePerDeliveryUnit",
        lines: [{ type: "perUnit", value: 0.35, description: "Cena na kWh" }],
      },
    ]);
  });

  test("an operating-hours 24/7 site and a weekly period decode", () => {
    const es = parseDatexEnergyTable(parseXmlDocument(fixture("es-dgt-energy.xml")));
    expect(es[0]!.openingHours).toEqual({ twentyFourSeven: true, periods: [] });
    // A free-text timetable, one period per distinct pair of hours.
    expect(es[1]!.openingHours).toEqual({
      twentyFourSeven: false,
      periods: [
        {
          days: ["saturday", "friday", "thursday", "wednesday", "tuesday", "monday"],
          from: "09:00",
          to: "21:30",
        },
      ],
    });

    const si = parseDatexEnergyTable(parseXmlDocument(fixture("si-nap-energy.xml")));
    // Seven whole-day periods are open all week.
    expect(si[0]!.openingHours?.twentyFourSeven).toBe(true);
    expect(si[0]!.openingHours?.periods).toHaveLength(7);
    expect(si[0]!.openingHours?.periods[0]).toEqual({
      days: ["monday"],
      from: "00:00",
      to: "23:59",
    });
    // No periods and no label is no opening hours.
    expect(si[2]!.openingHours).toBeUndefined();
  });

  test("a weekly period with hours that are not the whole day is not 24/7", () => {
    const xml = `<EnergyInfrastructureTablePublication xmlns="http://datex2.eu/schema/3/energyInfrastructure"
        xmlns:fac="http://datex2.eu/schema/3/facilities" xmlns:com="http://datex2.eu/schema/3/common">
      <energyInfrastructureTable id="t" version="1">
        <energyInfrastructureSite id="s" version="1">
          <fac:operatingHours id="h">
            <fac:overallPeriod>
              <com:validPeriod>
                <com:recurringTimePeriodOfDay>
                  <com:startTimeOfPeriod>08:00:00+02:00</com:startTimeOfPeriod>
                  <com:endTimeOfPeriod>18:30:00+02:00</com:endTimeOfPeriod>
                </com:recurringTimePeriodOfDay>
                <com:recurringDayWeekMonthPeriod>
                  <com:applicableDay>monday</com:applicableDay>
                  <com:applicableDay>tuesday</com:applicableDay>
                </com:recurringDayWeekMonthPeriod>
              </com:validPeriod>
            </fac:overallPeriod>
          </fac:operatingHours>
        </energyInfrastructureSite>
      </energyInfrastructureTable>
    </EnergyInfrastructureTablePublication>`;
    const [site] = parseDatexEnergyTable(parseXmlDocument(xml));
    expect(site!.openingHours).toEqual({
      twentyFourSeven: false,
      periods: [{ days: ["monday", "tuesday"], from: "08:00", to: "18:30" }],
    });
  });

  test("only electric charging points are read, and a point id that is no eMI3 id has no emi3", () => {
    const xml = `<EnergyInfrastructureTablePublication xmlns="http://datex2.eu/schema/3/energyInfrastructure"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xmlns:fac="http://datex2.eu/schema/3/facilities" xmlns:com="http://datex2.eu/schema/3/common">
      <energyInfrastructureTable id="t" version="1">
        <energyInfrastructureSite id="s" version="1">
          <energyInfrastructureStation id="st">
            <refillPoint xsi:type="HydrogenRefillPoint" id="h1"/>
            <refillPoint xsi:type="ElectricChargingPoint" id="p1">
              <fac:name><com:values><com:value lang="en">Bay 1</com:value></com:values></fac:name>
              <fac:externalIdentifier>DE*ABC*E123</fac:externalIdentifier>
              <connector><connectorType>iec62196T2</connectorType><voltage>0.0</voltage><maximumCurrent>0.0</maximumCurrent></connector>
            </refillPoint>
          </energyInfrastructureStation>
        </energyInfrastructureSite>
      </energyInfrastructureTable>
    </EnergyInfrastructureTablePublication>`;
    const [site] = parseDatexEnergyTable(parseXmlDocument(xml));
    const points = site!.stations[0]!.points;
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({
      id: "p1",
      externalId: "DE*ABC*E123",
      emi3: "DE*ABC*E123",
      connectors: [{ type: "iec62196T2" }],
      rates: [],
    });
  });

  test("a document with no energy table has no sites", () => {
    expect(parseDatexEnergyTable(parseXmlDocument(fixture("ndw-truck-table.xml")))).toEqual([]);
  });
});

describe("parseDatexEnergyStatus", () => {
  test("Lithuania's status publication yields refill point statuses with times", () => {
    const doc = parseXmlDocument(fixture("lt-energy-status.xml"));
    expect(datexPublications(doc)[0]).toMatchObject({
      version: 3,
      type: "EnergyInfrastructureStatusPublication",
      publicationTime: "2026-10-06T05:01:29+03:00",
    });
    const statuses = parseDatexEnergyStatus(doc);
    expect(statuses).toHaveLength(17);
    expect(statuses[0]).toEqual({
      refillPointId: "0",
      siteId: "EGI-S-257",
      stationId: "EGI-ST-257",
      connectorIndex: "1",
      at: "2025-11-21T13:00:10+02:00",
      status: "removed",
    });
    expect(statuses[1]).toMatchObject({ refillPointId: "1", status: "outOfOrder" });
    const charging = statuses.filter((s) => s.siteId === "EGI-S-375");
    expect(charging.map((s) => s.status)).toEqual([
      "available",
      "charging",
      "available",
      "available",
    ]);
    expect(charging[1]).toMatchObject({ at: "2026-08-31T13:15:38+03:00", connectorIndex: "2" });
    expect(new Set(statuses.map((s) => s.status))).toEqual(
      new Set(["removed", "outOfOrder", "available", "charging", "inoperative", "unknown"]),
    );
  });

  test("a v3.7 status reads its reference and its own time", () => {
    const xml = `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xmlns:egi="http://datex2.eu/schema/3/energyInfrastructure"
        xmlns:fac="http://datex2.eu/schema/3/facilities"
        xsi:type="egi:EnergyInfrastructureStatusPublication">
      <egi:energyInfrastructureSiteStatus>
        <fac:reference targetClass="egi:EnergyInfrastructureSite" id="site-1" version="1"/>
        <fac:lastUpdated>2026-10-06T10:00:00Z</fac:lastUpdated>
        <egi:energyInfrastructureStationStatus>
          <fac:reference targetClass="egi:EnergyInfrastructureStation" id="station-1" version="1"/>
          <egi:refillPointStatus>
            <fac:reference targetClass="egi:ElectricChargingPoint" id="point-1" version="1"/>
            <fac:lastUpdated>2026-10-06T10:05:00Z</fac:lastUpdated>
            <egi:status>occupied</egi:status>
          </egi:refillPointStatus>
          <egi:refillPointStatus>
            <fac:reference targetClass="egi:ElectricChargingPoint" id="point-2" version="1"/>
            <egi:status>outOfOrder</egi:status>
          </egi:refillPointStatus>
        </egi:energyInfrastructureStationStatus>
      </egi:energyInfrastructureSiteStatus>
    </d2:payload>`;
    expect(parseDatexEnergyStatus(parseXmlDocument(xml))).toEqual([
      {
        refillPointId: "point-1",
        siteId: "site-1",
        stationId: "station-1",
        at: "2026-10-06T10:05:00Z",
        status: "occupied",
      },
      {
        refillPointId: "point-2",
        siteId: "site-1",
        stationId: "station-1",
        at: "2026-10-06T10:00:00Z",
        status: "outOfOrder",
      },
    ]);
  });

  test("a table publication has no statuses", () => {
    expect(parseDatexEnergyStatus(parseXmlDocument(fixture("es-dgt-energy.xml")))).toEqual([]);
  });
});
