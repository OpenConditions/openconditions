import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";
import { byReadingId, fullAndStatus } from "./helpers/status-only.js";

const FETCHED = "2026-10-06T02:45:56Z";

function parse(payloads: FeedPayloads): ParseOutput {
  const out = chargingDomain.formats["oicp"]!.parse(
    catalogFeed("ch-bfe-charging"),
    payloads,
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const statusOf = (out: ParseOutput, evse: string) =>
  out.observations.find((o) => (o["subject"] as { componentKey: string }).componentKey === evse)?.[
    "result"
  ];

const swiss = () =>
  parse({ main: [fixture("oicp-data.json")], status: [fixture("oicp-status.json")] });

describe("oicp", () => {
  test("OICP: Occupied is occupied, OutOfService out_of_order, and '22.0' is 22 kW", () => {
    const out = swiss();
    const category = (value: string) => ({ type: "category", value, vocabulary: "evse_status" });
    expect(statusOf(out, "CH*CCI*E20277")).toEqual(category("occupied"));
    expect(statusOf(out, "CH*CCI*E22459")).toEqual(category("out_of_order"));
    expect(statusOf(out, "CH*CCI*E22896")).toEqual(category("available"));
    expect(statusOf(out, "CH*CCI*E22078")).toEqual(category("unknown"));
    expect(statusOf(out, "CHFASE410051")).toEqual(category("unknown"));
    // The status file carries no times: a reading is as of the fetch.
    expect(
      out.observations.every(
        (o) => (o["phenomenonTime"] as { instant: string }).instant === FETCHED,
      ),
    ).toBe(true);

    // Move writes its facilities as strings: 22.0 kW, three-phase, 230 V × 32 A.
    const move = out.features.find((f) => components(f).some((c) => c.key === "CH*CCI*E20277"));
    expect(components(move).find((c) => c.key === "CH*CCI*E20277/1")?.details).toMatchObject({
      standard: "IEC_62196_T2",
      format: "socket",
      powerType: "AC_3_PHASE",
      current: "ac",
      maxPowerKw: 22,
      maxVoltage: 230,
      maxAmperage: 32,
    });
    expect(move).toMatchObject({
      openingHours: { osm: "24/7", twentyFourSeven: true },
      location: { address: { country: "CH" } },
    });
  });

  test("OICP: a record written as the Hubject 2.3 schema has its facility power and position", () => {
    // The eRoamingPushEvseData record of the OICP 2.3 CPO code snippets.
    const record = {
      Accessibility: "Restricted access",
      AccessibilityLocation: "ParkingGarage",
      Address: {
        City: "Berlin",
        Country: "DEU",
        Floor: "6OG",
        HouseNum: "22",
        PostalCode: "10829",
        Region: "Berlin",
        Street: "EUREF CAMPUS",
        TimeZone: "UTC+01:00",
        ParkingFacility: true,
        ParkingSpot: "E36",
      },
      AuthenticationModes: ["NFC RFID Classic", "REMOTE"],
      CalibrationLawDataAvailability: "Local",
      ChargingFacilities: [
        {
          Amperage: 32,
          Power: 22,
          PowerType: "AC_3_PHASE",
          Voltage: 480,
          ChargingModes: ["Mode_4"],
        },
      ],
      ChargingPoolID: "DE*ABC*P1234TEST*1",
      ChargingStationNames: [
        { lang: "en", value: "ABC Charging Station Test" },
        { lang: "de", value: "ABC Testladestation" },
      ],
      DynamicInfoAvailable: "true",
      EvseID: "DE*XYZ*ETEST1",
      GeoCoordinates: { Google: { Coordinates: "52.480495 13.356465" } },
      HotlinePhoneNumber: "+49123123123123",
      IsHubjectCompatible: true,
      IsOpen24Hours: false,
      PaymentOptions: ["No Payment"],
      Plugs: ["Type 2 Outlet"],
      RenewableEnergy: true,
      ValueAddedServices: ["Reservation"],
    };
    const data = {
      EVSEData: [
        { OperatorID: "DE*ABC", OperatorName: "ABC technologies", EVSEDataRecord: [record] },
      ],
    };
    const status = {
      EVSEStatuses: [
        {
          OperatorID: "DE*ABC",
          EVSEStatusRecord: [{ EvseID: "DE*XYZ*ETEST1", EvseStatus: "Available" }],
        },
      ],
    };
    const out = parse({
      main: [Buffer.from(JSON.stringify(data))],
      status: [Buffer.from(JSON.stringify(status))],
    });
    expect(out.rejected).toBe(0);
    const site = out.features.find(
      (f) => f["id"] === "oc:feature:ch-bfe-charging:DE*ABC*P1234TEST*1",
    );
    expect(site).toMatchObject({
      location: { geometry: { type: "Point", coordinates: [13.356465, 52.480495] } },
    });
    expect(components(site).find((c) => c.key === "DE*XYZ*ETEST1/1")?.details).toMatchObject({
      standard: "IEC_62196_T2",
      powerType: "AC_3_PHASE",
      current: "ac",
      maxPowerKw: 22,
      maxVoltage: 480,
      maxAmperage: 32,
    });
    expect(statusOf(out, "DE*XYZ*ETEST1")).toEqual({
      type: "category",
      value: "available",
      vocabulary: "evse_status",
    });
  });

  test("OICP: a position in degrees, minutes and seconds", () => {
    const data = JSON.parse(fixture("oicp-data.json").toString("utf8")) as {
      EVSEData: { EVSEDataRecord: Record<string, unknown>[] }[];
    };
    const record = data.EVSEData.flatMap((g) => g.EVSEDataRecord).find(
      (r) => r["EvseID"] === "CH*CCI*E22896",
    )!;
    record["GeoCoordinates"] = {
      DegreeMinuteSeconds: { Latitude: "52°28'49.782''", Longitude: "-13° 21' 23.274''" },
    };
    const out = parse({ main: [Buffer.from(JSON.stringify(data))] });
    const site = out.features.find((f) => components(f).some((c) => c.key === "CH*CCI*E22896"));
    const location = site?.["location"] as { geometry: { coordinates: [number, number] } };
    const [lon, lat] = location.geometry.coordinates;
    expect(lat).toBeCloseTo(52.480495, 6);
    expect(lon).toBeCloseTo(-13.356465, 6);
  });

  test("OICP: a pool is one site of its EVSEs; EVSEs without a pool group by position", () => {
    const out = swiss();
    const pool = out.features.find((f) => f["id"] === "oc:feature:ch-bfe-charging:CH*MIG*P*321");
    expect(
      components(pool)
        .filter((c) => c.kind === "evse")
        .map((c) => c.key)
        .sort(),
    ).toEqual(["CH*MIG*E*247296", "CH*MIG*E*247297", "CH*MIG*E*247298", "CH*MIG*E*247299"]);
    expect(components(pool).find((c) => c.key === "CH*MIG*E*247298/1")?.details).toMatchObject({
      standard: "IEC_62196_T2_COMBO",
      format: "cable",
      powerType: "DC",
      maxPowerKw: 320,
    });
    // Five Move EVSEs at one spot of the CERN esplanade are one site.
    const cern = out.features.find(
      (f) => f["id"] === "oc:feature:ch-bfe-charging:46.23432,6.05560",
    );
    expect(components(cern).filter((c) => c.kind === "evse")).toHaveLength(5);
    expect(out.features).toHaveLength(6);
  });

  test("OICP: one operator's EVSEs a few metres apart are one site; a Tesla connector is unknown", () => {
    const data = JSON.parse(fixture("oicp-data.json").toString("utf8")) as {
      EVSEData: { EVSEDataRecord: Record<string, unknown>[] }[];
    };
    const records = data.EVSEData.flatMap((g) => g.EVSEDataRecord);
    // One CERN EVSE 4 m east of the others: a station of its own by position.
    records.find((r) => r["EvseID"] === "CH*CCI*E22078")!["GeoCoordinates"] = {
      Google: "46.23432 6.055654",
    };
    records.find((r) => r["EvseID"] === "CH*CCI*E22896")!["Plugs"] = ["Tesla Connector"];
    const out = parse({ main: [Buffer.from(JSON.stringify(data))] });
    const cern = out.features.filter((f) => String(f["id"]).includes(":46.2343"));
    expect(cern.map((f) => f["id"])).toEqual(["oc:feature:ch-bfe-charging:46.23432,6.05560"]);
    expect(components(cern[0]).filter((c) => c.kind === "evse")).toHaveLength(5);
    const thun = out.features.find((f) => components(f).some((c) => c.key === "CH*CCI*E22896"));
    expect(components(thun).find((c) => c.kind === "connector")?.details["standard"]).toBe(
      "UNKNOWN",
    );
  });

  test("OICP: Reserved is reserved; a status of an EVSE the data does not list is no reading", () => {
    const status = {
      EVSEStatuses: [
        {
          OperatorID: "CH*MIG",
          OperatorName: "M-Charge",
          EVSEStatusRecord: [
            { EvseID: "CH*MIG*E*247297", EVSEStatus: "Reserved" },
            { EvseID: "CH*MIG*E*999999", EVSEStatus: "Available" },
          ],
        },
      ],
    };
    const out = parse({
      main: [fixture("oicp-data.json")],
      status: [Buffer.from(JSON.stringify(status))],
    });
    expect(out.observations).toHaveLength(1);
    expect(statusOf(out, "CH*MIG*E*247297")).toEqual({
      type: "category",
      value: "reserved",
      vocabulary: "evse_status",
    });
  });

  test("OICP: status alone, through the full parse's index, gives the full parse's readings", () => {
    const feed = catalogFeed("ch-bfe-charging");
    const payloads = { main: [fixture("oicp-data.json")], status: [fixture("oicp-status.json")] };
    const { full, status } = fullAndStatus("oicp", feed, payloads, parseContext(FETCHED));
    expect(full.observations.length).toBeGreaterThan(0);
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));
    expect(status.rejected).toBe(0);
  });

  test("OICP: a status of an EVSE the index does not name is rejected", () => {
    const feed = catalogFeed("ch-bfe-charging");
    const unknown = {
      EVSEStatuses: [
        {
          OperatorID: "CH*MIG",
          EVSEStatusRecord: [
            { EvseID: "CH*MIG*E*247297", EVSEStatus: "Reserved" },
            { EvseID: "CH*MIG*E*999999", EVSEStatus: "Available" },
          ],
        },
      ],
    };
    const { status } = fullAndStatus(
      "oicp",
      feed,
      { main: [fixture("oicp-data.json")], status: [fixture("oicp-status.json")] },
      parseContext(FETCHED),
      { status: [Buffer.from(JSON.stringify(unknown))] },
    );
    expect(status.observations).toHaveLength(1);
    expect(status.rejected).toBe(1);
  });
});
