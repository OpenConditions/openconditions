import {
  pinnedOrUnavailable,
  type SchemaFile,
  xsdEnumeration,
  xsdEnumerations,
} from "@openconditions/conformance";
import { DATEX2_V2 } from "@openconditions/conformance/standards/datex2-v2";
import { DATEX2_V3 } from "@openconditions/conformance/standards/datex2-v3";
import { DATEX2_V3_2 } from "@openconditions/conformance/standards/datex2-v3.2";
import { DATEX2_V3_AFIR_ENERGY, DATEX2_V3_ENERGY } from "@openconditions/model-charging";
import { DATEX2_OPENING_STATUSES } from "@openconditions/model-facilities";
import { DATEX2_V2_FUEL, DATEX2_V3_FUEL } from "@openconditions/model-fuel";
import {
  DATEX2_V2_PARKING,
  DATEX2_V3_2_PARKING_SITE_STATUSES,
  DATEX2_V3_PARKING,
} from "@openconditions/model-parking";
import { beforeAll, describe, expect, test } from "vitest";

const NS = "http://datex2.eu/schema/3/";

type SchemaSet = "v2.3" | "v3.2" | "v3.7";

/**
 * Each vocabulary list the model packages copy from DATEX, and the
 * enumeration it copies: the set, the type's name and, where several
 * namespaces declare the name, the namespace.
 */
const LISTS: (readonly [
  label: string,
  list: readonly string[],
  set: SchemaSet,
  name: string,
  ns?: string,
])[] = [
  ...(
    [
      ["energyInfrastructureSiteTypes", "EnergyInfrastructureSiteTypeEnum"],
      ["serviceTypes", "ServiceTypeEnum"],
      ["refillPointStatuses", "RefillPointStatusEnum"],
      ["chargingPointUsageTypes", "ChargingPointUsageTypeEnum"],
      ["chargingModes", "ChargingModeEnum"],
      ["connectorTypes", "ConnectorTypeEnum"],
      ["connectorFormatTypes", "ConnectorFormatTypeEnum"],
      ["authenticationAndIdentificationMethods", "AuthenticationAndIdentificationEnum"],
      ["electricEnergySourceTypes", "ElectricEnergySourceTypeEnum"],
      ["pricingPolicies", "PricingPolicyEnum"],
      ["deliveryUnits", "DeliveryUnitEnum"],
    ] as const
  ).map(
    ([key, name]) =>
      [`energy ${key}`, DATEX2_V3_ENERGY[key], "v3.7", name, `${NS}energyInfrastructure`] as const,
  ),
  ...(
    [
      ["energyInfrastructureSiteTypes", "EnergyInfrastructureSiteTypeEnum"],
      ["connectorTypes", "ConnectorTypeEnum"],
      ["currentTypes", "CurrentTypeEnum"],
      ["ratePolicies", "RatePolicyEnum"],
      ["priceTypes", "PriceTypeEnum"],
    ] as const
  ).map(
    ([key, name]) =>
      [
        `AFIR ${key}`,
        DATEX2_V3_AFIR_ENERGY[key],
        "v3.7",
        name,
        `${NS}afirEnergyInfrastructure`,
      ] as const,
  ),
  ...(
    [
      ["petrolTypes", "PetrolTypeEnum"],
      ["dieselTypes", "DieselTypeEnum"],
      ["bioethanolTypes", "BioethanolTypeEnum"],
      ["organicGasTypes", "OrganicGasTypeEnum"],
      ["refillSolutionsHydrogen", "RefillSolutionHydrogenEnum"],
      ["hydrogenFuellingProcessProtocols", "HydrogenFuellingProcessProtocolEnum"],
      ["deliveryUnits", "DeliveryUnitEnum"],
    ] as const
  ).map(
    ([key, name]) =>
      [`fuel ${key}`, DATEX2_V3_FUEL[key], "v3.7", name, `${NS}energyInfrastructure`] as const,
  ),
  ["fuel v2 fuelTypes", DATEX2_V2_FUEL.fuelTypes, "v2.3", "FuelTypeEnum"],
  ["opening v3", DATEX2_OPENING_STATUSES.v3, "v3.7", "OpeningStatusEnum", `${NS}facilities`],
  ["opening v2", DATEX2_OPENING_STATUSES.v2, "v2.3", "OpeningStatusEnum"],
  ...(
    [
      ["parkingUsageScenarios", "ParkingUsageScenarioEnum"],
      ["parkingOccupancyTrends", "ParkingOccupancyTrendEnum"],
      ["parkingVacantSpaces", "ParkingVacantSpacesEnum"],
      ["parkingPlaceStatuses", "ParkingPlaceStatusEnum"],
      ["parkingOccupancies", "ParkingOccupancyEnum"],
      ["parkingSecurity", "ParkingSecurityEnum"],
      ["parkingSupervisions", "ParkingSupervisionEnum"],
      ["layouts", "LayoutEnum"],
      ["structureTypes", "StructureTypeEnum"],
      ["accessTypes", "AccessTypeEnum"],
    ] as const
  ).map(
    ([key, name]) =>
      [`parking ${key}`, DATEX2_V3_PARKING[key], "v3.7", name, `${NS}parking`] as const,
  ),
  [
    "parking operationStatuses",
    DATEX2_V3_PARKING.operationStatuses,
    "v3.7",
    "OperationStatusEnum",
    `${NS}facilities`,
  ],
  [
    "parking openingStatuses",
    DATEX2_V3_PARKING.openingStatuses,
    "v3.7",
    "OpeningStatusEnum",
    `${NS}facilities`,
  ],
  [
    "parking vehicleTypes",
    DATEX2_V3_PARKING.vehicleTypes,
    "v3.7",
    "VehicleTypeEnum",
    `${NS}common`,
  ],
  ...(
    [
      ["parkingSiteStatuses", "ParkingSiteStatusEnum"],
      ["parkingVacantSpaces", "ParkingVacantSpacesEnum"],
      ["parkingOccupancyTrends", "ParkingOccupancyTrendEnum"],
      ["parkingUsageScenarios", "ParkingUsageScenarioEnum"],
      ["urbanParkingSiteTypes", "UrbanParkingSiteTypeEnum"],
      ["interUrbanParkingSiteLocations", "InterUrbanParkingSiteLocationEnum"],
      ["parkingLayouts", "ParkingLayoutEnum"],
      ["parkingSecurity", "ParkingSecurityEnum"],
      ["parkingSupervisions", "ParkingSupervisionEnum"],
      ["parkingSiteOvercrowdingStatuses", "ParkingSiteOvercrowdingStatusEnum"],
      ["openingStatuses", "OpeningStatusEnum"],
      ["vehicleTypes", "VehicleTypeEnum"],
      ["vehicleTypes2", "VehicleType2Enum"],
      ["userTypes", "UserTypeEnum"],
      ["equipmentTypes", "EquipmentTypeEnum"],
      ["serviceFacilityTypes", "ServiceFacilityTypeEnum"],
      ["labelSecurityLevels", "LABELSecurityLevelEnum"],
      ["labelServiceLevels", "LABELServiceLevelEnum"],
      ["reservationTypes", "ReservationTypeEnum"],
      ["accessCategories", "AccessCategoryEnum"],
      ["meansOfPayment", "MeansOfPaymentEnum"],
    ] as const
  ).map(([key, name]) => [`parking v2 ${key}`, DATEX2_V2_PARKING[key], "v2.3", name] as const),
  // The census leaves out `_extended`, which the parking crosswalk does not key.
  [
    "parking v3.2 site statuses",
    [...DATEX2_V3_2_PARKING_SITE_STATUSES, "_extended"],
    "v3.2",
    "ParkingSiteStatusEnum",
  ],
];

