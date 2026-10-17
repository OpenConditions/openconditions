import { readFileSync } from "node:fs";
import {
  assertCovered,
  pinnedOrUnavailable,
  type SchemaFile,
  type XsdEnumeration,
  xsdComplexTypes,
  xsdEnumeration,
  xsdEnumerations,
  xsdErrors,
  xsdSubtypes,
} from "@openconditions/conformance";
import {
  D2_LOGICAL_MODEL_SCHEMA,
  DATEX2_V2,
} from "@openconditions/conformance/standards/datex2-v2";
import { DATEX2_V3 } from "@openconditions/conformance/standards/datex2-v3";
import {
  DATEX2_V3_2,
  PARKING_PAYLOAD_ROOT,
  PARKING_PAYLOAD_SCHEMA,
} from "@openconditions/conformance/standards/datex2-v3.2";
import {
  __resetSkips,
  drainSkipped,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { DATEX2_V2_FACILITIES } from "@openconditions/model-parking";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { parseDatex2 } from "../formats/datex2.js";
import { parseDatex2Light } from "../formats/datex2-light.js";
import { fixture, mobidromFeed, ndwFeed, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * DATEX II parking held to its schemas: the parking fixtures validate against
 * the version they declare, and every enumeration and record type the parking
 * parser reads is shown read into the model as DATEX defines it, by parsing a
 * minimal publication carrying the value, or is listed with the reason it is
 * not. v2.3 and the record-based v3 parking schema (published with v3.2) are
 * read alike, so each value is run in both; v3.7's facility status is joined
 * to a v2 table record.
 */

const FETCHED = "2026-10-05T03:35:30Z";
const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const LOCATION = `<parkingLocation xsi:type="Point"><pointByCoordinates><pointCoordinates><latitude>51.4</latitude><longitude>6.1</longitude></pointCoordinates></pointByCoordinates></parkingLocation>`;

type Version = "v2.3" | "v3.2";
const VERSIONS: Version[] = ["v2.3", "v3.2"];

/** A table of one parking record, in v2.3 or in the record-based v3 schema. */
function table(version: Version, inner: string, type = "InterUrbanParkingSite", located = true) {
  const record = `<parkingRecord xsi:type="${version === "v2.3" ? "" : "prk:"}${type}" id="r" version="1">${located ? LOCATION : ""}${inner}</parkingRecord>`;
  return Buffer.from(
    version === "v2.3"
      ? `<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" ${XSI} modelBaseVersion="2"><payloadPublication xsi:type="ParkingTablePublication" lang="en"><publicationTime>2026-10-05T00:00:00Z</publicationTime><publicationCreator><country>nl</country><nationalIdentifier>X</nationalIdentifier></publicationCreator><parkingTable id="t" version="1">${record}</parkingTable></payloadPublication></d2LogicalModel>`
      : `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns="http://datex2.eu/schema/3/parking" xmlns:prk="http://datex2.eu/schema/3/parking" ${XSI} xsi:type="prk:ParkingTablePublication" lang="en" modelBaseVersion="3"><parkingTable id="t" version="1">${record}</parkingTable></d2:payload>`,
  );
}

/** A record status of record `r`. */
function status(version: Version, inner: string) {
  const body = `<parkingRecordStatus xsi:type="${version === "v2.3" ? "" : "prk:"}ParkingSiteStatus"><parkingRecordReference targetClass="ParkingRecord" id="r" version="1"/><parkingStatusOriginTime>2026-10-05T03:30:00Z</parkingStatusOriginTime>${inner}</parkingRecordStatus>`;
  return Buffer.from(
    version === "v2.3"
      ? `<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" ${XSI} modelBaseVersion="2"><payloadPublication xsi:type="ParkingStatusPublication" lang="en"><publicationTime>2026-10-05T03:30:00Z</publicationTime>${body}</payloadPublication></d2LogicalModel>`
      : `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns="http://datex2.eu/schema/3/parking" xmlns:prk="http://datex2.eu/schema/3/parking" ${XSI} xsi:type="prk:ParkingStatusPublication" lang="en" modelBaseVersion="3">${body}</d2:payload>`,
  );
}

/** A v3.7 facility status of record `r`. */
function facilityStatus(inner: string) {
  return Buffer.from(
    `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns="http://datex2.eu/schema/3/parking" xmlns:fac="http://datex2.eu/schema/3/facilities" ${XSI} xsi:type="ParkingStatusPublication" lang="en" modelBaseVersion="3"><parkingStatusInformation xsi:type="PlaceStatus"><fac:reference targetClass="prk:Place" id="r" version="1"/><fac:lastUpdated>2026-10-05T03:30:00Z</fac:lastUpdated>${inner}</parkingStatusInformation></d2:payload>`,
  );
}

function parse(sites: Buffer, statuses?: Buffer): ParseOutput {
  const out = parseDatex2(
    ndwFeed(),
    { sites: [sites], ...(statuses === undefined ? {} : { status: [statuses] }) },
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const site = (out: ParseOutput): RecordDraft | undefined => out.features[0];
const details = (out: ParseOutput) => (site(out)?.["details"] ?? {}) as Record<string, unknown>;
const areaKeys = (out: ParseOutput) =>
  ((site(out)?.["components"] ?? []) as { key: string }[]).map((c) => c.key);
const reading = (out: ParseOutput, property: string) =>
  (out.observations.find((o) => o["property"] === property)?.["result"] as { value?: unknown })
    ?.value;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const EXTENDED =
  "the schema's escape hatch for national extensions; the meaning is in `_extendedValue`";
const OTHER = "says only that it is none of the others";
const UNKNOWN = "says nothing";
/** v3's `_extended`, a value of the record-based v3 lists but not of v2.3's. */
const withExtended = (version: Version, unsupported: Record<string, string>) =>
  version === "v2.3" ? unsupported : { ...unsupported, _extended: EXTENDED };

const USAGE_TYPES: Record<string, string> = {
  truckParking: "truck_parking",
  parkAndRide: "park_and_ride",
  restArea: "rest_area_parking",
  serviceArea: "rest_area_parking",
};
const USAGES: Record<string, string> = { liftshare: "carpool", eventParking: "event" };
const NO_USAGE = "a way of using the site the model has no usage for";

const LAYOUTS: Record<string, string> = {
  multiStorey: "multi_storey",
  singleLevel: "single_level",
  underground: "underground",
  automatedParkingGarage: "automated",
  openSpace: "surface",
  field: "surface",
  covered: "covered",
  nested: "nested",
  unknown: "unknown",
};

const SECURITY: Record<string, string> = {
  socialControl: "social_control",
  securityStaff: "security_staff",
  externalSecurity: "external_security",
  cctv: "cctv",
  dog: "dog",
  guard24hours: "guard_24h",
  lighting: "lighting",
  floodLight: "flood_light",
  fences: "fences",
  areaSeperatedFromSurroundings: "separated_area",
  none: "none",
};

const SUPERVISION: Record<string, string> = {
  remote: "remote",
  onSite: "on_site",
  controlCentreOnSite: "control_centre",
  controlCentreOffSite: "control_centre",
  patrol: "patrol",
  none: "none",
  unknown: "unknown",
};

/** The bay each vehicle type parks in, by what the bay has to fit. */
const VEHICLES: Record<string, string> = {
  anyVehicle: "any",
  articulatedVehicle: "truck",
  bicycle: "bicycle",
  bus: "bus",
  car: "car",
  caravan: "caravan",
  carOrLightVehicle: "car",
  carWithCaravan: "caravan",
  carWithTrailer: "car",
  fourWheelDrive: "car",
  highSidedVehicle: "truck",
  lorry: "truck",
  moped: "motorcycle",
  motorcycle: "motorcycle",
  motorcycleWithSideCar: "motorcycle",
  motorscooter: "motorcycle",
  tanker: "truck",
  twoWheeledVehicle: "motorcycle",
  van: "car",
  vehicleWithCatalyticConverter: "car",
  vehicleWithoutCatalyticConverter: "car",
  vehicleWithCaravan: "caravan",
  motorhome: "caravan",
  lightGoodsVehicle: "car",
  heavyGoodsVehicle: "truck",
  minibus: "bus",
  smallCar: "car",
  largeCar: "car",
  heavyGoodsVehicleWithTrailer: "truck",
  heavyHaulageVehicle: "truck",
  passengerCar: "car",
};
const NO_BAY = "no parking bay of its own in the model";
const VEHICLES_UNSUPPORTED = {
  agriculturalVehicle: NO_BAY,
  constructionOrMaintenanceVehicle: NO_BAY,
  threeWheeledVehicle: NO_BAY,
  trailer: "a trailer is not parked on its own",
  tram: NO_BAY,
  vehicleWithTrailer: "names no vehicle, only that it tows",
  withEvenNumberedRegistrationPlates: "a plate rule, not a vehicle",
  withOddNumberedRegistrationPlates: "a plate rule, not a vehicle",
  other: OTHER,
};
const VEHICLES2_UNSUPPORTED = {
  lightGoodsVehicleWithTrailer: "a van with a trailer fits neither a car bay nor is it a lorry",
  unknown: UNKNOWN,
};

const USERS: Record<string, string> = {
  disabled: "disabled",
  registeredDisabledUsers: "disabled",
  handicapped: "disabled",
  wheelchairUsers: "disabled",
  women: "women",
  families: "family",
  residents: "residents",
  shortTermParker: "short_term",
  longTermParker: "long_term",
};
const NO_GROUP = "no area of its own in the model";

const SITE_STATUSES: Record<string, string> = {
  spacesAvailable: "spaces_available",
  almostFull: "almost_full",
  fullAtEntrance: "full",
  full: "full",
  unknown: "unknown",
};
const OPENING: Record<string, string> = {
  open: "open",
  closed: "closed",
  closedAbnormal: "closed_abnormally",
  statusUnknown: "unknown",
};
const OVERCROWDING: Record<string, string> = {
  overcrowding: "full",
  overcrowdingLevel1: "almost_full",
  overcrowdingLevel2: "full",
  noOvercrowding: "spaces_available",
  unknown: "unknown",
};
const VACANT: Record<string, string> = {
  noParkingSpacesAvailable: "full",
  expectNoSpacesAvailable: "almost_full",
  onlyAFewSpacesAvailable: "almost_full",
  lessThan10SpacesAvailable: "spaces_available",
  lessThan20SpacesAvailable: "spaces_available",
  lessThan30SpacesAvailable: "spaces_available",
  lessThan40SpacesAvailable: "spaces_available",
  lessThan50SpacesAvailable: "spaces_available",
  unknown: "unknown",
};
const TRENDS: Record<string, string> = {
  decreasing: "clearing",
  decreasingQuickly: "clearing",
  decreasingSlowly: "clearing",
  increasing: "filling",
  increasingQuickly: "filling",
  increasingSlowly: "filling",
  stable: "steady",
};

const group = (inner: string) =>
  `<groupOfParkingSpaces groupIndex="1"><parkingSpaceBasics xsi:type="GroupOfParkingSpaces"><assignedParkingAmongOthers>${inner}</assignedParkingAmongOthers><parkingNumberOfSpaces>10</parkingNumberOfSpaces><parkingTypeOfGroup>adjacentSpaces</parkingTypeOfGroup></parkingSpaceBasics></groupOfParkingSpaces>`;

const ROOTS: Record<Version | "v3.7", string> = {
  "v2.3": D2_LOGICAL_MODEL_SCHEMA,
  "v3.2": PARKING_PAYLOAD_SCHEMA,
  "v3.7": "DATEXII_3_D2Payload.xsd",
};

describe("DATEX II parking through the parking parser", () => {
  const enums = new Map<Version | "v3.7", XsdEnumeration[]>();
  const schemas = new Map<Version | "v3.7", SchemaFile[]>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    for (const [name, set] of [
      ["v2.3", DATEX2_V2],
      ["v3.2", DATEX2_V3_2],
      ["v3.7", DATEX2_V3],
    ] as const) {
      const pinned = await pinnedOrUnavailable(set);
      if ("unavailable" in pinned) {
        unavailable = pinned.unavailable;
        return;
      }
      const files = name === "v3.2" ? [...pinned.files, PARKING_PAYLOAD_ROOT] : pinned.files;
      schemas.set(name, files);
      enums.set(name, xsdEnumerations(files));
    }
  }, 120_000);

  /** A parking enumeration of a version: v2.3 has one namespace, v3 is the parking one. */
  const values = (version: Version | "v3.7", name: string, ns = "parking") =>
    xsdEnumeration(
      enums.get(version)!,
      name,
      version === "v2.3" ? undefined : `http://datex2.eu/schema/3/${ns}`,
    );

  describe("the parking fixtures follow their schemas", () => {
    // The copies here are later captures than the datex2 package's; the deviations are the same publishers'.
    const FIXTURES: [
      file: string,
      version: Version,
      rewrite: [RegExp, string] | undefined,
      deviations: RegExp[],
    ][] = [
      ["ndw-truck-table.xml", "v2.3", undefined, []],
      ["cita-dynamic.xml", "v2.3", undefined, []],
      [
        "cita-static.xml",
        "v2.3",
        // CITA's root element is in its own namespace `lu.cita`.
        [/(<\/?)ns2:d2LogicalModel/g, "$1d2LogicalModel"],
        [
          // Space groups without `groupIndex`, their content outside `parkingSpaceBasics`.
          /groupOfParkingSpaces': The attribute 'groupIndex' is required but missing/,
          /parkingNumberOfSpaces': This element is not expected\. Expected is \( \{[^}]+\}parkingSpaceBasics \)/,
          // Access points of both directions share their ids.
          /parkingAccess': Duplicate key-sequence \['MB'\] in unique identity-constraint/,
        ],
      ],
      ["ndw-truck-status.xml", "v3.2", undefined, []],
    ];

    test.for(FIXTURES)(
      "%s",
      { timeout: 60_000 },
      async ([file, version, rewrite, deviations], { skip }) => {
        if (unavailable) skip(unavailable);
        let xml = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
        if (rewrite) xml = xml.replace(rewrite[0], rewrite[1]);
        const errors = await xsdErrors(xml, schemas.get(version)!, ROOTS[version], file);
        expect(errors.filter((e) => !deviations.some((d) => d.test(e)))).toEqual([]);
        expect(deviations.filter((d) => !errors.some((e) => d.test(e)))).toEqual([]);
      },
    );
  });

  describe.for(VERSIONS)("%s", (version) => {
    test("parking record types", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const types = xsdComplexTypes(schemas.get(version)!);
      const base =
        version === "v2.3" ? "ParkingRecord" : "{http://datex2.eu/schema/3/parking}ParkingRecord";
      assertCovered("ParkingRecord", xsdSubtypes(types, base), {
        handled: (v) => parse(table(version, "", v)).features.length === 1,
        unsupported: {
          GroupOfParkingSites:
            "a group of sites is no site: its sites are records of their own, and are read as such",
        },
      });
    });

    test("usage scenarios", ({ skip }) => {
      if (unavailable) skip(unavailable);
      assertCovered("ParkingUsageScenarioEnum", values(version, "ParkingUsageScenarioEnum"), {
        handled: (v) => {
          const out = parse(
            table(
              version,
              `<parkingUsageScenario scenarioIndex="1"><parkingUsageScenario><parkingUsageScenario>${v}</parkingUsageScenario></parkingUsageScenario></parkingUsageScenario>`,
            ),
          );
          if (USAGE_TYPES[v] !== undefined) return site(out)?.["type"] === USAGE_TYPES[v];
          return USAGES[v] !== undefined && same(details(out)["usage"], [USAGES[v]]);
        },
        unsupported: withExtended(version, {
          parkAndCycle: NO_USAGE,
          parkAndWalk: NO_USAGE,
          kissAndRide: NO_USAGE,
          carSharing: "car sharing bays are an area, which a site's scenario does not count",
          dropOffWithValet: NO_USAGE,
          dropOffMechanical: NO_USAGE,
          automaticParkingGuidance: NO_USAGE,
          staffGuidesToSpace: NO_USAGE,
          vehicleLift: NO_USAGE,
          loadingBay: NO_USAGE,
          dropOff: NO_USAGE,
          overnightParking: NO_USAGE,
          unknown: UNKNOWN,
          other: OTHER,
        }),
      });
    });

    test("urban site types and inter-urban locations", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const urban: Record<string, string> = {
        onStreetParking: "on_street",
        offStreetParking: "off_street",
      };
      assertCovered("UrbanParkingSiteTypeEnum", values(version, "UrbanParkingSiteTypeEnum"), {
        handled: (v) =>
          site(
            parse(
              table(
                version,
                `<urbanParkingSiteType>${v}</urbanParkingSiteType>`,
                "UrbanParkingSite",
              ),
            ),
          )?.["type"] === (urban[v] ?? "-"),
        unsupported: withExtended(version, { other: OTHER }),
      });
      const interUrban: Record<string, string> = {
        motorway: "rest_area_parking",
        nearbyMotorway: "rest_area_parking",
        layBy: "rest_area_parking",
        onStreet: "on_street",
      };
      assertCovered(
        "InterUrbanParkingSiteLocationEnum",
        values(version, "InterUrbanParkingSiteLocationEnum"),
        {
          handled: (v) =>
            site(
              parse(
                table(
                  version,
                  `<interUrbanParkingSiteLocation>${v}</interUrbanParkingSiteLocation>`,
                ),
              ),
            )?.["type"] === (interUrban[v] ?? "-"),
          unsupported: withExtended(version, { other: OTHER }),
        },
      );
    });

    test("layouts", ({ skip }) => {
      if (unavailable) skip(unavailable);
      assertCovered("ParkingLayoutEnum", values(version, "ParkingLayoutEnum"), {
        handled: (v) =>
          details(parse(table(version, `<parkingLayout>${v}</parkingLayout>`, "UrbanParkingSite")))[
            "layout"
          ] === (LAYOUTS[v] ?? "-"),
        unsupported: withExtended(version, {
          undergroundAndMultistorey: "both below and above ground; the model's layout is one",
          other: OTHER,
        }),
      });
    });

    test("security, supervision and the EU security label", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const standards = (inner: string) =>
        table(version, `<parkingStandardsAndSecurity>${inner}</parkingStandardsAndSecurity>`);
      assertCovered("ParkingSecurityEnum", values(version, "ParkingSecurityEnum"), {
        handled: (v) =>
          same(
            details(parse(standards(`<parkingSecurity>${v}</parkingSecurity>`)))[
              "securityFeatures"
            ],
            [SECURITY[v] ?? "-"],
          ),
        unsupported: withExtended(version, { unknown: UNKNOWN, other: OTHER }),
      });
      assertCovered("ParkingSupervisionEnum", values(version, "ParkingSupervisionEnum"), {
        handled: (v) =>
          details(parse(standards(`<parkingSupervision>${v}</parkingSupervision>`)))[
            "supervision"
          ] === (SUPERVISION[v] ?? "-"),
        unsupported: withExtended(version, { other: OTHER }),
      });
      assertCovered("LABELSecurityLevelEnum", values(version, "LABELSecurityLevelEnum"), {
        handled: (v) =>
          same(
            details(parse(standards(`<labelSecurityLevel>${v}</labelSecurityLevel>`)))[
              "securityRating"
            ],
            {
              scheme: "eu_label",
              level: v.slice(-1),
            },
          ),
        unsupported: withExtended(version, { none: "no label is no rating", unknown: UNKNOWN }),
      });
    });

    test("equipment and service facilities", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const facility = (element: string, v: string) =>
        table(
          version,
          `<parkingEquipmentOrServiceFacility equipmentOrServiceFacilityIndex="1"><parkingEquipmentOrServiceFacility xsi:type="${element === "equipmentType" ? "Equipment" : "ServiceFacility"}"><${element}>${v}</${element}></parkingEquipmentOrServiceFacility></parkingEquipmentOrServiceFacility>`,
        );
      for (const [element, name] of [
        ["equipmentType", "EquipmentTypeEnum"],
        ["serviceFacilityType", "ServiceFacilityTypeEnum"],
      ] as const) {
        const mapped = (v: string) => DATEX2_V2_FACILITIES[`${element}:${v}`];
        const values_ = values(version, name);
        assertCovered(name, values_, {
          handled: (v) =>
            typeof mapped(v) === "string" &&
            same(site(parse(facility(element, v)))?.["amenities"], [mapped(v)]),
          unsupported: withExtended(
            version,
            Object.fromEntries(
              values_
                .filter((v) => v !== "_extended" && mapped(v) === null)
                .map((v) => [
                  v,
                  v === "unknown" || v === "other" || v === "none"
                    ? "says nothing is offered, or not what"
                    : "an office service or part of the building, no amenity a visitor looks for",
                ]),
            ),
          ),
        });
      }
    });

    test("vehicle types of a space group", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const area = (inner: string) => areaKeys(parse(table(version, group(inner))));
      const vehicleTypes =
        version === "v2.3"
          ? values(version, "VehicleTypeEnum")
          : xsdEnumeration(
              enums.get("v3.2")!,
              "VehicleTypeEnum",
              "http://datex2.eu/schema/3/common",
            );
      assertCovered("VehicleTypeEnum", vehicleTypes, {
        handled: (v) =>
          VEHICLES[v] !== undefined &&
          same(
            area(
              `<vehicleCharacteristics><vehicleType>${v}</vehicleType></vehicleCharacteristics>`,
            ),
            [`${VEHICLES[v]}:any`],
          ),
        unsupported: Object.fromEntries(
          vehicleTypes
            .filter((v) => VEHICLES[v] === undefined)
            .map((v) => [
              v,
              v === "_extended"
                ? EXTENDED
                : v === "unknown"
                  ? UNKNOWN
                  : ((VEHICLES_UNSUPPORTED as Record<string, string>)[v] ?? NO_BAY),
            ]),
        ),
      });
      if (version !== "v2.3") return;
      assertCovered("VehicleType2Enum", values(version, "VehicleType2Enum"), {
        handled: (v) =>
          VEHICLES[v] !== undefined &&
          same(
            area(
              `<vehicleCharacteristics><vehicleCharacteristicsExtension><vehicleCharacteristicsExtended><vehicleType2>${v}</vehicleType2></vehicleCharacteristicsExtended></vehicleCharacteristicsExtension></vehicleCharacteristics>`,
            ),
            [`${VEHICLES[v]}:any`],
          ),
        unsupported: VEHICLES2_UNSUPPORTED,
      });
    });

    test("user types of a space group", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const users = values(version, "UserTypeEnum");
      assertCovered("UserTypeEnum", users, {
        handled: (v) =>
          USERS[v] !== undefined &&
          same(
            areaKeys(parse(table(version, group(`<applicableForUser>${v}</applicableForUser>`)))),
            [`any:${USERS[v]}`],
          ),
        unsupported: Object.fromEntries(
          users
            .filter((v) => USERS[v] === undefined)
            .map((v) => [v, v === "_extended" ? EXTENDED : v === "unknown" ? UNKNOWN : NO_GROUP]),
        ),
      });
    });

    test("record statuses", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const read = (inner: string) =>
        reading(parse(table(version, ""), status(version, inner)), "parking.status");
      const check = (
        name: string,
        expected: Record<string, string>,
        xml: (v: string) => string,
        others: Record<string, string>,
      ) =>
        assertCovered(name, values(version, name), {
          handled: (v) => expected[v] !== undefined && read(xml(v)) === expected[v],
          unsupported: withExtended(version, others),
        });
      check(
        "ParkingSiteStatusEnum",
        SITE_STATUSES,
        (v) => `<parkingSiteStatus>${v}</parkingSiteStatus>`,
        {
          other: OTHER,
        },
      );
      check(
        "OpeningStatusEnum",
        OPENING,
        (v) => `<parkingSiteOpeningStatus>${v}</parkingSiteOpeningStatus>`,
        {
          openingTimesInForce: '"not explicit said if it\'s open right now"',
          other: OTHER,
        },
      );
      check(
        "ParkingSiteOvercrowdingStatusEnum",
        OVERCROWDING,
        (v) => `<parkingSiteOvercrowdingStatus>${v}</parkingSiteOvercrowdingStatus>`,
        { other: OTHER },
      );
      check(
        "ParkingVacantSpacesEnum",
        VACANT,
        (v) =>
          `<parkingOccupancy><parkingNumberOfVacantSpacesGraded>${v}</parkingNumberOfVacantSpacesGraded></parkingOccupancy>`,
        { other: OTHER },
      );
      assertCovered("ParkingOccupancyTrendEnum", values(version, "ParkingOccupancyTrendEnum"), {
        handled: (v) =>
          TRENDS[v] !== undefined &&
          reading(
            parse(
              table(version, ""),
              status(
                version,
                `<parkingOccupancy><parkingOccupancyTrend>${v}</parkingOccupancyTrend></parkingOccupancy>`,
              ),
            ),
            "parking.trend",
          ) === TRENDS[v],
        unsupported: withExtended(version, { unknown: UNKNOWN, other: OTHER }),
      });
    });
  });

  test("v3.7 facility statuses joined to a table record", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const read = (inner: string, property = "parking.status") =>
      reading(parse(table("v2.3", ""), facilityStatus(inner)), property);
    assertCovered("OpeningStatusEnum", values("v3.7", "OpeningStatusEnum", "facilities"), {
      handled: (v) => {
        const expected: Record<string, string> = {
          open: "open",
          openWithServiceLimitation: "open",
          closed: "closed",
          closedOnHoliday: "closed",
          closedOnMaintenance: "closed_abnormally",
          temporarilyClosed: "closed_abnormally",
          statusUnknown: "unknown",
        };
        return (
          expected[v] !== undefined &&
          read(`<fac:openingStatus>${v}</fac:openingStatus>`) === expected[v]
        );
      },
      unsupported: { other: OTHER, _extended: EXTENDED },
    });
    assertCovered("OperationStatusEnum", values("v3.7", "OperationStatusEnum", "facilities"), {
      handled: (v) => {
        const expected: Record<string, string> = {
          inOperation: "open",
          limitedOperation: "open",
          notInOperation: "closed",
          notInOperationAbnormal: "closed_abnormally",
          technicalDefect: "closed_abnormally",
          unknown: "unknown",
        };
        return (
          expected[v] !== undefined &&
          read(
            `<operatingPatternStatus><operationStatus>${v}</operationStatus></operatingPatternStatus>`,
          ) === expected[v]
        );
      },
      unsupported: { _extended: EXTENDED },
    });
    assertCovered("ParkingPlaceStatusEnum", values("v3.7", "ParkingPlaceStatusEnum"), {
      handled: (v) => {
        const expected: Record<string, string> = { ...SITE_STATUSES, ...OVERCROWDING };
        return expected[v] !== undefined && read(`<status>${v}</status>`) === expected[v];
      },
      unsupported: { other: OTHER, _extended: EXTENDED },
    });
    assertCovered("ParkingOccupancyTrendEnum", values("v3.7", "ParkingOccupancyTrendEnum"), {
      handled: (v) =>
        TRENDS[v] !== undefined &&
        read(`<occupancy><occupancyTrend>${v}</occupancyTrend></occupancy>`, "parking.trend") ===
          TRENDS[v],
      unsupported: { unknown: UNKNOWN, other: OTHER, _extended: EXTENDED },
    });
  });

  test("v3.7 facility hierarchy elements are not read, and counted", ({ skip }) => {
    if (unavailable) skip(unavailable);
    __resetSkips();
    const types = xsdComplexTypes(schemas.get("v3.7")!);
    const elements = xsdSubtypes(
      types,
      "{http://datex2.eu/schema/3/parking}HierarchyElementGeneral",
    );
    const doc = (type: string) =>
      Buffer.from(
        `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns="http://datex2.eu/schema/3/parking" ${XSI} xsi:type="ParkingTablePublication" lang="en" modelBaseVersion="3"><parkingTable id="t" version="1"><hierarchyElementGeneral xsi:type="${type}" id="h" version="1"/></parkingTable></d2:payload>`,
      );
    assertCovered("HierarchyElementGeneral", elements, {
      handled: (v) => parse(doc(v)).features.length > 0,
      unsupported: Object.fromEntries(
        elements.map((v) => [
          v,
          "v3.3+ parking tables hold a facility hierarchy the parser does not read; each element is counted as unsupported_version",
        ]),
      ),
    });
    expect(drainSkipped(ndwFeed().id)).toEqual({ unsupported_version: elements.length });
  });
});

