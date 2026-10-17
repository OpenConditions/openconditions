import {
  assertCovered,
  pinnedOrUnavailable,
  type XsdEnumeration,
  xsdComplexTypes,
  xsdEnumeration,
  xsdEnumerations,
  xsdSubtypes,
} from "@openconditions/conformance";
import { DATEX2_V3 } from "@openconditions/conformance/standards/datex2-v3";
import {
  __resetSkips,
  drainSkipped,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * The DATEX II v3.7 energy infrastructure vocabularies, both the energy
 * infrastructure namespace and the AFIR profile, held to what the charging
 * parser makes of each value: every value is shown read into the model as
 * the standard defines it, by parsing a minimal publication carrying it, or
 * is listed with the reason it is not.
 */

const FETCHED = "2026-10-06T03:00:00Z";
const FEED = "es-dgt-charging";
const EGI = "http://datex2.eu/schema/3/energyInfrastructure";
const AFIR = "http://datex2.eu/schema/3/afirEnergyInfrastructure";
type Namespace = typeof EGI | typeof AFIR;
const NAMESPACES: [label: string, ns: Namespace][] = [
  ["energyInfrastructure", EGI],
  ["afirEnergyInfrastructure", AFIR],
];

interface PointSpec {
  type?: string;
  inner?: string;
}

interface SiteSpec {
  ns: Namespace;
  site?: string;
  station?: string;
  points?: PointSpec[];
  point?: boolean;
}

const POINT = `<locationReference><pointByCoordinates><pointCoordinates><latitude>48.1</latitude><longitude>11.5</longitude></pointCoordinates></pointByCoordinates></locationReference>`;

/** A table of one site, station and its refill points, in the given namespace. */
function table({ ns, site = "", station = "", points = [{}], point = true }: SiteSpec): Buffer {
  const refill = points
    .map(
      (p, i) =>
        `<egi:refillPoint xsi:type="egi:${p.type ?? "ElectricChargingPoint"}" id="p${i}" version="1">${p.inner ?? ""}</egi:refillPoint>`,
    )
    .join("");
  return Buffer.from(
    `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:egi="${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="egi:EnergyInfrastructureTablePublication" lang="en" modelBaseVersion="3"><egi:energyInfrastructureTable id="t" version="1"><egi:energyInfrastructureSite id="s" version="1">${point ? POINT : ""}${site}<egi:energyInfrastructureStation id="st" version="1">${station}${refill}</egi:energyInfrastructureStation></egi:energyInfrastructureSite></egi:energyInfrastructureTable></d2:payload>`,
  );
}

function statusOf(ns: Namespace, value: string): Buffer {
  return Buffer.from(
    `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:egi="${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="egi:EnergyInfrastructureStatusPublication" lang="en" modelBaseVersion="3"><egi:energyInfrastructureSiteStatus><egi:reference id="s" version="1"/><egi:energyInfrastructureStationStatus><egi:reference id="st" version="1"/><egi:refillPointStatus><egi:reference id="p0" version="1"/><egi:lastUpdated>2026-10-06T02:00:00Z</egi:lastUpdated><egi:status>${value}</egi:status></egi:refillPointStatus></egi:energyInfrastructureStationStatus></egi:energyInfrastructureSiteStatus></d2:payload>`,
  );
}

function parse(main: Buffer, status?: Buffer): ParseOutput {
  const out = chargingDomain.formats["datex2"]!.parse(
    catalogFeed(FEED),
    { main: [main], ...(status === undefined ? {} : { status: [status] }) },
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = { key: string; kind: string; details: Record<string, unknown> };
const components = (f: RecordDraft | undefined) => (f?.["components"] ?? []) as Component[];
const connector = (out: ParseOutput) =>
  components(out.features[0]).find((c) => c.kind === "connector")?.details;
const access = (out: ParseOutput) =>
  (out.features[0]?.["access"] ?? {}) as { authentication?: string[]; payment?: string[] };
const offerElements = (out: ParseOutput) =>
  out.offers.map((o) => o["elements"]) as {
    components: { type: string; price: { amount: string } }[];
    restrictions?: Record<string, unknown>;
  }[][];

const connectorPoint = (ns: Namespace, connectorInner: string, pointInner = "") =>
  table({
    ns,
    points: [{ inner: `${pointInner}<egi:connector>${connectorInner}</egi:connector>` }],
  });

/** What each connector type is, by DATEX's definition, as an OCPI standard. */
const STANDARDS: Readonly<Record<string, string>> = {
  chademo: "CHADEMO",
  cee3: "IEC_60309_2_single_16",
  yazaki: "CHADEMO",
  ...Object.fromEntries(
    [..."ABCDEFGHIJKLMNO"].flatMap((l) => [
      [`domestic${l}`, `DOMESTIC_${l}`],
      [`domestic${l}Type`, `DOMESTIC_${l}`],
    ]),
  ),
  iec60309x2single16: "IEC_60309_2_single_16",
  iec60309x2three16: "IEC_60309_2_three_16",
  iec60309x2three32: "IEC_60309_2_three_32",
  iec60309x2three64: "IEC_60309_2_three_64",
  iec62196T1: "IEC_62196_T1",
  iec62196T1COMBO: "IEC_62196_T1_COMBO",
  iec62196T2: "IEC_62196_T2",
  iec62196T2COMBO: "IEC_62196_T2_COMBO",
  iec62196T3A: "IEC_62196_T3A",
  iec62196T3C: "IEC_62196_T3C",
  mcs: "MCS",
  pantographBottomUp: "PANTOGRAPH_BOTTOM_UP",
  pantographTopDown: "PANTOGRAPH_TOP_DOWN",
  // "Modification of the Type 2 connector": a Type 2 plug fits it.
  teslaConnectorEurope: "IEC_62196_T2",
  // Tesla's American connector is the oval Model S plug.
  teslaConnectorAmerica: "TESLA_S",
  teslaR: "TESLA_R",
  teslaS: "TESLA_S",
  // "CEE5, 400 V, 16-63 A": OCPI names the three-phase IEC 60309 plugs by
  // current, which the connector's 32 A maximum says.
  cee5: "IEC_60309_2_three_32",
  // "A domestic socket of unspecified type" and "other charging interface"
  // name no standard: the connector's standard is unknown.
  domestic: "UNKNOWN",
  other: "UNKNOWN",
};

const EXTENDED =
  "the schema's escape hatch for national extensions; the meaning is in `_extendedValue`";

const CONNECTOR_UNSUPPORTED = { _extended: EXTENDED };

const CHARGING_MODES: Readonly<Record<string, string>> = {
  mode1AC1p: "AC_1_PHASE",
  mode1AC3p: "AC_3_PHASE",
  mode2AC1p: "AC_1_PHASE",
  mode2AC3p: "AC_3_PHASE",
  mode3AC3p: "AC_3_PHASE",
  mode4DC: "DC",
};

const CHARGING_MODES_UNSUPPORTED = {
  legacyInductive:
    "inductive charging names no power type and no IEC 61851-1 conductive mode, which is all the connector's charging modes hold",
  ccs: '"AC and DC are used simultaneously": no one power type, and no IEC 61851-1 mode',
  other: "names no power type or mode",
  unknown: "names no power type or mode",
  _extended: EXTENDED,
};

/** The EVSE status each refill point status reads as, by its definition. */
const STATUSES: Readonly<Record<string, string>> = {
  available: "available",
  blocked: "blocked",
  charging: "charging",
  faulted: "out_of_order",
  inoperative: "inoperative",
  occupied: "occupied",
  outOfOrder: "out_of_order",
  outOfStock: "out_of_order",
  reserved: "reserved",
  unavailable: "inoperative",
  unknown: "unknown",
};

const AUTHENTICATION: Readonly<Record<string, string>> = {
  activeRFIDChip: "rfid",
  apps: "app",
  calypso: "rfid",
  creditCard: "credit_card",
  debitCard: "debit_card",
  mifareClassic: "rfid",
  mifareDesfire: "rfid",
  nfc: "nfc",
  phoneDialog: "remote",
  phoneSMS: "remote",
  plc: "plug_and_charge",
  // "Over the air according to ISO 15118-2 and -20": its contract authentication.
  overTheAir: "plug_and_charge",
  pinpad: "pin",
  rfid: "rfid",
  website: "remote",
  unlimitedAccess: "none",
};

const AUTHENTICATION_UNSUPPORTED = { _extended: EXTENDED };

const PARKING_TYPES: Readonly<Record<string, string>> = {
  onstreet: "on_street",
  inBuilding: "parking_garage",
  openSpace: "parking_lot",
  other: "other",
};

const SITE_TYPES_UNSUPPORTED = {
  onCompanySite:
    "says whose ground the site is on: neither how vehicles stand there nor who may charge, as a company may open its ground to the public",
  _extended: EXTENDED,
};

const rateTable = (policy: string, lines: string, unit = "kWh") =>
  `<egi:deliveryUnit>${unit}</egi:deliveryUnit><egi:connector><egi:connectorType>iec62196T2</egi:connectorType></egi:connector><fac:rates xmlns:fac="http://datex2.eu/schema/3/facilities" xsi:type="fac:RateTable"><fac:applicableCurrency>EUR</fac:applicableCurrency><fac:energyPricingPolicy><egi:pricingPolicy>${policy}</egi:pricingPolicy></fac:energyPricingPolicy><fac:rateLineCollection>${lines}</fac:rateLineCollection></fac:rates>`;

const rateLine = (type: string, value = "0.30", times = "") =>
  `<fac:rateLine><fac:rateLineType>${type}</fac:rateLineType>${times}<fac:value>${value}</fac:value></fac:rateLine>`;

/** An incrementing rate of `value` per 15 minutes. */
const incrementing = (value = "0.30") =>
  rateLine("incrementingRate", value, "<fac:incrementPeriod>PT15M</fac:incrementPeriod>");

const energyRate = (policy: string, prices: string) =>
  `<egi:connector><egi:connectorType>iec62196T2</egi:connectorType></egi:connector><egi:energyProduct><egi:energyRate><egi:ratePolicy>${policy}</egi:ratePolicy><egi:lastUpdated>2026-10-01T00:00:00Z</egi:lastUpdated><egi:applicableCurrency>EUR</egi:applicableCurrency>${prices}</egi:energyRate></egi:energyProduct>`;

const energyPrice = (type: string, value = "0.30", extra = "") =>
  `<egi:energyPrice><egi:priceGroupIndex>0</egi:priceGroupIndex><egi:priceType>${type}</egi:priceType><egi:value>${value}</egi:value>${extra}</egi:energyPrice>`;

/** The one element of the one offer, as `[type, amount]` pairs. */
function priced(out: ParseOutput): [string, string][] | undefined {
  const offers = offerElements(out);
  if (offers.length !== 1 || offers[0]!.length !== 1) return undefined;
  return offers[0]![0]!.components.map((c) => [c.type, c.price.amount]);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("DATEX II v3.7 energy infrastructure through the charging parser", () => {
  let enums: XsdEnumeration[] = [];
  let types: ReturnType<typeof xsdComplexTypes> = new Map();
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DATEX2_V3);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else {
      enums = xsdEnumerations(pinned.files);
      types = xsdComplexTypes(pinned.files);
    }
  }, 120_000);

  const values = (name: string, ns: string) => xsdEnumeration(enums, name, ns);

  describe.for(NAMESPACES)("%s", ([, ns]) => {
    test("connector types", ({ skip }) => {
      if (unavailable) skip(unavailable);
      assertCovered("ConnectorTypeEnum", values("ConnectorTypeEnum", ns), {
        handled: (v) => {
          __resetSkips();
          const read = connector(
            parse(
              connectorPoint(
                ns,
                `<egi:connectorType>${v}</egi:connectorType><egi:maximumCurrent>32</egi:maximumCurrent>`,
              ),
            ),
          );
          return (
            STANDARDS[v] !== undefined &&
            read?.["standard"] === STANDARDS[v] &&
            drainSkipped(FEED)["unknown_value"] === undefined
          );
        },
        unsupported: CONNECTOR_UNSUPPORTED,
      });
    });

    test("connector formats", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const formats: Record<string, string> = {
        cableMode2: "cable",
        cableMode3: "cable",
        otherCable: "cable",
        socket: "socket",
      };
      assertCovered("ConnectorFormatTypeEnum", values("ConnectorFormatTypeEnum", ns), {
        handled: (v) =>
          formats[v] !== undefined &&
          connector(
            parse(
              connectorPoint(
                ns,
                `<egi:connectorType>iec62196T2</egi:connectorType><egi:connectorFormat>${v}</egi:connectorFormat>`,
              ),
            ),
          )?.["format"] === formats[v],
        unsupported: { _extended: EXTENDED },
      });
    });

    test("charging modes, on the connector or (AFIR) on the point", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const mode = (v: string) => `<egi:chargingMode>${v}</egi:chargingMode>`;
      assertCovered("ChargingModeEnum", values("ChargingModeEnum", ns), {
        handled: (v) => {
          const doc =
            ns === AFIR
              ? connectorPoint(ns, "<egi:connectorType>iec62196T2</egi:connectorType>", mode(v))
              : connectorPoint(ns, `<egi:connectorType>iec62196T2</egi:connectorType>${mode(v)}`);
          const read = connector(parse(doc));
          return (
            read?.["powerType"] !== undefined &&
            read["powerType"] === CHARGING_MODES[v] &&
            JSON.stringify(read["chargingModes"]) === JSON.stringify([`mode${v[4]}`])
          );
        },
        unsupported: CHARGING_MODES_UNSUPPORTED,
      });
    });

    test("refill point statuses", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const doc = connectorPoint(ns, "<egi:connectorType>iec62196T2</egi:connectorType>");
      assertCovered("RefillPointStatusEnum", values("RefillPointStatusEnum", ns), {
        handled: (v) => {
          const out = parse(doc, statusOf(ns, v));
          if (v === "planned") {
            const evse = components(out.features[0]).find((c) => c.kind === "evse") as
              | (Component & { lifecycle?: string })
              | undefined;
            return evse?.lifecycle === "planned" && out.observations.length === 0;
          }
          // A removed point is no charge point, and a site of only that point no site.
          if (v === "removed") return out.features.length === 0;
          const read = out.observations.map((o) => (o["result"] as { value: string }).value);
          return same(read, [STATUSES[v]]);
        },
        unsupported: { _extended: EXTENDED },
      });
    });

    test("authentication and identification methods", ({ skip }) => {
      if (unavailable) skip(unavailable);
      assertCovered(
        "AuthenticationAndIdentificationEnum",
        values("AuthenticationAndIdentificationEnum", ns),
        {
          handled: (v) => {
            const out = parse(
              table({
                ns,
                station: `<egi:authenticationAndIdentificationMethods>${v}</egi:authenticationAndIdentificationMethods>`,
              }),
            );
            // Paying cash or by a prepaid card is no identification: it is read as how one pays.
            if (v === "cashPayment") return same(access(out).payment, ["cash"]);
            if (v === "prepaidCard") return same(access(out).payment, ["prepaid_card"]);
            // "No access granted": the site is not the public's.
            if (v === "noAccess") {
              return (out.features[0]?.["access"] as { audience?: string })?.audience === "private";
            }
            return (
              AUTHENTICATION[v] !== undefined &&
              same(access(out).authentication, [AUTHENTICATION[v]])
            );
          },
          unsupported: AUTHENTICATION_UNSUPPORTED,
        },
      );
    });

    test("site types", ({ skip }) => {
      if (unavailable) skip(unavailable);
      assertCovered(
        "EnergyInfrastructureSiteTypeEnum",
        values("EnergyInfrastructureSiteTypeEnum", ns),
        {
          handled: (v) => {
            const details = parse(table({ ns, site: `<egi:typeOfSite>${v}</egi:typeOfSite>` }))
              .features[0]?.["details"] as { parkingType?: string; roofed?: boolean } | undefined;
            // "The site has got a roof": a roof, not where vehicles stand.
            if (v === "roofedStation") {
              return details?.roofed === true && details.parkingType === undefined;
            }
            return PARKING_TYPES[v] !== undefined && details?.parkingType === PARKING_TYPES[v];
          },
          unsupported: Object.fromEntries(
            Object.entries(SITE_TYPES_UNSUPPORTED).filter(
              ([v]) => v !== "roofedStation" || ns === EGI,
            ),
          ),
        },
      );
    });

    test("refill point types", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const fuel = "a fuel refill point: the charging parser reads electric charging points only";
      assertCovered("RefillPoint", xsdSubtypes(types, `{${ns}}RefillPoint`), {
        handled: (v) =>
          components(parse(table({ ns, points: [{ type: v }, {}] })).features[0]).filter(
            (c) => c.kind === "evse",
          ).length === 2,
        unsupported: Object.fromEntries(
          xsdSubtypes(types, `{${ns}}RefillPoint`)
            .filter((v) => v !== "ElectricChargingPoint")
            .map((v) => [v, fuel]),
        ),
      });
    });

    test("rate line types of a rate table", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const expected: Record<string, [string, string][]> = {
        flatRate: [["flat", "0.3"]],
        // A flat charge of its tier, which the line's times bound.
        flatRateTier: [["flat", "0.3"]],
        // 0.30 for every 15 minutes is 1.20 an hour, billed by the quarter hour.
        incrementingRate: [["time", "1.2"]],
        perUnit: [["energy", "0.3"]],
      };
      const facilities = ns === AFIR ? "afirFacilities" : "facilities";
      assertCovered(
        "RateLineTypeEnum",
        values("RateLineTypeEnum", `http://datex2.eu/schema/3/${facilities}`),
        {
          handled: (v) =>
            expected[v] !== undefined &&
            same(
              priced(
                parse(
                  table({
                    ns,
                    points: [
                      {
                        inner: rateTable(
                          "pricePerDeliveryUnit",
                          v === "incrementingRate" ? incrementing() : rateLine(v),
                        ),
                      },
                    ],
                  }),
                ),
              ),
              expected[v],
            ),
          unsupported: { _extended: EXTENDED },
        },
      );
    });

    test("delivery units of a per-unit price", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const notElectric = "no unit of electric energy: a per-unit price in it is no charging price";
      assertCovered("DeliveryUnitEnum", values("DeliveryUnitEnum", ns), {
        handled: (v) =>
          same(
            priced(
              parse(
                table({
                  ns,
                  points: [{ inner: rateTable("pricePerDeliveryUnit", rateLine("perUnit"), v) }],
                }),
              ),
            ),
            [["energy", "0.3"]],
          ),
        unsupported: {
          litre: notElectric,
          kg: notElectric,
          m3: notElectric,
          imperialGallon: notElectric,
          usGallon: notElectric,
          gasGallonEquivalent: notElectric,
          _extended: EXTENDED,
        },
      });
    });
  });

  test("energy infrastructure pricing policies", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const cases: Record<string, [lines: string, expected: [string, string][]]> = {
      pricePerDeliveryUnit: [rateLine("perUnit"), [["energy", "0.3"]]],
      // "The charging time defines the price": a rate that increments with it.
      pricePerChargingTime: [incrementing(), [["time", "1.2"]]],
      flatRate: [rateLine("flatRate", "5"), [["flat", "5"]]],
      free: ["", [["flat", "0"]]],
    };
    assertCovered("PricingPolicyEnum", values("PricingPolicyEnum", EGI), {
      handled: (v) => {
        const [lines, expected] = cases[v] ?? [rateLine("perUnit"), [["energy", "0.3"]]];
        return same(
          priced(parse(table({ ns: EGI, points: [{ inner: rateTable(v, lines) }] }))),
          expected,
        );
      },
      unsupported: {
        contract: "a price a contract sets is no public price",
        unknown: "says nothing of what a per-unit price is per",
        other: "says nothing of what a per-unit price is per",
        _extended: EXTENDED,
      },
    });
  });

  test("AFIR price types, each its own element", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const expected: Record<string, [string, string][]> = {
      pricePerKWh: [["energy", "0.3"]],
      // OCPI's time price is per hour.
      pricePerMinute: [["time", "18"]],
      basePrice: [["flat", "0.3"]],
      flatRate: [["flat", "0.3"]],
      free: [["flat", "0"]],
    };
    assertCovered("PriceTypeEnum", values("PriceTypeEnum", AFIR), {
      handled: (v) =>
        expected[v] !== undefined &&
        same(
          priced(
            parse(table({ ns: AFIR, points: [{ inner: energyRate("adHoc", energyPrice(v)) }] })),
          ),
          expected[v],
        ),
      unsupported: {
        pricePerKg: "a price per kilogram of gas is no charging price",
        other: "another method of pricing, which says nothing of what is priced",
        _extended: EXTENDED,
      },
    });
  });

  test("AFIR rate policies", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("RatePolicyEnum", values("RatePolicyEnum", AFIR), {
      handled: (v) =>
        same(
          priced(
            parse(
              table({ ns: AFIR, points: [{ inner: energyRate(v, energyPrice("pricePerKWh")) }] }),
            ),
          ),
          [["energy", "0.3"]],
        ),
      unsupported: { contract: "a price a contract sets is no public price", _extended: EXTENDED },
    });
  });

  test("AFIR current types", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("CurrentTypeEnum", values("CurrentTypeEnum", AFIR), {
      handled: (v) => {
        const c = connector(
          parse(
            connectorPoint(
              AFIR,
              "<egi:connectorType>iec62196T2</egi:connectorType>",
              `<egi:currentType>${v}</egi:currentType>`,
            ),
          ),
        );
        return c?.["current"] === v && (v !== "dc" || c?.["powerType"] === "DC");
      },
      unsupported: { _extended: EXTENDED },
    });
  });
});

