import {
  assertCovered,
  type CoverageSpec,
  definitionEnum,
  parseYaml,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { OCPI_2_2_1, OCPI_2_3_0 } from "@openconditions/conformance/standards/ocpi";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, ocpiFixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

type Json = Record<string, unknown>;
type Version = "2.2.1" | "2.3.0";

const FEED_ID = "nl-ndw-charging";
const FETCHED = "2026-10-17T08:00:00Z";
const format = chargingDomain.formats["ocpi"]!;

const connector = (over: Json = {}): Json => ({
  id: "1",
  standard: "IEC_62196_T2",
  format: "SOCKET",
  power_type: "AC_3_PHASE",
  max_voltage: 230,
  max_amperage: 32,
  tariff_ids: ["T1"],
  last_updated: FETCHED,
  ...over,
});
const evse = (over: Json = {}): Json => ({
  uid: "E1",
  evse_id: "NL*ABC*E1",
  status: "AVAILABLE",
  connectors: [connector()],
  last_updated: FETCHED,
  ...over,
});
const location = (over: Json = {}): Json => ({
  country_code: "NL",
  party_id: "ABC",
  id: "L1",
  publish: true,
  address: "Street 1",
  city: "Town",
  country: "NLD",
  coordinates: { latitude: "52.000000", longitude: "5.000000" },
  time_zone: "Europe/Amsterdam",
  evses: [evse()],
  last_updated: FETCHED,
  ...over,
});
const tariff = (over: Json = {}): Json => ({
  country_code: "NL",
  party_id: "ABC",
  id: "T1",
  currency: "EUR",
  elements: [{ price_components: [{ type: "ENERGY", price: 0.3, step_size: 1 }] }],
  last_updated: FETCHED,
  ...over,
});

const body = (value: unknown) => Buffer.from(JSON.stringify(value));

/** The real OCPI format over the payloads; every record it writes must seal. */
function parse(payloads: FeedPayloads): ParseOutput {
  const out = format.parse(catalogFeed(FEED_ID), payloads, parseContext(FETCHED));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}
const parseOne = (loc: Json, tariffs?: Json[]) =>
  parse({ main: [body([loc])], ...(tariffs === undefined ? {} : { tariffs: [body(tariffs)] }) });

type Component = { key: string; kind: string; lifecycle?: string; details: Json };
const site = (out: ParseOutput) => out.features[0] as RecordDraft;
const componentsOf = (out: ParseOutput, kind: string) =>
  ((site(out)?.["components"] ?? []) as Component[]).filter((c) => c.kind === kind);
const evseNamed = (out: ParseOutput, key: string) =>
  componentsOf(out, "evse").find((c) => c.key === key);
const details = (record: unknown) => ((record as Json | undefined)?.["details"] ?? {}) as Json;
const offer = (out: ParseOutput) => out.offers[0] as Json | undefined;
const firstElement = (out: ParseOutput) =>
  ((offer(out)?.["elements"] ?? []) as Json[])[0] as Json | undefined;

/** Whether `value`, or its lower-case form, is a string anywhere in the records. */
function written(records: readonly unknown[], value: string): boolean {
  const seek = (node: unknown): boolean =>
    typeof node === "string"
      ? node === value || node === value.toLowerCase()
      : typeof node === "object" && node !== null && Object.values(node).some(seek);
  return records.some(seek);
}
const anywhere = (out: ParseOutput, value: string) =>
  written([...out.features, ...out.observations, ...out.offers], value);

/** What OCPI says each EVSE status means, as the model holds it. */
const STATUS_MEANS: Readonly<Record<string, string>> = {
  AVAILABLE: "available",
  BLOCKED: "blocked",
  CHARGING: "charging",
  INOPERATIVE: "inoperative",
  OUTOFORDER: "out_of_order",
  RESERVED: "reserved",
  UNKNOWN: "unknown",
};

/** OCPI facilities as the shared amenity vocabulary names them. */
const FACILITY_MEANS: Readonly<Record<string, string>> = {
  HOTEL: "hotel",
  RESTAURANT: "restaurant",
  CAFE: "cafe",
  MALL: "mall",
  SUPERMARKET: "supermarket",
  SPORT: "sport",
  RECREATION_AREA: "recreation_area",
  NATURE: "nature",
  MUSEUM: "museum",
  BIKE_SHARING: "bike_sharing",
  BUS_STOP: "bus_stop",
  TAXI_STAND: "taxi_stand",
  TRAM_STOP: "tram_stop",
  METRO_STATION: "metro_station",
  TRAIN_STATION: "train_station",
  AIRPORT: "airport",
  // "Parking lot": a car park, the kind of place the amenity names.
  PARKING_LOT: "parking",
  CARPOOL_PARKING: "carpool_parking",
  FUEL_STATION: "petrol_station",
  WIFI: "wifi",
};

const DIMENSION_MEANS: Readonly<Record<string, [type: string, unit?: string]>> = {
  ENERGY: ["energy", "kW.h"],
  FLAT: ["flat"],
  PARKING_TIME: ["parking_time", "h"],
  TIME: ["time", "h"],
};

const TARIFF_TYPE_MEANS: Readonly<Record<string, string>> = {
  AD_HOC_PAYMENT: "ad_hoc",
  PROFILE_CHEAP: "profile_cheap",
  PROFILE_FAST: "profile_fast",
  PROFILE_GREEN: "profile_green",
  REGULAR: "regular",
};

const DAY_MEANS: Readonly<Record<string, string>> = {
  MONDAY: "MO",
  TUESDAY: "TU",
  WEDNESDAY: "WE",
  THURSDAY: "TH",
  FRIDAY: "FR",
  SATURDAY: "SA",
  SUNDAY: "SU",
};

/** A site with a tariff whose single element carries `restrictions`. */
const restricted = (restrictions: Json) =>
  parseOne(location(), [
    tariff({
      elements: [
        { price_components: [{ type: "ENERGY", price: 0.3, step_size: 1 }], restrictions },
      ],
    }),
  ]);

/** Each enumeration's coverage, proven by parsing a minimal record that carries the value. */
const COVERAGE: Readonly<Record<string, CoverageSpec & { module: string; since?: Version }>> = {
  Status: {
    module: "locations",
    handled: (value) => {
      const out = parseOne(
        location({ evses: [evse({ uid: "E0", evse_id: "NL*ABC*E0" }), evse({ status: value })] }),
      );
      if (value === "REMOVED") return evseNamed(out, "E1") === undefined;
      if (value === "PLANNED") {
        return evseNamed(out, "E1")?.lifecycle === "planned" && !readingOf(out, "E1");
      }
      return STATUS_MEANS[value] !== undefined && readingOf(out, "E1") === STATUS_MEANS[value];
    },
  },
  Capability: {
    module: "locations",
    handled: (value) => {
      const out = parseOne(location({ evses: [evse({ capabilities: [value] })] }));
      return equal(details(evseNamed(out, "E1"))["capabilities"], [value]);
    },
  },
  ConnectorType: {
    module: "locations",
    handled: (value) => {
      const out = parseOne(
        location({ evses: [evse({ connectors: [connector({ standard: value })] })] }),
      );
      return details(componentsOf(out, "connector")[0])["standard"] === value;
    },
  },
  ConnectorFormat: {
    module: "locations",
    handled: (value) => {
      const out = parseOne(
        location({ evses: [evse({ connectors: [connector({ format: value })] })] }),
      );
      return details(componentsOf(out, "connector")[0])["format"] === value.toLowerCase();
    },
  },
  PowerType: {
    module: "locations",
    handled: (value) => {
      const out = parseOne(
        location({ evses: [evse({ connectors: [connector({ power_type: value })] })] }),
      );
      return details(componentsOf(out, "connector")[0])["powerType"] === value;
    },
  },
  ParkingRestriction: {
    module: "locations",
    handled: (value) => {
      const out = parseOne(location({ evses: [evse({ parking_restrictions: [value] })] }));
      return equal(details(evseNamed(out, "E1"))["parkingRestrictions"], [value.toLowerCase()]);
    },
    unsupported: {
      EMPLOYEES:
        "2.3.0: the EVSE model's parkingRestrictions enumeration has no value for it yet; left out and skipped as unknown_value",
      TAXIS: "2.3.0: as EMPLOYEES",
      TENANTS: "2.3.0: as EMPLOYEES",
    },
  },
  ParkingType: {
    module: "locations",
    handled: (value) =>
      details(site(parseOne(location({ parking_type: value }))))["parkingType"] ===
      value.toLowerCase(),
  },
  Facility: {
    module: "locations",
    handled: (value) =>
      FACILITY_MEANS[value] !== undefined &&
      equal(site(parseOne(location({ facilities: [value] })))["amenities"], [
        FACILITY_MEANS[value],
      ]),
  },
  EnergySourceCategory: {
    module: "locations",
    handled: (value) => {
      const out = parseOne(location(), [
        tariff({
          energy_mix: {
            is_green_energy: false,
            energy_sources: [{ source: value, percentage: 100 }],
          },
        }),
      ]);
      return equal(offer(out)?.["energyMix"], {
        isGreen: false,
        sources: [{ source: value.toLowerCase(), pct: 100 }],
      });
    },
  },
  EnvironmentalImpactCategory: {
    module: "locations",
    handled: (value) =>
      anywhere(
        parseOne(location(), [
          tariff({
            energy_mix: { is_green_energy: true, environ_impact: [{ category: value, amount: 1 }] },
          }),
        ]),
        value,
      ),
    unsupported: {
      NUCLEAR_WASTE:
        "the energy mix model holds sources and their shares, no environmental impact amounts; skipped as unknown_value",
      CARBON_DIOXIDE: "as NUCLEAR_WASTE",
    },
  },
  ImageCategory: {
    module: "components",
    handled: (value) => {
      const image = { url: "https://example.org/a.jpg", category: value, type: "jpeg" };
      const out = parseOne(location({ images: [image], evses: [evse({ images: [image] })] }));
      return site(out)["images"] !== undefined;
    },
    unsupported: Object.fromEntries(
      ["CHARGER", "ENTRANCE", "LOCATION", "NETWORK", "OPERATOR", "OTHER", "OWNER"].map((c) => [
        c,
        "the mapping reads no images: the site input (site.ts) takes none and the colocation merge keeps only its lead's",
      ]),
    ),
  },
  ConnectorCapability: {
    module: "locations",
    since: "2.3.0",
    handled: (value) => {
      const out = parseOne(
        location({ evses: [evse({ connectors: [connector({ capabilities: [value] })] })] }),
      );
      const access = (site(out)["access"] ?? {}) as Json;
      return equal(access["authentication"], ["plug_and_charge"]);
    },
  },
  VehicleType: {
    module: "locations",
    since: "2.3.0",
    handled: (value) =>
      anywhere(
        parseOne(
          location({
            parking_places: [
              {
                id: "P1",
                vehicle_types: [value],
                restricted_to_type: true,
                reservation_required: false,
              },
            ],
          }),
        ),
        value,
      ),
    unsupported: Object.fromEntries(
      [
        "MOTORCYCLE",
        "PERSONAL_VEHICLE",
        "PERSONAL_VEHICLE_WITH_TRAILER",
        "VAN",
        "SEMI_TRACTOR",
        "RIGID",
        "TRUCK_WITH_TRAILER",
        "BUS",
        "DISABLED",
      ].map((v) => [
        v,
        "2.3.0 parking_places: the charging site has no parking-place component to hold them",
      ]),
    ),
  },
  ParkingDirection: {
    module: "locations",
    since: "2.3.0",
    handled: (value) =>
      anywhere(
        parseOne(
          location({
            parking_places: [
              {
                id: "P1",
                vehicle_types: ["PERSONAL_VEHICLE"],
                restricted_to_type: false,
                reservation_required: false,
                direction: value,
              },
            ],
          }),
        ),
        value,
      ),
    unsupported: Object.fromEntries(
      ["PARALLEL", "PERPENDICULAR", "ANGLE"].map((v) => [
        v,
        "2.3.0 parking_places: as VehicleType",
      ]),
    ),
  },
  EVSEPosition: {
    module: "locations",
    since: "2.3.0",
    handled: (value) =>
      anywhere(
        parseOne(
          location({ evses: [evse({ parking: [{ parking_id: "P1", evse_position: value }] })] }),
        ),
        value,
      ),
    unsupported: Object.fromEntries(
      ["LEFT", "RIGHT", "CENTER"].map((v) => [
        v,
        "2.3.0 EVSE parking: an EVSE's place beside a parking place the site does not hold",
      ]),
    ),
  },
  TariffDimensionType: {
    module: "tariffs",
    handled: (value) => {
      const out = parseOne(location(), [
        tariff({ elements: [{ price_components: [{ type: value, price: 0.5, step_size: 1 }] }] }),
      ]);
      const [type, unit] = DIMENSION_MEANS[value] ?? [];
      const component = ((firstElement(out)?.["components"] ?? []) as Json[])[0];
      return type !== undefined && component?.["type"] === type && component?.["unit"] === unit;
    },
  },
  TariffType: {
    module: "tariffs",
    handled: (value) =>
      TARIFF_TYPE_MEANS[value] !== undefined &&
      offer(parseOne(location(), [tariff({ type: value })]))?.["tariffType"] ===
        TARIFF_TYPE_MEANS[value],
  },
  DayOfWeek: {
    module: "tariffs",
    handled: (value) =>
      DAY_MEANS[value] !== undefined &&
      equal(
        ((firstElement(restricted({ day_of_week: [value] }))?.["restrictions"] ?? {}) as Json)[
          "days"
        ],
        [DAY_MEANS[value]],
      ),
  },
  ReservationRestrictionType: {
    module: "tariffs",
    handled: (value) =>
      ((firstElement(restricted({ reservation: value }))?.["restrictions"] ?? {}) as Json)[
        "reservation"
      ] === value.toLowerCase(),
  },
  BookingRestrictionType: {
    module: "tariffs",
    since: "2.3.0",
    handled: (value) => anywhere(restricted({ booking: value }), value),
    unsupported: Object.fromEntries(
      ["BOOKING", "BOOKING_EXPIRES", "BOOKING_CANCELLATION_FEES", "BOOKING_OVERTIME"].map((v) => [
        v,
        "2.3.0 Bookings: the offer's restrictions have no booking condition; an element priced for a booking never prices a session without one, so it is left out and skipped as unknown_value",
      ]),
    ),
  },
  TaxIncluded: {
    module: "tariffs",
    since: "2.3.0",
    handled: (value) => {
      const out = parseOne(location(), [tariff({ tax_included: value })]);
      const expected = { YES: true, NO: false, "N/A": undefined }[value as "YES" | "NO" | "N/A"];
      return (
        offer(out) !== undefined &&
        offer(out)?.["priceIncludesVat"] === expected &&
        value in { YES: 1, NO: 1, "N/A": 1 }
      );
    },
  },
};

function readingOf(out: ParseOutput, evseKey: string): string | undefined {
  const reading = out.observations.find(
    (o) => (o["subject"] as { componentKey?: string }).componentKey === evseKey,
  );
  return (reading?.["result"] as { value?: string } | undefined)?.value;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe("OCPI enumerations, each handled by the real decoder and mapping or listed as unsupported", () => {
  const docs = new Map<Version, Map<string, unknown>>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    for (const [version, set] of [
      ["2.2.1", OCPI_2_2_1],
      ["2.3.0", OCPI_2_3_0],
    ] as const) {
      const pinned = await pinnedOrUnavailable(set);
      if ("unavailable" in pinned) {
        unavailable = pinned.unavailable;
        return;
      }
      docs.set(
        version,
        new Map(
          pinned.files.map((f) => [
            f.fileName === "components/schema.yaml" ? "components" : f.fileName.split("/")[1]!,
            parseYaml(f.contents),
          ]),
        ),
      );
    }
  }, 120_000);

  beforeEach(() => {
    __resetSkips();
  });

  for (const version of ["2.2.1", "2.3.0"] as const) {
    for (const [name, { module, since, ...spec }] of Object.entries(COVERAGE)) {
      if (since === "2.3.0" && version === "2.2.1") continue;
      test(`${version} ${name}`, ({ skip }) => {
        if (unavailable) skip(unavailable);
        const values = definitionEnum(docs.get(version)!.get(module), name);
        // A value 2.3.0 adds is listed as unsupported only where that version defines it.
        const unsupported = Object.fromEntries(
          Object.entries(spec.unsupported ?? {}).filter(([v]) => values.includes(v)),
        );
        assertCovered(`OCPI ${version} ${name}`, values, { handled: spec.handled, unsupported });
      });
    }
  }

  test("no predicate holds for a value OCPI does not define, so each can fail", () => {
    // EVSE capabilities are OCPI's codes kept as written: 2.3.0 makes Capability
    // an OpenEnum, whose further values a publisher may use, and the model
    // holds them as written.
    for (const [name, { handled }] of Object.entries(COVERAGE)) {
      if (name === "Capability") continue;
      expect([name, (handled as (value: string) => boolean)("X_NOT_OCPI")]).toEqual([name, false]);
    }
  });
});