describe("what the DATEX parking parsers leave unread is counted", () => {
  beforeEach(() => __resetSkips());
  const feed = ndwFeed().id;

  test("an unplaced record, its status, a status of no record and unknown codes, by reason", () => {
    const out = parse(
      table(
        "v2.3",
        "<parkingLayout>spiral</parkingLayout><parkingStandardsAndSecurity><parkingSecurity>moat</parkingSecurity></parkingStandardsAndSecurity>",
        "UrbanParkingSite",
        false,
      ),
      status("v2.3", "<parkingSiteStatus>halfFull</parkingSiteStatus>"),
    );
    expect(out.features).toEqual([]);
    // The record and its status have no place; layout, security and status are not DATEX's.
    expect(drainSkipped(feed)).toEqual({ no_geometry: 2, unknown_value: 3 });
  });

  test("the fixtures lose only the statuses the kept table does not hold", () => {
    parse(fixture("ndw-truck-table.xml"), fixture("ndw-truck-status.xml"));
    // NL-12_408's status, of a record the trimmed table does not keep.
    expect(drainSkipped(feed)).toEqual({ no_geometry: 1 });
  });

  test("a group of sites and its status are left out by design; its embedded site is read", () => {
    const groupTable = Buffer.from(
      `<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" ${XSI} modelBaseVersion="2"><payloadPublication xsi:type="ParkingTablePublication" lang="en"><publicationTime>2026-10-05T00:00:00Z</publicationTime><parkingTable id="t" version="1"><parkingRecord xsi:type="GroupOfParkingSites" id="r" version="1">${LOCATION}<parkingSite xsi:type="UrbanParkingSite" id="g1" version="1">${LOCATION}</parkingSite></parkingRecord></parkingTable></payloadPublication></d2LogicalModel>`,
    );
    const out = parse(groupTable, status("v2.3", "<parkingSiteStatus>full</parkingSiteStatus>"));
    expect(out.features.map((f) => String(f["id"]).split(":").at(-1))).toEqual(["g1"]);
    expect(out.observations).toEqual([]);
    expect(drainSkipped(feed)).toEqual({});
  });

  test("DATEX II Light: a site without id is malformed, one without a point unplaced", () => {
    const light = mobidromFeed();
    parseDatex2Light(
      light,
      {
        main: [
          Buffer.from(
            JSON.stringify({
              parkingPublicationLight: {
                parkingSite: [
                  {
                    name: "no id",
                    locationAndDimension: {
                      coordinatesForDisplay: { latitude: 51.5, longitude: 7.4 },
                    },
                  },
                  { id: "nowhere", name: "no point" },
                  {
                    id: "ok",
                    locationAndDimension: {
                      coordinatesForDisplay: { latitude: 51.5, longitude: 7.4 },
                    },
                  },
                ],
              },
            }),
          ),
        ],
      },
      parseContext(FETCHED),
    );
    expect(drainSkipped(light.id)).toEqual({ malformed: 1, no_geometry: 1 });
  });
});
