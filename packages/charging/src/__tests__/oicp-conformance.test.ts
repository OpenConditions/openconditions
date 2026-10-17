import {
  assertCovered,
  type CoverageSpec,
  jsonSchemaEnums,
  parseYaml,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { OICP_2_3 } from "@openconditions/conformance/standards/oicp";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * Hubject OICP 2.3, held to the EMP OpenAPI description: every value of
 * every enumeration an EVSE data or status record uses is read into the
 * model as the specification describes it, by parsing a record carrying it,
 * or is listed with the reason it is not; and every field of a pulled EVSE
 * data record is read or listed as unread.
 */

type Json = Record<string, unknown>;

const FEED_ID = "ch-bfe-charging";
const FETCHED = "2026-10-17T08:00:00Z";
const SCHEMAS = "#/components/schemas";

/** OICP 2.3's own example record (the EMP code snippets), with every optional field set. */
const record = (over: Json = {}): Json => ({
  EvseID: "DE*ABC*E1234567",
  ChargingPoolID: "DE*ABC*P1234",
  ChargingStationNames: [{ lang: "en", value: "ABC Charging Station Test" }],
  Address: {
    Country: "DEU",
    City: "Berlin",
    Street: "Test Street",
    PostalCode: "10829",
    HouseNum: "22",
  },
  GeoCoordinates: { Google: { Coordinates: "52.480495 13.356465" } },
  Plugs: ["Type 2 Outlet"],
  ChargingFacilities: [{ PowerType: "AC_3_PHASE", Power: 22, Voltage: 230, Amperage: 32 }],
  RenewableEnergy: false,
  CalibrationLawDataAvailability: "Not Available",
  AuthenticationModes: ["NFC RFID Classic"],
  PaymentOptions: ["Contract"],
  ValueAddedServices: ["None"],
  Accessibility: "Free publicly accessible",
  HotlinePhoneNumber: "+49123123123123",
  IsOpen24Hours: true,
  IsHubjectCompatible: true,
  DynamicInfoAvailable: "true",
  OperatorID: "DE*ABC",
  OperatorName: "ABC technologies",
  ...over,
});

/** A pulled OICP 2.3 page of records. */
const page = (records: Json[]) =>
  Buffer.from(
    JSON.stringify({
      content: records,
      number: 0,
      size: records.length,
      totalElements: records.length,
      last: true,
      totalPages: 1,
      first: true,
      numberOfElements: records.length,
      StatusCode: { Code: "000" },
    }),
  );

function parse(payloads: FeedPayloads): ParseOutput {
  const out = chargingDomain.formats["oicp"]!.parse(
    catalogFeed(FEED_ID),
    payloads,
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}
const one = (over: Json = {}) => parse({ main: [page([record(over)])] });

type Component = { key: string; kind: string; details: Json } & Json;
const site = (out: ParseOutput) => out.features[0] as RecordDraft | undefined;
const details = (out: ParseOutput) => (site(out)?.["details"] ?? {}) as Json;
const access = (out: ParseOutput) => (site(out)?.["access"] ?? {}) as Json;
const components = (out: ParseOutput) => (site(out)?.["components"] ?? []) as Component[];
const evse = (out: ParseOutput) => components(out).find((c) => c.kind === "evse");
const connector = (out: ParseOutput) => components(out).find((c) => c.kind === "connector");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Whether parsing left nothing unread. */
const noneUnread = () => drainSkipped(FEED_ID)["unknown_value"] === undefined;

/** What each plug is, by the specification's description, as an OCPI standard and format. */
const PLUGS: Readonly<Record<string, [string, string?]>> = {
  // Inductive paddles, AVCON's conductive connector and Tesla's own connector
  // (Type 2 or CCS2 in Europe) have no OCPI standard.
  "Small Paddle Inductive": ["UNKNOWN"],
  "Large Paddle Inductive": ["UNKNOWN"],
  "AVCON Connector": ["UNKNOWN"],
  "Tesla Connector": ["UNKNOWN"],
  "NEMA 5-20": ["NEMA_5_20", "socket"],
  "Type E French Standard": ["DOMESTIC_E", "socket"],
  "Type F Schuko": ["DOMESTIC_F", "socket"],
  "Type G British Standard": ["DOMESTIC_G", "socket"],
  "Type J Swiss Standard": ["DOMESTIC_J", "socket"],
  "Type 1 Connector (Cable Attached)": ["IEC_62196_T1", "cable"],
  "Type 2 Outlet": ["IEC_62196_T2", "socket"],
  "Type 2 Connector (Cable Attached)": ["IEC_62196_T2", "cable"],
  "Type 3 Outlet": ["IEC_62196_T3C", "socket"],
  "IEC 60309 Single Phase": ["IEC_60309_2_single_16", "socket"],
  // The base record's facility is 32 A.
  "IEC 60309 Three Phase": ["IEC_60309_2_three_32", "socket"],
  "CCS Combo 2 Plug (Cable Attached)": ["IEC_62196_T2_COMBO", "cable"],
  "CCS Combo 1 Plug (Cable Attached)": ["IEC_62196_T1_COMBO", "cable"],
  CHAdeMO: ["CHADEMO", "cable"],
};

const AUTHENTICATION: Readonly<Record<string, string>> = {
  "NFC RFID Classic": "rfid",
  "NFC RFID DESFire": "rfid",
  PnC: "plug_and_charge",
  // "App, QR-Code, Phone".
  REMOTE: "remote",
  // "Remote use via direct payment".
  "Direct Payment": "remote",
  "No Authentication Required": "none",
};

const ACCESSIBILITY: Readonly<Record<string, string>> = {
  "Free publicly accessible": "public",
  "Paying publicly accessible": "public",
  "Restricted access": "restricted",
};

const LOCATIONS: Readonly<Record<string, string>> = {
  OnStreet: "on_street",
  ParkingLot: "parking_lot",
  ParkingGarage: "parking_garage",
  UndergroundParkingGarage: "underground_garage",
};

const ENERGY: Readonly<Record<string, string>> = {
  Solar: "solar",
  Wind: "wind",
  HydroPower: "water",
  GeothermalEnergy: "geothermal",
  Biomass: "biomass",
  Coal: "coal",
  NuclearEnergy: "nuclear",
  Petroleum: "petroleum",
  NaturalGas: "gas",
};

const DAYS: Readonly<Record<string, string>> = {
  Everyday: "Mo-Su 08:00-18:00",
  Workdays: "Mo-Fr 08:00-18:00",
  Weekend: "Sa,Su 08:00-18:00",
  Monday: "Mo 08:00-18:00",
  Tuesday: "Tu 08:00-18:00",
  Wednesday: "We 08:00-18:00",
  Thursday: "Th 08:00-18:00",
  Friday: "Fr 08:00-18:00",
  Saturday: "Sa 08:00-18:00",
  Sunday: "Su 08:00-18:00",
};

const CALIBRATION: Readonly<Record<string, string>> = {
  Local: "local",
  External: "external",
  "Not Available": "not_available",
};

const STATUSES: Readonly<Record<string, string>> = {
  Available: "available",
  Reserved: "reserved",
  Occupied: "occupied",
  OutOfService: "out_of_order",
  // "No status information available", nor any EVSE of that id.
  EvseNotFound: "unknown",
  Unknown: "unknown",
};

const COVERAGE: Readonly<Record<string, CoverageSpec & { pointer: string }>> = {
  Plug: {
    pointer: `${SCHEMAS}/Plug`,
    handled: (v) => {
      const c = connector(one({ Plugs: [v] }))?.details;
      const [standard, format] = PLUGS[v] ?? [];
      return (
        noneUnread() &&
        standard !== undefined &&
        c?.["standard"] === standard &&
        c?.["format"] === format
      );
    },
  },
  AuthenticationMode: {
    pointer: `${SCHEMAS}/AuthenticationMode`,
    handled: (v) => {
      const out = one({ AuthenticationModes: [v] });
      return (
        noneUnread() &&
        AUTHENTICATION[v] !== undefined &&
        same(access(out)["authentication"], [AUTHENTICATION[v]]) &&
        (v === "Direct Payment") === (details(out)["adHocCharging"] === true)
      );
    },
  },
  PaymentOption: {
    pointer: `${SCHEMAS}/PaymentOption`,
    handled: (v) => {
      const out = one({ PaymentOptions: [v] });
      if (!noneUnread()) return false;
      // "Free"; "i. e. Subscription"; "e. g. Cash, Card, SMS": ad hoc, by no one means.
      if (v === "No Payment") return same(access(out)["payment"], ["free"]);
      if (v === "Contract") return same(access(out)["payment"], ["membership"]);
      return (
        v === "Direct" && details(out)["adHocCharging"] === true && !("payment" in access(out))
      );
    },
  },
  ValueAddedService: {
    pointer: `${SCHEMAS}/ValueAddedService`,
    handled: (v) => {
      const out = one({ ValueAddedServices: [v] });
      if (!noneUnread()) return false;
      if (v === "Reservation") {
        return (
          access(out)["reservation"] === true &&
          same(evse(out)?.details["capabilities"], ["RESERVABLE"])
        );
      }
      return v === "RoofProvided" && details(out)["roofed"] === true;
    },
    unsupported: {
      DynamicPricing:
        "says the back end prices dynamically; the offer is the price itself, and OICP publishes none",
      ParkingSensors:
        "says a bay sensor feeds the status; the model holds the status, not its source",
      MaximumPowerCharging:
        "a back-end service adjusting the maximum power; the connector holds its rated maximum",
      PredictiveChargePointUsage:
        "says predictions are available elsewhere; none are published here",
      ChargingPlans:
        "ISO 15118-2 charging schedules negotiated per session, no property of the site",
      None: "says there are no services: nothing to hold",
    },
  },
  Accessibility: {
    pointer: `${SCHEMAS}/Accessibility`,
    handled: (v) =>
      noneUnread() &&
      ACCESSIBILITY[v] !== undefined &&
      access(one({ Accessibility: v }))["audience"] === ACCESSIBILITY[v],
    unsupported: {
      "Test Station":
        '"just for testing purposes. Access may be restricted": says neither who may charge nor that the station is not in operation',
    },
  },
  AccessibilityLocation: {
    pointer: `${SCHEMAS}/PullEvseDataRecord/properties/AccessibilityLocation`,
    handled: (v) =>
      noneUnread() &&
      LOCATIONS[v] !== undefined &&
      details(one({ AccessibilityLocation: v }))["parkingType"] === LOCATIONS[v],
  },
  PowerType: {
    pointer: `${SCHEMAS}/ChargingFacility/properties/PowerType`,
    handled: (v) =>
      noneUnread() &&
      connector(one({ ChargingFacilities: [{ PowerType: v, Power: 22 }] }))?.details[
        "powerType"
      ] === v,
  },
  ChargingMode: {
    pointer: `${SCHEMAS}/ChargingFacility/properties/ChargingModes/items`,
    handled: (v) =>
      noneUnread() &&
      ["Mode_1", "Mode_2", "Mode_3", "Mode_4", "CHAdeMO"].includes(v) &&
      same(
        connector(one({ ChargingFacilities: [{ PowerType: "DC", Power: 50, ChargingModes: [v] }] }))
          ?.details["chargingModes"],
        [v === "CHAdeMO" ? "chademo" : `mode${v.slice(-1)}`],
      ),
  },
  Energy: {
    pointer: `${SCHEMAS}/EnergySource/properties/Energy`,
    handled: (v) =>
      noneUnread() &&
      ENERGY[v] !== undefined &&
      same(
        details(one({ RenewableEnergy: true, EnergySource: [{ Energy: v, Percentage: 99 }] }))[
          "energyMix"
        ],
        { isGreen: true, sources: [{ source: ENERGY[v], pct: 99 }] },
      ),
  },
  CalibrationLawDataAvailability: {
    pointer: `${SCHEMAS}/PullEvseDataRecord/properties/CalibrationLawDataAvailability`,
    handled: (v) => {
      const expected = CALIBRATION[v];
      return (
        noneUnread() &&
        expected !== undefined &&
        details(one({ CalibrationLawDataAvailability: v }))["calibrationLaw"] === expected
      );
    },
  },
  DynamicInfoAvailable: {
    pointer: `${SCHEMAS}/PullEvseDataRecord/properties/DynamicInfoAvailable`,
    handled: (v) =>
      noneUnread() &&
      ["true", "false", "auto"].includes(v) &&
      details(one({ DynamicInfoAvailable: v }))["dynamicInfoAvailable"] === v,
  },
  OpeningDay: {
    pointer: `${SCHEMAS}/OpeningTimes/properties/on`,
    handled: (v) => {
      const out = one({
        IsOpen24Hours: false,
        OpeningTimes: [{ Period: [{ begin: "08:00", end: "18:00" }], on: v }],
      });
      return (
        noneUnread() &&
        DAYS[v] !== undefined &&
        (site(out)?.["openingHours"] as Json)?.["osm"] === DAYS[v]
      );
    },
  },
  DeltaType: {
    pointer: `${SCHEMAS}/PullEvseDataRecord/properties/deltaType`,
    // A record an update deletes is no EVSE; one it inserts or updates is.
    handled: (v) =>
      ["insert", "update", "delete"].includes(v) &&
      one({ deltaType: v }).features.length === (v === "delete" ? 0 : 1),
  },
  EvseStatus: {
    pointer: `${SCHEMAS}/EvseStatus`,
    handled: (v) => {
      const out = parse({
        main: [page([record()])],
        status: [
          Buffer.from(
            JSON.stringify({
              EvseStatuses: {
                OperatorEvseStatus: [
                  {
                    OperatorID: "DE*ABC",
                    EvseStatusRecord: [{ EvseID: "DE*ABC*E1234567", EvseStatus: v }],
                  },
                ],
              },
            }),
          ),
        ],
      });
      const value = (out.observations[0]?.["result"] as Json | undefined)?.["value"];
      return noneUnread() && STATUSES[v] !== undefined && value === STATUSES[v];
    },
  },
};

/**
 * The fields of a pulled record that are read: each changed to another valid
 * value changes what the parser publishes.
 */
const READ: Readonly<Record<string, unknown>> = {
  EvseID: "DE*ABC*E7654321",
  ChargingPoolID: "DE*ABC*P9999",
  ChargingStationNames: [{ lang: "de", value: "ABC Testladestation" }],
  HardwareManufacturer: "Alpitronic",
  ChargingStationImage: "https://example.org/evse.jpg",
  SubOperatorName: "Sub GmbH",
  Address: {
    Country: "DEU",
    City: "Berlin",
    Street: "Test Street",
    PostalCode: "10829",
    HouseNum: "22",
    Floor: "2",
    Region: "Berlin",
    ParkingSpot: "E36",
  },
  GeoCoordinates: { Google: { Coordinates: "52.480000 13.356000" } },
  Plugs: ["CHAdeMO"],
  ChargingFacilities: [{ PowerType: "DC", Power: 50 }],
  RenewableEnergy: true,
  EnergySource: [{ Energy: "Wind", Percentage: 99 }],
  EnvironmentalImpact: { CO2Emission: 12, NuclearWaste: 0.1 },
  CalibrationLawDataAvailability: "Local",
  AuthenticationModes: ["PnC"],
  PaymentOptions: ["No Payment"],
  ValueAddedServices: ["RoofProvided"],
  Accessibility: "Restricted access",
  AccessibilityLocation: "ParkingGarage",
  HotlinePhoneNumber: "+4930123456",
  AdditionalInfo: [{ lang: "en", value: "Ask at the desk" }],
  ChargingStationLocationReference: [{ lang: "en", value: "Behind the barrier" }],
  GeoChargingPointEntrance: { Google: { Coordinates: "52.480600 13.356500" } },
  IsOpen24Hours: false,
  OpeningTimes: [{ Period: [{ begin: "08:00", end: "18:00" }], on: "Workdays" }],
  HubOperatorID: "DE*HUB",
  DynamicInfoAvailable: "false",
  OperatorName: "XYZ energy",
  deltaType: "delete",
};

/** The fields of a pulled record left unread, with the reason. */
const UNREAD: Readonly<Record<string, [unknown, string]>> = {
  lastUpdate: ["2026-10-01T00:00:00Z", "the model holds no publisher update date of a site"],
  ChargingStationId: [
    "STATION-9",
    "a charging station between pool and EVSE: the site is the pool, its points the EVSEs, and the model has no level between",
  ],
  DynamicPowerLevel: [
    true,
    "whether the point can deliver less than its rated power; the connector holds the rated maximum",
  ],
  MaxCapacity: [
    60,
    "the kWh a battery-buffered point holds; the model holds no energy capacity of a charge point",
  ],
  ClearinghouseID: ["CH-1", "a clearing house of Hubject's roaming, no property of the site"],
  IsHubjectCompatible: [
    false,
    "whether Hubject starts and stops sessions remotely, its own routing",
  ],
  OperatorID: [
    "DE*XYZ",
    "the operator is named by OperatorName, which every pulled record carries; its eMI3 operator id is no register id the model holds",
  ],
};

describe("OICP 2.3 through the parser", () => {
  let doc: unknown;
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(OICP_2_3);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else doc = parseYaml(pinned.files[0]!.contents);
  }, 120_000);

  beforeEach(() => {
    __resetSkips();
  });

  test("the base record is valid and read without anything left unread", () => {
    expect(one().features).toHaveLength(1);
    expect(drainSkipped(FEED_ID)).toEqual({});
  });

  for (const [name, { pointer, ...spec }] of Object.entries(COVERAGE)) {
    test(`${name}: every value is read as OICP describes it`, ({ skip }) => {
      if (unavailable) skip(unavailable);
      const values = jsonSchemaEnums(doc).get(pointer);
      expect(values, pointer).toBeDefined();
      assertCovered(`OICP 2.3 ${name}`, values!, spec);
    });
  }

  test("no predicate holds for a value OICP does not define, and each is counted", () => {
    for (const [name, { handled }] of Object.entries(COVERAGE)) {
      __resetSkips();
      expect([name, (handled as (value: string) => boolean)("X_NOT_OICP")]).toEqual([name, false]);
    }
  });

  test("every field of a pulled record is read or listed as unread", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const schemas = (doc as { components: { schemas: Record<string, { properties: Json }> } })
      .components.schemas;
    const fields = Object.keys(schemas["PullEvseDataRecord"]!.properties);
    expect([...Object.keys(READ), ...Object.keys(UNREAD)].sort()).toEqual([...fields].sort());
    const published = (out: ParseOutput) => JSON.stringify([out.features, out.observations]);
    const base = published(one());
    for (const [name, value] of Object.entries(READ)) {
      // Opening times are read where the station is not open around the clock.
      const context = name === "OpeningTimes" ? { IsOpen24Hours: false } : {};
      expect([
        name,
        published(one({ ...context, [name]: value })) !== published(one(context)),
      ]).toEqual([name, true]);
    }
    for (const [name, [value]] of Object.entries(UNREAD)) {
      expect([name, published(one({ [name]: value })) === base]).toEqual([name, true]);
    }
  });
});

