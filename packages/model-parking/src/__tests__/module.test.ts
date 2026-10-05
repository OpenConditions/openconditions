import {
  buildRegistry,
  kernelModule,
  type LinkableFeature,
  proposeLink,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  DATEX2_PARKING_MEASURES,
  DATEX2_PARKING_VEHICLE_TYPES,
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
import { PARKING_VEHICLE_TYPES } from "../kinds.js";
import { parkingCrosswalk, parkingModule } from "../module.js";
import {
  DATEX2_V2_PARKING,
  DATEX2_V3_2_PARKING_SITE_STATUSES,
  DATEX2_V3_PARKING,
} from "../vocabularies/datex2.js";
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

describe("source formats", () => {
  it("the kernel holds the shared source formats and parking adds its own", () => {
    const formats = registry.vocabulary("source_format")?.values ?? [];
    for (const id of ["datex2", "geojson", "json", "csv", "overpass", "parkapi-v3", "hdb"]) {
      expect(formats).toContain(id);
    }
    const kernelOnly = buildRegistry([kernelModule]).vocabulary("source_format")?.values ?? [];
    expect([...kernelOnly].sort()).toEqual(
      ["crowd", "derived", "datex2", "geojson", "json", "csv", "overpass"].sort(),
    );
  });
});

describe("parking site linking", () => {
  const rules = registry.kind("feature", "parking_site")!.linking!;
  const site = (id: string, lon: number, id1: string, authority: string): LinkableFeature =>
    ({
      id,
      kind: "parking_site",
      location: { geometry: { type: "Point", coordinates: [lon, 49.0] }, fuzziness: "exact" },
      provenance: { sourceId: "src" },
      externalIds: [{ scheme: "provider", id: id1, authority }],
    }) as LinkableFeature;

  it("two sites of one feed never link, whatever their distance", () => {
    const a = site("oc:feature:de-x-parking:1", 8.4, "1", "de-x-parking");
    const b = site("oc:feature:de-x-parking:2", 8.40002, "2", "de-x-parking");
    expect(proposeLink(a, b, rules)).toBeUndefined();
  });

  it("sites of two upstream sources of one aggregator may still link", () => {
    const a = site("oc:feature:agg:1", 8.4, "1", "de-bw-mobidata-parking/pbw");
    const b = site("oc:feature:agg:2", 8.40014, "2", "de-bw-mobidata-parking/bfrk_bw_car");
    expect(proposeLink(a, b, rules)?.status).toBe("accepted");
  });
});

describe("parking vocabularies and details", () => {
  it("a DATEX v3 parkingSiteStatus resolves to the parking_status vocabulary", () => {
    expect(
      parkingCrosswalk.value("parking_status", "datex2_v3", "parkingSiteStatus:spacesAvailable"),
    ).toBe("spaces_available");
  });

  it("maps every DATEX II v3 parkingSiteStatus value", () => {
    const prefix = "parkingSiteStatus:";
    expect(unmapped(DATEX2_V3_2_PARKING_SITE_STATUSES, DATEX2_V3_PARKING_STATUSES, prefix)).toEqual(
      [],
    );
    const keys = Object.keys(DATEX2_V3_PARKING_STATUSES)
      .filter((code) => code.startsWith(prefix))
      .map((code) => code.slice(prefix.length));
    expect(keys.sort()).toEqual([...DATEX2_V3_2_PARKING_SITE_STATUSES].sort());
  });

  it("maps every DATEX II vehicle type to a parking vehicle type", () => {
    const known = new Set<string>(PARKING_VEHICLE_TYPES);
    for (const [code, type] of Object.entries(DATEX2_PARKING_VEHICLE_TYPES)) {
      expect(known.has(type), code).toBe(true);
    }
    expect(DATEX2_PARKING_VEHICLE_TYPES.lorry).toBe("truck");
    expect(DATEX2_PARKING_VEHICLE_TYPES.heavyHaulageVehicle).toBe("truck");
  });

  it("parking_site details take a website and verbatim tariff and opening-hours text", () => {
    const details = (extra: Record<string, unknown>) => ({
      kind: "parking_site",
      v: 1,
      ...extra,
    });
    const draft = (d: Record<string, unknown>) => ({
      id: "oc:feature:de-x-parking:1",
      class: "feature",
      kind: "parking_site",
      type: "off_street",
      location: {
        geometry: { type: "Point", coordinates: [8.4, 49.0] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      provenance: {
        origin: "feed",
        sourceId: "de-x-parking",
        sourceFormat: "parkapi-v3",
        accessMode: "bulk",
        recordId: "1",
        attribution: { provider: "Example", license: "CC-BY-4.0" },
        privacy: { class: "authoritative" },
      },
      temporality: "static",
      lifecycle: "operational",
      freshness: { fetchedAt: "2026-10-05T12:00:00Z" },
      details: d,
    });
    const good = registry.validateDraft(
      draft(
        details({
          website: "https://example.org/garage",
          tariffText: [{ lang: "de", text: "2 EUR pro Stunde" }],
          openingHoursText: [{ lang: "de", text: "Mo-Fr 6-22 Uhr" }],
        }),
      ),
    );
    expect(good.ok, JSON.stringify(good)).toBe(true);
    expect(registry.validateDraft(draft(details({ website: "not a url" }))).ok).toBe(false);
  });
});