describe("OCPI skips by reason", () => {
  beforeEach(() => {
    __resetSkips();
  });

  test("records the decoder refuses are skipped under its reason, not counted as rejected", () => {
    const out = parse({
      main: [
        body([
          location(),
          location({ id: "L2", coordinates: { latitude: "", longitude: "" } }),
          location({ id: undefined }),
          "not a location",
          location({ id: "L3", evses: [evse({ connectors: [{ standard: "IEC_62196_T2" }] })] }),
        ]),
      ],
      tariffs: [
        body([tariff(), tariff({ id: "T2", currency: undefined }), tariff({ id: undefined })]),
      ],
    });
    expect(out.features).toHaveLength(1);
    expect(out.rejected).toBe(0);
    // No coordinates; no id, no object, a connector without id; two tariffs without currency or id.
    expect(drainSkipped(FEED_ID)).toEqual({ no_geometry: 1, malformed: 5 });
  });

  test("every value OCPI does not define is left out of a kept site and counted once", () => {
    const out = parseOne(
      location({
        parking_type: "ROOFTOP",
        facilities: ["SPA", "CAFE"],
        evses: [
          evse({
            status: "BROKEN",
            parking_restrictions: ["TAXIS", "EV_ONLY"],
            connectors: [
              connector({
                standard: "X_MEGAPLUG",
                format: "WIRELESS",
                power_type: "AC_4_PHASE",
                capabilities: ["ISO_15118_20_PLUG_AND_CHARGE", "X_AUTOCHARGE"],
              }),
            ],
          }),
        ],
      }),
    );
    expect(out.features).toHaveLength(1);
    expect(site(out)["amenities"]).toEqual(["cafe"]);
    expect(details(evseNamed(out, "E1"))["parkingRestrictions"]).toEqual(["ev_only"]);
    expect(details(componentsOf(out, "connector")[0])).toMatchObject({ standard: "UNKNOWN" });
    expect(readingOf(out, "E1")).toBeUndefined();
    // Parking type, facility, status, restriction, standard, format, power type, capability.
    expect(drainSkipped(FEED_ID)).toEqual({ unknown_value: 8 });
  });

  test("a tariff's unread values count once however many sites name it", () => {
    const shared = tariff({
      type: "PROFILE_X",
      tax_included: "MAYBE",
      energy_mix: {
        is_green_energy: true,
        energy_sources: [
          { source: "SOLAR", percentage: 60 },
          { source: "BIOMASS", percentage: 40 },
        ],
        environ_impact: [{ category: "CARBON_DIOXIDE", amount: 12 }],
      },
      elements: [
        {
          price_components: [
            { type: "ENERGY", price: 0.3, step_size: 1 },
            { type: "CO2", price: 1, step_size: 1 },
          ],
        },
        {
          price_components: [{ type: "FLAT", price: 5, step_size: 1 }],
          restrictions: { booking: "BOOKING" },
        },
      ],
    });
    const out = parse({
      main: [
        body([
          location(),
          location({ id: "L2", coordinates: { latitude: "53.000000", longitude: "6.000000" } }),
        ]),
      ],
      tariffs: [body([shared])],
    });
    expect(out.offers).toHaveLength(2);
    expect(out.offers[0]).toMatchObject({
      elements: [{ components: [{ type: "energy" }] }],
      energyMix: { isGreen: true, sources: [{ source: "solar", pct: 60 }] },
    });
    expect(out.offers[0]).not.toHaveProperty("tariffType");
    expect(out.offers[0]).not.toHaveProperty("priceIncludesVat");
    // Type, tax_included, the CO2 component, the booking element, BIOMASS, the impact.
    expect(drainSkipped(FEED_ID)).toEqual({ unknown_value: 6 });
  });

  test("status entries without a uid or status are malformed; an undefined status is an unread value", () => {
    const feed = catalogFeed(FEED_ID);
    const full = parse({
      main: [
        body([
          location({ evses: [evse({ uid: "E1" }), evse({ uid: "E2", evse_id: "NL*ABC*E2" })] }),
        ]),
      ],
    });
    expect(drainSkipped(FEED_ID)).toEqual({});
    const out = format.parseStatus!(
      feed,
      {
        status: [
          body({
            data: [
              { uid: "E1", status: "CHARGING", last_updated: FETCHED },
              { uid: "E2", status: "HALF_BROKEN", last_updated: FETCHED },
              { uid: "E3" },
              { status: "AVAILABLE" },
            ],
          }),
        ],
      },
      parseContext(FETCHED),
      full.statusIndex!,
    );
    expect(out.observations).toHaveLength(1);
    expect(drainSkipped(FEED_ID)).toEqual({ malformed: 2, unknown_value: 1 });
  });

  test.for([
    ["nl-ndw-charging", ["ndw-locations.json"], ["ndw-tariffs.json"], {}],
    ["lt-vialietuva-charging", ["lt-locations.json"], ["lt-tariffs.json"], {}],
    ["de-bw-mobidata-charging", ["ocpdb-locations.json"], ["ocpdb-tariffs.json"], {}],
  ] as const)(
    "the %s captures skip exactly what they should",
    ([feedId, main, tariffs, expected]) => {
      const out = format.parse(
        catalogFeed(feedId),
        { main: main.map(ocpiFixture), tariffs: tariffs.map(ocpiFixture) },
        parseContext(FETCHED),
      );
      expect(out.features.length).toBeGreaterThan(0);
      expect(drainSkipped(feedId)).toEqual(expected);
    },
  );
});
