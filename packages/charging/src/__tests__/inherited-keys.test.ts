import { __resetSkips, drainSkipped, type FeedPayloads } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * A source value that names a property every object inherits (`constructor`,
 * `toString`, `__proto__`) is a value no standard defines: the code tables
 * must not take it for one of their entries.
 */

const FETCHED = "2026-10-17T08:00:00Z";
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function parse(format: string, feedId: string, payloads: FeedPayloads) {
  const out = chargingDomain.formats[format]!.parse(
    catalogFeed(feedId),
    payloads,
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return { out, skipped: drainSkipped(feedId) };
}

describe("inherited property names are unknown values", () => {
  beforeEach(() => __resetSkips());

  test("OICP", () => {
    const record = {
      EvseID: "DE*ABC*E1",
      GeoCoordinates: { Google: { Coordinates: "52.480495 13.356465" } },
      OperatorName: "ABC",
      Plugs: ["toString"],
      ChargingFacilities: [{ PowerType: "DC", Power: 50, ChargingModes: ["constructor"] }],
      AuthenticationModes: ["__proto__"],
      PaymentOptions: ["constructor"],
      Accessibility: "toString",
      AccessibilityLocation: "constructor",
      EnergySource: [{ Energy: "hasOwnProperty", Percentage: 10 }],
      CalibrationLawDataAvailability: "valueOf",
      IsOpen24Hours: false,
      OpeningTimes: [{ Period: [{ begin: "08:00", end: "18:00" }], on: "constructor" }],
    };
    const { out, skipped } = parse("oicp", "ch-bfe-charging", {
      main: [json({ content: [record] })],
      status: [
        json({
          EvseStatuses: {
            OperatorEvseStatus: [
              { EvseStatusRecord: [{ EvseID: "DE*ABC*E1", EvseStatus: "toString" }] },
            ],
          },
        }),
      ],
    });
    expect(out.features).toHaveLength(1);
    expect(out.observations).toEqual([]);
    const connector = (out.features[0]!["components"] as { kind: string; details: object }[]).find(
      (c) => c.kind === "connector",
    );
    expect(connector?.details).toMatchObject({ standard: "UNKNOWN" });
    expect(connector?.details).not.toHaveProperty("chargingModes");
    // Plug, mode, authentication, payment, accessibility, location, energy,
    // calibration law, day, status.
    expect(skipped).toEqual({ unknown_value: 10 });
  });

  test("DATEX", () => {
    const egi = "http://datex2.eu/schema/3/energyInfrastructure";
    const table = Buffer.from(
      `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:egi="${egi}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="egi:EnergyInfrastructureTablePublication" lang="en" modelBaseVersion="3"><egi:energyInfrastructureTable id="t" version="1"><egi:energyInfrastructureSite id="s" version="1"><locationReference><pointByCoordinates><pointCoordinates><latitude>48.1</latitude><longitude>11.5</longitude></pointCoordinates></pointByCoordinates></locationReference><egi:energyInfrastructureStation id="st" version="1"><egi:authenticationAndIdentificationMethods>toString</egi:authenticationAndIdentificationMethods><egi:refillPoint xsi:type="egi:ElectricChargingPoint" id="p0" version="1"><egi:connector><egi:connectorType>constructor</egi:connectorType><egi:chargingMode>constructor</egi:chargingMode></egi:connector><egi:electricEnergyMix energyMixIndex="1"><egi:electricEnergySourceRatio><egi:energySource>__proto__</egi:energySource><egi:sourceRatioValue><percentage>10</percentage></egi:sourceRatioValue></egi:electricEnergySourceRatio></egi:electricEnergyMix></egi:refillPoint></egi:energyInfrastructureStation></egi:energyInfrastructureSite></egi:energyInfrastructureTable></d2:payload>`,
    );
    const status = Buffer.from(
      `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:egi="${egi}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="egi:EnergyInfrastructureStatusPublication" lang="en" modelBaseVersion="3"><egi:energyInfrastructureSiteStatus><egi:reference id="s" version="1"/><egi:energyInfrastructureStationStatus><egi:reference id="st" version="1"/><egi:refillPointStatus><egi:reference id="p0" version="1"/><egi:lastUpdated>2026-10-17T07:00:00Z</egi:lastUpdated><egi:status>constructor</egi:status></egi:refillPointStatus></egi:energyInfrastructureStationStatus></egi:energyInfrastructureSiteStatus></d2:payload>`,
    );
    const { out, skipped } = parse("datex2", "es-dgt-charging", {
      main: [table],
      status: [status],
    });
    expect(out.features).toHaveLength(1);
    expect(out.observations).toEqual([]);
    const connector = (out.features[0]!["components"] as { kind: string; details: object }[]).find(
      (c) => c.kind === "connector",
    );
    expect(connector?.details).toMatchObject({ standard: "UNKNOWN" });
    expect(connector?.details).not.toHaveProperty("chargingModes");
    // Method, connector type, charging mode, energy source, and the status twice:
    // the status publication's and the reading's.
    expect(skipped).toEqual({ unknown_value: 5 });
  });

  test("IRVE: an occupancy named like an inherited property is no status", () => {
    const header =
      "id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage,etat_prise_type_2,etat_prise_type_combo_ccs,etat_prise_type_chademo,etat_prise_type_ef";
    const main = Buffer.from(
      'id_station_itinerance,id_pdc_itinerance,coordonneesXY,nom_operateur,prise_type_2\nFRA68P68021001,FRA68E680210015,"[7.48,48.34]",Op,true\n',
    );
    const { out, skipped } = parse("irve", "fr-irve-charging", {
      main: [main],
      status: [Buffer.from(`${header}\nFRA68E680210015,,constructor,2026-10-17T07:00:00Z,,,,\n`)],
    });
    expect(out.observations[0]?.["result"]).toMatchObject({ value: "unknown" });
    expect(skipped).toEqual({ unknown_value: 1 });
  });

  test("OCPI", () => {
    const location = {
      country_code: "NL",
      party_id: "ABC",
      id: "L1",
      coordinates: { latitude: "52.000000", longitude: "5.000000" },
      facilities: ["constructor"],
      parking_type: "toString",
      images: [{ url: "https://example.org/a.jpg", category: "__proto__", type: "jpeg" }],
      energy_mix: {
        is_green_energy: false,
        energy_sources: [{ source: "constructor", percentage: 10 }],
      },
      evses: [
        {
          uid: "E1",
          status: "constructor",
          status_schedule: [{ period_begin: "2026-11-01T00:00:00Z", status: "toString" }],
          connectors: [{ id: "1", standard: "constructor" }],
        },
      ],
    };
    const tariff = {
      id: "T1",
      currency: "EUR",
      type: "constructor",
      elements: [
        {
          price_components: [
            { type: "toString", price: 1 },
            { type: "ENERGY", price: 0.3 },
          ],
        },
      ],
    };
    const { out, skipped } = parse("ocpi", "nl-ndw-charging", {
      main: [
        json([
          {
            ...location,
            evses: [
              {
                ...location.evses[0],
                connectors: [{ id: "1", standard: "constructor", tariff_ids: ["T1"] }],
              },
            ],
          },
        ]),
      ],
      tariffs: [json([tariff])],
    });
    expect(out.features).toHaveLength(1);
    expect(out.observations).toEqual([]);
    expect(out.features[0]).not.toHaveProperty("amenities");
    expect(out.features[0]).not.toHaveProperty("images");
    expect(out.offers[0]).not.toHaveProperty("tariffType");
    // Facility, parking type, image category, energy source, status, scheduled
    // status, standard, tariff type and price component.
    expect(skipped).toEqual({ unknown_value: 9 });
  });
});