describe("DATEX energy prices as offers", () => {
  test("an AFIR price applying from a charging minute or kWh is restricted to it, its tax as stated", () => {
    const out = parse(
      table({
        ns: AFIR,
        points: [
          {
            inner: energyRate(
              "adHoc",
              energyPrice("pricePerKWh", "0.39", "<egi:taxIncluded>true</egi:taxIncluded>") +
                energyPrice(
                  "pricePerMinute",
                  "0.10",
                  "<egi:taxIncluded>true</egi:taxIncluded><egi:timeBasedApplicability><egi:fromMinute>60</egi:fromMinute></egi:timeBasedApplicability>",
                ),
            ),
          },
        ],
      }),
    );
    expect(out.offers).toHaveLength(1);
    expect(out.offers[0]).toMatchObject({
      priceIncludesVat: true,
      elements: [
        { components: [{ type: "energy", price: { amount: "0.39" } }] },
        {
          components: [{ type: "time", price: { amount: "6" } }],
          restrictions: { minDuration: { value: 3600, unit: "s" } },
        },
      ],
    });
  });

  test("a rate table's tiers are elements bounded by their times, the tiered first", () => {
    const lines = `<fac:rateLineCollection collectionSequence="1"><fac:relativeTimes>true</fac:relativeTimes>${rateLine("perUnit", "0.40")}${rateLine("flatRateTier", "2", "<fac:durationStart>02:00:00</fac:durationStart><fac:durationEnd>04:00:00</fac:durationEnd>")}</fac:rateLineCollection>`;
    const out = parse(
      table({
        ns: EGI,
        points: [
          {
            inner: `<egi:connector><egi:connectorType>iec62196T2</egi:connectorType></egi:connector><fac:rates xmlns:fac="http://datex2.eu/schema/3/facilities" xsi:type="fac:RateTable"><fac:applicableCurrency>EUR</fac:applicableCurrency>${lines}</fac:rates>`,
          },
        ],
      }),
    );
    expect(out.offers[0]?.["elements"]).toEqual([
      {
        components: [{ type: "flat", price: { amount: "2", currency: "EUR" } }],
        restrictions: {
          minDuration: { value: 7200, unit: "s" },
          maxDuration: { value: 14400, unit: "s" },
        },
      },
      {
        components: [{ type: "energy", price: { amount: "0.4", currency: "EUR" }, unit: "kW.h" }],
      },
    ]);
    // An incrementing rate is billed in steps of its period.
    const quarter = parse(
      table({ ns: EGI, points: [{ inner: rateTable("pricePerChargingTime", incrementing()) }] }),
    );
    expect(quarter.offers[0]?.["elements"]).toMatchObject([
      { components: [{ type: "time", price: { amount: "1.2" }, stepSize: 900, unit: "h" }] },
    ]);
    // Without a period it names no time, and the table no price.
    const bare = parse(
      table({
        ns: EGI,
        points: [{ inner: rateTable("pricePerChargingTime", rateLine("incrementingRate")) }],
      }),
    );
    expect(bare.offers).toEqual([]);
  });

  test("a point's energy mix, the site's brand and entrance", () => {
    const mix = `<egi:electricEnergyMix energyMixIndex="1"><egi:energyProductName><values><value lang="en">Green</value></values></egi:energyProductName><egi:isGreenEnergy>true</egi:isGreenEnergy><egi:carbonDioxideImpact>0</egi:carbonDioxideImpact><egi:nuclearWasteImpact>0.0001</egi:nuclearWasteImpact><egi:electricEnergySourceRatio><egi:energySource>wind</egi:energySource><egi:sourceRatioValue><percentage>60</percentage></egi:sourceRatioValue></egi:electricEnergySourceRatio><egi:electricEnergySourceRatio><egi:energySource>generalGreen</egi:energySource><egi:sourceRatioValue><percentage>40</percentage></egi:sourceRatioValue></egi:electricEnergySourceRatio></egi:electricEnergyMix>`;
    const out = parse(
      table({
        ns: EGI,
        site: `<egi:brand><values><value lang="en">Volt</value></values></egi:brand><egi:entrance><pointByCoordinates><pointCoordinates><latitude>48.1001</latitude><longitude>11.5001</longitude></pointCoordinates></pointByCoordinates></egi:entrance>`,
        points: [
          {
            inner: `<egi:connector><egi:connectorType>cee5</egi:connectorType></egi:connector>${mix}`,
          },
        ],
      }),
    );
    expect(out.features[0]?.["details"]).toMatchObject({
      brand: "Volt",
      entrance: { type: "Point", coordinates: [11.5001, 48.1001] },
      energyMix: {
        isGreen: true,
        productName: "Green",
        sources: [
          { source: "wind", pct: 60 },
          { source: "general_green", pct: 40 },
        ],
        impacts: [
          { category: "carbon_dioxide", gPerKwh: 0 },
          { category: "nuclear_waste", gPerKwh: 0.0001 },
        ],
      },
    });
    // CEE5 without its current names none of OCPI's IEC 60309 plugs.
    expect(connector(out)?.["standard"]).toBe("UNKNOWN");
  });

  test("a price for a period of its own, or one that cannot be priced, makes no offer", () => {
    const periodic = energyPrice(
      "pricePerKWh",
      "0.39",
      "<egi:overallPeriod><overallStartTime>2026-01-01T00:00:00Z</overallStartTime></egi:overallPeriod>",
    );
    expect(
      parse(table({ ns: AFIR, points: [{ inner: energyRate("adHoc", periodic) }] })).offers,
    ).toEqual([]);
    const partly = energyPrice("pricePerKWh") + energyPrice("pricePerKg");
    expect(
      parse(table({ ns: AFIR, points: [{ inner: energyRate("adHoc", partly) }] })).offers,
    ).toEqual([]);
  });
});

