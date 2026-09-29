import { buildRegistry, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  DATEX2_PARKING_MEASURES,
  DATEX2_V2_FACILITIES,
  DATEX2_V2_PARKING_STATUSES,
  DATEX2_V2_PARKING_TRENDS,
  DATEX2_V2_PARKING_TYPES,
  DATEX2_V3_FACILITIES,
  DATEX2_V3_PARKING_STATUSES,
  DATEX2_V3_PARKING_TRENDS,
  DATEX2_V3_PARKING_TYPES,
} from "../crosswalk/datex2.js";
import { PARKAPI_PARKING_TYPES } from "../crosswalk/parkapi.js";
import { parkingModule } from "../module.js";
import { DATEX2_V2_PARKING, DATEX2_V3_PARKING } from "../vocabularies/datex2.js";
import { DATEX2_FACILITIES } from "../vocabularies/facilities.js";
import { PARKAPI_V3 } from "../vocabularies/parkapi.js";

const registry = buildRegistry([kernelModule, parkingModule]);
type Table = Readonly<Record<string, string | null>>;

/** Every value of a source list must be a key of the table, mapped or explicitly null. */
const unmapped = (values: readonly string[], table: Table, prefix: string) =>
  values.filter((v) => !(`${prefix}${v}` in table));

describe("parking module", () => {
  it("builds on the kernel alone", () => {
    expect(registry.kind("feature", "parking_site")?.domain).toBe("parking");
    expect(registry.kinds("component").map((k) => k.code)).toContain("parking_area");
    expect(registry.kind("offer", "parking_rate")?.domain).toBe("parking");
  });

  it("counts free and taken spaces as counts and the share as a percentage", () => {
    expect(registry.property("parking.available")?.result).toEqual({ type: "count" });
    expect(registry.property("parking.occupancy_pct")?.result).toEqual({
      type: "quantity",
      unit: "%",
    });
  });

  it("keeps a full history of counts but only the changes of a state", () => {
    expect(registry.property("parking.available")?.retention).toEqual({
      changeOnly: true,
      rollup: { period: "hourly" },
    });
    expect(registry.property("parking.status")?.retention).toEqual({ changeOnly: true });
  });

  it("links a kerbside stretch only to another kerbside stretch", () => {
    const rules = registry.kind("feature", "parking_site")?.linking;
    expect(rules?.typeCompatible?.("on_street", "off_street")).toBe(false);
    expect(rules?.typeCompatible?.("off_street", "park_and_ride")).toBe(true);
  });
});

describe("parking crosswalk coverage", () => {
  it.each([
    ["structureType:", DATEX2_V3_PARKING.structureTypes, DATEX2_V3_PARKING_TYPES],
    ["usageScenario:", DATEX2_V3_PARKING.parkingUsageScenarios, DATEX2_V3_PARKING_TYPES],
    ["openingStatus:", DATEX2_V3_PARKING.openingStatuses, DATEX2_V3_PARKING_STATUSES],
    ["operationStatus:", DATEX2_V3_PARKING.operationStatuses, DATEX2_V3_PARKING_STATUSES],
    ["placeStatus:", DATEX2_V3_PARKING.parkingPlaceStatuses, DATEX2_V3_PARKING_STATUSES],
    ["facilityType:", DATEX2_FACILITIES.facilityTypes, DATEX2_V3_FACILITIES],
  ] as const)("maps every DATEX II v3 %s value", (prefix, values, table) => {
    expect(unmapped(values, table, prefix)).toEqual([]);
  });

  it.each([
    ["urbanParkingSiteType:", DATEX2_V2_PARKING.urbanParkingSiteTypes, DATEX2_V2_PARKING_TYPES],
    [
      "interUrbanParkingSiteLocation:",
      DATEX2_V2_PARKING.interUrbanParkingSiteLocations,
      DATEX2_V2_PARKING_TYPES,
    ],
    ["usageScenario:", DATEX2_V2_PARKING.parkingUsageScenarios, DATEX2_V2_PARKING_TYPES],
    ["parkingSiteStatus:", DATEX2_V2_PARKING.parkingSiteStatuses, DATEX2_V2_PARKING_STATUSES],
    [
      "overcrowdingStatus:",
      DATEX2_V2_PARKING.parkingSiteOvercrowdingStatuses,
      DATEX2_V2_PARKING_STATUSES,
    ],
    ["vacantSpaces:", DATEX2_V2_PARKING.parkingVacantSpaces, DATEX2_V2_PARKING_STATUSES],
    ["serviceFacilityType:", DATEX2_FACILITIES.serviceFacilityTypes, DATEX2_V2_FACILITIES],
  ] as const)("maps every DATEX II v2 %s value", (prefix, values, table) => {
    expect(unmapped(values, table, prefix)).toEqual([]);
  });

  it("maps every occupancy trend of both DATEX versions", () => {
    const prefix = "parkingOccupancyTrend:";
    expect(
      unmapped(DATEX2_V3_PARKING.parkingOccupancyTrends, DATEX2_V3_PARKING_TRENDS, prefix),
    ).toEqual([]);
    expect(
      unmapped(DATEX2_V2_PARKING.parkingOccupancyTrends, DATEX2_V2_PARKING_TRENDS, prefix),
    ).toEqual([]);
  });

  it("classifies every ParkAPI type and purpose pair it publishes", () => {
    const pairs = PARKAPI_V3.purposes.flatMap((purpose) =>
      PARKAPI_V3.siteTypes.map((type) => `purpose:${purpose}|type:${type}`),
    );
    const known = pairs.filter((code) => code in PARKAPI_PARKING_TYPES);
    // Not every combination exists: bicycle furniture never has a car purpose.
    expect(known.length).toBeGreaterThan(0);
    expect(Object.keys(PARKAPI_PARKING_TYPES).filter((code) => !pairs.includes(code))).toEqual([]);
  });

  it("resolves a measured value to the property it belongs to", () => {
    expect(
      registry.crosswalk.property("datex2_v3", "ParkingOccupancy/parkingNumberOfVacantSpaces"),
    ).toBe("parking.available");
    expect(DATEX2_PARKING_MEASURES["Occupancy/occupancyGraded"]).toBeNull();
  });
});