/**
 * Lists of v2.3 that the record-based v3 parking schema keeps, with v3's
 * `_extended`: the parking format reads both with the v2 list.
 */
const RECORD_BASED_V3: [key: keyof typeof DATEX2_V2_PARKING, name: string][] = [
  ["parkingVacantSpaces", "ParkingVacantSpacesEnum"],
  ["parkingOccupancyTrends", "ParkingOccupancyTrendEnum"],
  ["parkingUsageScenarios", "ParkingUsageScenarioEnum"],
  ["urbanParkingSiteTypes", "UrbanParkingSiteTypeEnum"],
  ["interUrbanParkingSiteLocations", "InterUrbanParkingSiteLocationEnum"],
  ["parkingLayouts", "ParkingLayoutEnum"],
  ["parkingSecurity", "ParkingSecurityEnum"],
  ["parkingSupervisions", "ParkingSupervisionEnum"],
  ["parkingSiteOvercrowdingStatuses", "ParkingSiteOvercrowdingStatusEnum"],
  ["parkingSiteStatuses", "ParkingSiteStatusEnum"],
  ["openingStatuses", "OpeningStatusEnum"],
  ["labelSecurityLevels", "LABELSecurityLevelEnum"],
  ["labelServiceLevels", "LABELServiceLevelEnum"],
  ["reservationTypes", "ReservationTypeEnum"],
  ["accessCategories", "AccessCategoryEnum"],
  ["meansOfPayment", "MeansOfPaymentEnum"],
];

describe("the DATEX vocabularies are the schemas' enumerations", () => {
  const enumerations = new Map<SchemaSet, ReturnType<typeof xsdEnumerations>>();
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
      enumerations.set(name, xsdEnumerations(pinned.files as SchemaFile[]));
    }
  }, 120_000);

  test.for(LISTS)("%s", ([, list, set, name, ns], { skip }) => {
    if (unavailable) skip(unavailable);
    expect([...list]).toEqual(xsdEnumeration(enumerations.get(set)!, name, ns));
  });

  test.for(RECORD_BASED_V3)("record-based v3 parking %s", ([key, name], { skip }) => {
    if (unavailable) skip(unavailable);
    expect([...DATEX2_V2_PARKING[key], "_extended"]).toEqual(
      xsdEnumeration(enumerations.get("v3.2")!, name, `${NS}parking`),
    );
  });
});