describe("what the DATEX charging parser leaves unread is counted", () => {
  beforeEach(() => __resetSkips());

  test("an unplaced site, unknown codes and a malformed point, by reason", () => {
    parse(
      table({
        ns: EGI,
        site: "<egi:typeOfSite>floating</egi:typeOfSite>",
        station:
          "<egi:authenticationAndIdentificationMethods>retinaScan</egi:authenticationAndIdentificationMethods>",
        points: [
          {
            inner:
              "<egi:connector><egi:connectorType>nacs</egi:connectorType><egi:chargingMode>mode9</egi:chargingMode></egi:connector><egi:connector><egi:maxPowerAtSocket>11000</egi:maxPowerAtSocket></egi:connector>",
          },
        ],
      }),
      statusOf(EGI, "exploded"),
    );
    // Site type, method, connector type, charging mode and status; the connector without a type.
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 5, malformed: 1 });

    parse(table({ ns: EGI, point: false }));
    expect(drainSkipped(FEED)).toEqual({ no_geometry: 1 });
  });

  test("a bicycle-only site is left out by design, not counted", () => {
    const out = parse(
      table({
        ns: EGI,
        site: '<fac:applicableForVehicles xmlns:fac="http://datex2.eu/schema/3/facilities"><vehicleType>bicycle</vehicleType></fac:applicableForVehicles>',
        point: false,
      }),
    );
    expect(out.features).toEqual([]);
    expect(drainSkipped(FEED)).toEqual({});
  });
});