describe("OICP fields as the model holds them", () => {
  beforeEach(() => {
    __resetSkips();
  });

  test("a record with every field read lands where the model holds it", () => {
    const out = one({
      HardwareManufacturer: "Alpitronic",
      ChargingStationImage: "https://example.org/evse.jpg",
      SubOperatorName: "Sub GmbH",
      Address: {
        Country: "DEU",
        City: "Berlin",
        Street: "Test Street",
        PostalCode: "10829",
        HouseNum: "22",
        Floor: "2",
        Region: "Berlin",
        ParkingSpot: "E36",
      },
      ChargingFacilities: [
        {
          PowerType: "AC_3_PHASE",
          Power: 22,
          Voltage: 230,
          Amperage: 32,
          ChargingModes: ["Mode_3"],
        },
      ],
      RenewableEnergy: true,
      EnergySource: [
        { Energy: "Solar", Percentage: 60 },
        { Energy: "HydroPower", Percentage: 40 },
      ],
      EnvironmentalImpact: { CO2Emission: 0, NuclearWaste: 0 },
      CalibrationLawDataAvailability: "External",
      AuthenticationModes: ["REMOTE", "PnC"],
      PaymentOptions: ["Direct", "Contract"],
      ValueAddedServices: ["Reservation", "RoofProvided"],
      AccessibilityLocation: "UndergroundParkingGarage",
      AdditionalInfo: [{ lang: "en", value: "Ask at the desk" }],
      ChargingStationLocationReference: [{ lang: "en", value: "Behind the barrier" }],
      GeoChargingPointEntrance: { Google: { Coordinates: "52.480600 13.356500" } },
      IsOpen24Hours: false,
      OpeningTimes: [
        { Period: [{ begin: "07:00", end: "20:00" }], on: "Workdays" },
        { Period: { begin: "09:00", end: "14:00" }, on: "Saturday" },
      ],
      HubOperatorID: "DE*HUB",
      DynamicInfoAvailable: "auto",
    });
    expect(drainSkipped(FEED_ID)).toEqual({});
    expect(site(out)).toMatchObject({
      name: [{ lang: "en", text: "ABC Charging Station Test" }],
      operator: { name: [{ text: "ABC technologies" }] },
      description: [{ lang: "en", text: "Ask at the desk" }],
      location: {
        address: { street: "Test Street 22", region: "Berlin", city: "Berlin", country: "DE" },
      },
      openingHours: { osm: "Mo-Fr 07:00-20:00; Sa 09:00-14:00" },
      access: {
        audience: "public",
        authentication: ["remote", "plug_and_charge"],
        payment: ["membership"],
        reservation: true,
      },
    });
    expect(details(out)).toMatchObject({
      parkingType: "underground_garage",
      roofed: true,
      adHocCharging: true,
      hotline: "+49123123123123",
      suboperator: { role: "suboperator", name: [{ text: "Sub GmbH" }] },
      entrance: { type: "Point", coordinates: [13.3565, 52.4806] },
      energyMix: {
        isGreen: true,
        sources: [
          { source: "solar", pct: 60 },
          { source: "water", pct: 40 },
        ],
        impacts: [
          { category: "carbon_dioxide", gPerKwh: 0 },
          { category: "nuclear_waste", gPerKwh: 0 },
        ],
      },
      calibrationLaw: "external",
      dynamicInfoAvailable: "auto",
      hubOperatorId: "DE*HUB",
    });
    expect(evse(out)).toMatchObject({
      floorLevel: "2",
      images: [{ url: "https://example.org/evse.jpg", category: "equipment" }],
      details: {
        capabilities: ["RESERVABLE"],
        manufacturer: "Alpitronic",
        directions: [{ lang: "en", text: "Behind the barrier" }],
        bays: [{ key: "bay:E36" }],
      },
    });
    expect(components(out).find((c) => c.kind === "charging_bay")).toMatchObject({
      key: "bay:E36",
      physicalReference: "E36",
    });
    expect(connector(out)?.details).toMatchObject({ chargingModes: ["mode3"] });
  });

  test("OICP 2.1's grouped pull answer and a push request read as the 2.3 page does", () => {
    const flat = one();
    const { OperatorID, OperatorName, ...bare } = record();
    const grouped = parse({
      main: [
        Buffer.from(
          JSON.stringify({
            EvseData: { OperatorEvseData: [{ OperatorID, OperatorName, EvseDataRecord: [bare] }] },
          }),
        ),
      ],
    });
    const pushed = parse({
      main: [
        Buffer.from(
          JSON.stringify({
            ActionType: "fullLoad",
            OperatorEvseData: { OperatorID, OperatorName, EvseDataRecord: [bare] },
          }),
        ),
      ],
    });
    expect(grouped.features).toEqual(flat.features);
    expect(pushed.features).toEqual(flat.features);
  });

  test("a value OICP does not define is left out and counted once", () => {
    const out = one({
      Plugs: ["Megaplug"],
      ChargingFacilities: [{ PowerType: "AC_4_PHASE", Power: 11, ChargingModes: ["Mode_9"] }],
      AuthenticationModes: ["Retina"],
      PaymentOptions: ["Barter"],
      ValueAddedServices: ["Valet"],
      Accessibility: "Members",
      AccessibilityLocation: "Rooftop",
      EnergySource: [{ Energy: "Peat", Percentage: 10 }],
      CalibrationLawDataAvailability: "Partial",
      DynamicInfoAvailable: "maybe",
      IsOpen24Hours: false,
      OpeningTimes: [{ Period: [{ begin: "08:00", end: "18:00" }], on: "Holidays" }],
    });
    expect(out.features).toHaveLength(1);
    expect(connector(out)?.details["standard"]).toBe("UNKNOWN");
    // Plug, power type, mode, authentication, payment, service, accessibility,
    // location, energy, calibration law, dynamic info, day.
    expect(drainSkipped(FEED_ID)).toEqual({ unknown_value: 12 });
  });
});
