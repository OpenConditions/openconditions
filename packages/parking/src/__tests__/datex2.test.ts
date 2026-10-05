import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { parseDatex2 } from "../formats/datex2.js";
import { citaFeed, fixture, ndwFeed, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T03:35:30Z";

function parse(
  feed: ParkingCatalogFeed,
  sites: Buffer | undefined,
  status: Buffer | undefined,
): ParseOutput {
  const out = parseDatex2(
    feed,
    { ...(sites ? { sites: [sites] } : {}), ...(status ? { status: [status] } : {}) },
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const ndw = () => parse(ndwFeed(), fixture("ndw-truck-table.xml"), fixture("ndw-truck-status.xml"));
const cita = () => parse(citaFeed(), fixture("cita-static.xml"), fixture("cita-dynamic.xml"));

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => String(f["id"]).endsWith(`:${stationId}`));

/** A site's readings as `[componentKey or "site", property] → value`. */
function readings(out: ParseOutput, stationId: string): Record<string, unknown> {
  const featureId = site(out, stationId)?.["id"];
  return Object.fromEntries(
    out.observations
      .filter((o) => (o["subject"] as { featureId: string }).featureId === featureId)
      .map((o) => {
        const subject = o["subject"] as { componentKey?: string };
        return [
          `${subject.componentKey ?? "site"} ${o["property"]}`,
          (o["result"] as { value: unknown }).value,
        ];
      }),
  );
}

const areas = (feature: RecordDraft | undefined) =>
  ((feature?.["components"] ?? []) as { key: string; details: { capacity?: number } }[]).map(
    (c) => [c.key, c.details.capacity],
  );

const status = (records: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${records}`);

describe("datex2", () => {
  test("DATEX: NDW's v2 table and v3 status give a truck site with per-group availability and its status", () => {
    const out = ndw();
    expect(out.features).toHaveLength(2);
    const nobis = site(out, "NL-12_413");
    expect(nobis).toMatchObject({
      id: "oc:feature:nl-ndw-truck-parking:NL-12_413",
      type: "truck_parking",
      externalIds: [
        { scheme: "provider", id: "NL-12_413", authority: "nl-ndw-truck-parking" },
        { scheme: "datex:parking", id: "NL-12_413", authority: "NL-12" },
      ],
      details: { usage: ["truck"] },
    });
    // The lorry group is the truck area; the empty groups are no areas.
    expect(areas(nobis)).toEqual([["truck:any", 200]]);
    expect(readings(out, "NL-12_413")).toEqual({
      "site parking.available": 13,
      "site parking.occupied": 12,
      "site parking.occupancy_pct": 48,
      "site parking.status": "spaces_available",
      "truck:any parking.available": 13,
      "truck:any parking.occupied": 12,
      "truck:any parking.occupancy_pct": 48,
    });
    const at = out.observations.find(
      (o) => (o["subject"] as { featureId: string }).featureId === nobis?.["id"],
    )?.["phenomenonTime"];
    expect(at).toEqual({ instant: "2026-10-05T03:25:39Z" });
  });

  test("DATEX: a group for vehicles of no parking vehicle type is no area and has no readings", () => {
    const out = ndw();
    // Group 1 holds 12 bays only for refrigerated loads: no vehicle type, and
    // not untyped spaces either.
    expect(areas(site(out, "NL-12_421"))).toEqual([["truck:any", 390]]);
    const venlo = readings(out, "NL-12_421");
    expect(Object.keys(venlo).filter((k) => k.startsWith("any:any"))).toEqual([]);
  });

  test("DATEX: without a stated total, a site free count above its groups' spaces is no reading", () => {
    const venlo = readings(ndw(), "NL-12_421");
    // The table states no total; its groups hold 390 + 12 + 0 = 402 spaces,
    // and the status reports 702 free.
    expect(venlo["site parking.available"]).toBeUndefined();
    expect(venlo["site parking.occupied"]).toBe(0);
    expect(venlo["site parking.occupancy_pct"]).toBeCloseTo(57.43, 2);
  });

  test("DATEX: NDW's lorry park keeps its rating, security, facilities and hourly tariff", () => {
    const out = ndw();
    const venlo = site(out, "NL-12_421");
    expect(venlo).toMatchObject({
      name: [{ lang: "nl", text: "Truckstop Venlo" }],
      location: {
        address: { text: "James Cookweg 31, 5928LJ Venlo", country: "NL" },
      },
      details: {
        securityRating: { scheme: "eu_label", level: "3" },
        securityFeatures: ["cctv", "fences", "lighting", "guard_24h"],
        supervision: "patrol",
      },
    });
    expect(venlo?.["amenities"]).toEqual(
      expect.arrayContaining(["charging_station", "restaurant", "toilets", "shower", "wifi"]),
    );
    expect(venlo?.["access"]).toBeUndefined();
    expect(out.offers).toEqual([
      expect.objectContaining({
        id: "oc:offer:nl-ndw-truck-parking:NL-12_421:1",
        kind: "parking_rate",
        currency: "EUR",
        // €1.00 per 3600 s is a time charge of €1.00 per hour, billed by the hour.
        elements: [
          {
            components: [
              {
                type: "parking_time",
                price: { amount: "1.00", currency: "EUR" },
                stepSize: 3600,
              },
            ],
          },
        ],
        displayText: [{ lang: "nl", text: "Tarief per uur" }],
      }),
    ]);
  });

  test("DATEX: a v3 charge per interval is a price per hour billed in that interval", () => {
    const table = status(
      `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:par="http://datex2.eu/schema/3/parking" xmlns:fac="http://datex2.eu/schema/3/facilities" xmlns:com="http://datex2.eu/schema/3/common" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="par:ParkingTablePublication" lang="nl" modelBaseVersion="3"><com:publicationTime>2026-10-05T03:00:00Z</com:publicationTime><par:parkingTable id="T" version="1"><par:parkingRecord xsi:type="par:UrbanParkingSite" id="NL-12_900" version="1"><par:parkingName><com:values><com:value lang="nl">Garage Centrum</com:value></com:values></par:parkingName><par:parkingLocation xsi:type="loc:PointLocation"><loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>52.37</loc:latitude><loc:longitude>4.89</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates></par:parkingLocation><fac:tariffsAndPayment><fac:chargeBand id="B" version="1"><fac:chargeBandName><com:values><com:value lang="nl">Tarief per half uur</com:value></com:values></fac:chargeBandName><fac:chargeCurrency>eur</fac:chargeCurrency><fac:charge><fac:charge>2.50</fac:charge><fac:chargeInterval>1800</fac:chargeInterval></fac:charge><fac:charge><fac:charge>20.00</fac:charge></fac:charge></fac:chargeBand></fac:tariffsAndPayment></par:parkingRecord></par:parkingTable></d2:payload>`,
    );
    const out = parse(ndwFeed(), table, undefined);
    expect(out.offers).toEqual([
      expect.objectContaining({
        id: "oc:offer:nl-ndw-truck-parking:NL-12_900:1",
        currency: "EUR",
        elements: [
          {
            components: [
              {
                type: "parking_time",
                price: { amount: "5.00", currency: "EUR" },
                stepSize: 1800,
              },
            ],
          },
          // A charge without an interval stays one flat price.
          { components: [{ type: "flat", price: { amount: "20.00", currency: "EUR" } }] },
        ],
        displayText: [{ lang: "nl", text: "Tarief per half uur" }],
      }),
    ]);
  });

  test("DATEX: a status for an unknown record is dropped", () => {
    const out = ndw();
    const ids = new Set(out.features.map((f) => f["id"]));
    const subjects = out.observations.map((o) => (o["subject"] as { featureId: string }).featureId);
    expect(subjects.every((id) => ids.has(id))).toBe(true);
    expect(subjects.some((id) => id.endsWith(":NL-12_408"))).toBe(false);
  });

  test("DATEX: statuses without their table give no records", () => {
    const out = parse(ndwFeed(), undefined, fixture("ndw-truck-status.xml"));
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
  });

  test("DATEX: CITA's free-of-charge flag and tariffs", () => {
    const out = cita();
    expect(out.features).toHaveLength(3);
    const berchem = site(out, "G-MB-B");
    expect(berchem).toMatchObject({
      type: "truck_parking",
      operator: {
        role: "operator",
        name: [{ lang: "fr", text: "Administration des Ponts et Chaussées" }],
      },
      access: { audience: "unknown", payment: ["free"] },
      externalIds: [
        { scheme: "provider", id: "G-MB-B", authority: "lu-cita-parking" },
        { scheme: "datex:parking", id: "G-MB-B", authority: "PCH" },
      ],
    });
    // A free site publishes no charge band, so it has no rate.
    expect(out.offers).toEqual([]);
    expect(readings(out, "G-MB-B")).toEqual({
      "site parking.available": 4,
      "site parking.occupied": 36,
      "site parking.occupancy_pct": 90,
      "site parking.status": "almost_full",
      "site parking.trend": "steady",
    });
    const reading = out.observations.find(
      (o) => (o["subject"] as { featureId: string }).featureId === berchem?.["id"],
    );
    // 05:30 in Luxembourg's summer time, as published with its offset.
    expect(reading?.["phenomenonTime"]).toEqual({ instant: "2026-10-05T03:30:00Z" });
    expect(readings(out, "C-WC-W")).toEqual({});
  });

  test("DATEX: a status code the crosswalk has no key for gives no status reading", () => {
    // v3 grades vacant spaces, a code the v3 status crosswalk does not hold.
    const v3 = status(
      `<ns3:payload xsi:type="ns2:ParkingStatusPublication" lang="en" modelBaseVersion="3" xmlns="http://datex2.eu/schema/3/common" xmlns:ns2="http://datex2.eu/schema/3/parking" xmlns:ns3="http://datex2.eu/schema/3/d2Payload" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><publicationTime>2026-10-05T03:31:35Z</publicationTime><ns2:parkingRecordStatus xsi:type="ns2:ParkingSiteStatus"><ns2:parkingRecordReference targetClass="par:ParkingRecord" id="NL-12_413"/><ns2:parkingStatusOriginTime>2026-10-05T03:25:39Z</ns2:parkingStatusOriginTime><ns2:parkingOccupancy><ns2:parkingNumberOfVacantSpacesGraded>lessThan10SpacesAvailable</ns2:parkingNumberOfVacantSpacesGraded></ns2:parkingOccupancy></ns2:parkingRecordStatus></ns3:payload>`,
    );
    expect(readings(parse(ndwFeed(), fixture("ndw-truck-table.xml"), v3), "NL-12_413")).toEqual({});
    // v2 publishes an opening status the v2 crosswalk does not hold.
    const v2 = status(
      `<d2LogicalModel modelBaseVersion="2" xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication xsi:type="GenericPublication" lang="en" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><publicationTime>2026-10-05T05:30:10+02:00</publicationTime><publicationCreator><country>lu</country><nationalIdentifier>PCH</nationalIdentifier></publicationCreator><genericPublicationName>ParkingStatusPublication</genericPublicationName><genericPublicationExtension><parkingStatusPublication><parkingRecordStatus xsi:type="ParkingSiteStatus"><parkingRecordReference targetClass="ParkingRecord" id="G-MB-B" version="1"/><parkingStatusOriginTime>2026-10-05T05:30:00+02:00</parkingStatusOriginTime><parkingSiteOpeningStatus>closed</parkingSiteOpeningStatus></parkingRecordStatus></parkingStatusPublication></genericPublicationExtension></payloadPublication></d2LogicalModel>`,
    );
    expect(readings(parse(citaFeed(), fixture("cita-static.xml"), v2), "G-MB-B")).toEqual({});
  });
});
