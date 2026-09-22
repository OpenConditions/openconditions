import { buildRegistry, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  DATEX2_CONNECTOR_FORMATS,
  DATEX2_CONNECTOR_STANDARDS,
  DATEX2_ENERGY_SITE_TYPES,
  DATEX2_REFILL_POINT_STATUSES,
} from "../crosswalk/datex2.js";
import {
  OCPI_CONNECTOR_STANDARDS,
  OCPI_EVSE_STATUSES,
  OCPI_FACILITIES,
  OCPI_IMAGE_CATEGORIES,
  OCPI_PARKING_TYPES,
  OCPI_TARIFF_DIMENSIONS,
  OCPI_TARIFF_TYPES,
} from "../crosswalk/ocpi.js";
import { chargingModule } from "../module.js";
import { DATEX2_V3_ENERGY } from "../vocabularies/datex2.js";
import { OCPI_2_2_1 } from "../vocabularies/ocpi.js";

const registry = buildRegistry([kernelModule, chargingModule]);
type Table = Readonly<Record<string, string | null>>;
const unmapped = (values: readonly string[], table: Table, prefix = "") =>
  values.filter((v) => !(`${prefix}${v}` in table));

describe("charging module", () => {
  it("builds on the kernel alone", () => {
    expect(registry.kind("feature", "charging_site")?.domain).toBe("charging");
    expect(registry.kinds("component").map((k) => k.code)).toEqual(
      expect.arrayContaining(["evse", "connector"]),
    );
    expect(registry.kind("offer", "energy_tariff")?.domain).toBe("charging");
  });

  it("reports a charge point and one of its plugs in the same vocabulary", () => {
    expect(registry.property("charging.evse_status")?.result).toEqual({
      type: "category",
      vocabulary: "evse_status",
    });
    expect(registry.property("charging.connector_status")?.result).toEqual({
      type: "category",
      vocabulary: "evse_status",
    });
  });

  it("links two sources' sites by a shared location id before position", () => {
    const rules = registry.kind("feature", "charging_site")?.linking;
    expect(rules?.idSchemes).toContain("ocpi:location");
    expect(rules?.alwaysMetres).toBe(20);
    expect(rules?.osm?.idTags).toEqual({
      "ref:EU:EVSE": "emi3:evse",
      "ref:ocpi": "ocpi:location",
    });
  });
});

describe("charging crosswalk coverage", () => {
  it.each([
    ["EVSE status", OCPI_2_2_1.evseStatuses, OCPI_EVSE_STATUSES],
    ["connector type", OCPI_2_2_1.connectorTypes, OCPI_CONNECTOR_STANDARDS],
    ["facility", OCPI_2_2_1.facilities, OCPI_FACILITIES],
    ["parking type", OCPI_2_2_1.parkingTypes, OCPI_PARKING_TYPES],
    ["tariff type", OCPI_2_2_1.tariffTypes, OCPI_TARIFF_TYPES],
    ["tariff dimension", OCPI_2_2_1.tariffDimensionTypes, OCPI_TARIFF_DIMENSIONS],
    ["image category", OCPI_2_2_1.imageCategories, OCPI_IMAGE_CATEGORIES],
  ] as const)("maps every OCPI 2.2.1 %s", (_what, values, table) => {
    expect(unmapped(values, table)).toEqual([]);
  });

  it.each([
    ["refill point status", DATEX2_V3_ENERGY.refillPointStatuses, DATEX2_REFILL_POINT_STATUSES, ""],
    ["connector type", DATEX2_V3_ENERGY.connectorTypes, DATEX2_CONNECTOR_STANDARDS, ""],
    ["connector format", DATEX2_V3_ENERGY.connectorFormatTypes, DATEX2_CONNECTOR_FORMATS, ""],
    [
      "site type",
      DATEX2_V3_ENERGY.energyInfrastructureSiteTypes,
      DATEX2_ENERGY_SITE_TYPES,
      "siteType:",
    ],
  ] as const)("maps every DATEX II v3 %s", (_what, values, table, prefix) => {
    expect(unmapped(values, table, prefix)).toEqual([]);
  });

  it("carries every OCPI connector standard as itself", () => {
    expect(registry.crosswalk.value("connector_standard", "ocpi", "IEC_62196_T2")).toBe(
      "IEC_62196_T2",
    );
    expect(registry.crosswalk.value("connector_standard", "datex2_v3", "iec62196T2")).toBe(
      "IEC_62196_T2",
    );
  });

  it("emits nothing where a target has no word for a value", () => {
    expect(registry.crosswalk.valueTargetCode("evse_status", "ocpi", "occupied")).toBeUndefined();
    expect(registry.crosswalk.valueTargetCode("connector_standard", "ocpi", "MCS")).toBeUndefined();
  });
});
