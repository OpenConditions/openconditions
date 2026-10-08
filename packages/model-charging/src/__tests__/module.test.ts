import {
  buildRegistry,
  kernelModule,
  type LinkableFeature,
  proposeLink,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  DATEX2_CONNECTOR_FORMATS,
  DATEX2_CONNECTOR_STANDARDS,
  DATEX2_ENERGY_SITE_TYPES,
  DATEX2_REFILL_POINT_STATUSES,
} from "../crosswalk/datex2.js";
import {
  OCPI_CONNECTOR_STANDARDS,
  OCPI_DAYS,
  OCPI_EVSE_STATUSES,
  OCPI_FACILITIES,
  OCPI_IMAGE_CATEGORIES,
  OCPI_PARKING_TYPES,
  OCPI_TARIFF_DIMENSIONS,
  OCPI_TARIFF_TYPES,
} from "../crosswalk/ocpi.js";
import { chargingCrosswalk, chargingModule } from "../module.js";
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

describe("charging source formats", () => {
  it("charging contributes its source formats once, beside the kernel's", () => {
    const formats = registry.vocabulary("source_format")?.values ?? [];
    for (const id of ["ocpi", "oicp", "bnetza", "ocm", "datex2", "overpass"]) {
      expect(formats).toContain(id);
    }
    expect(new Set(formats).size).toBe(formats.length);
    const kernelOnly = buildRegistry([kernelModule]).vocabulary("source_format")?.values ?? [];
    expect(kernelOnly).not.toContain("ocpi");
  });
});

describe("charging site linking", () => {
  const rules = registry.kind("feature", "charging_site")!.linking!;
  const site = (id: string, lon: number, id1: string, authority: string): LinkableFeature =>
    ({
      id,
      kind: "charging_site",
      location: { geometry: { type: "Point", coordinates: [lon, 49.0] }, fuzziness: "exact" },
      provenance: { sourceId: "src" },
      externalIds: [{ scheme: "provider", id: id1, authority }],
    }) as LinkableFeature;

  it("two sites of one charging feed never link; two upstreams of one aggregator may", () => {
    const a = site("oc:feature:nl-ndw-charging:1", 8.4, "1", "nl-ndw-charging");
    const b = site("oc:feature:nl-ndw-charging:2", 8.40014, "2", "nl-ndw-charging");
    expect(proposeLink(a, b, rules)).toBeUndefined();
    const c = site("oc:feature:agg:1", 8.4, "1", "de-bw-mobidata-charging/bnetza_api");
    const d = site("oc:feature:agg:2", 8.40014, "2", "de-bw-mobidata-charging/datex2_enbw");
    expect(proposeLink(c, d, rules)?.status).toBe("accepted");
  });

  it("an operator alone links a feed site to OSM only within 50 m", () => {
    const totalEnergies = (id: string, metresNorth: number): LinkableFeature =>
      ({
        id,
        kind: "charging_site",
        location: {
          geometry: { type: "Point", coordinates: [4.9, 52.37 + metresNorth / 111_195] },
          fuzziness: "exact",
        },
        provenance: { sourceId: id.split(":")[2]! },
        operator: { name: [{ lang: "und", text: "TotalEnergies" }] },
      }) as LinkableFeature;
    const ndw = totalEnergies("oc:feature:nl-ndw-charging:NL*GFX*1", 0);
    expect(proposeLink(ndw, totalEnergies("oc:feature:osm-charging:node/1", 120), rules)).toBe(
      undefined,
    );
    expect(
      proposeLink(ndw, totalEnergies("oc:feature:osm-charging:node/1", 30), rules),
    ).toMatchObject({ status: "accepted", reasons: ["30.0 m", "operator 1.00"] });
  });
});

describe("charging details", () => {
  const detailsOf = (cls: "component" | "feature", code: string) =>
    registry.detailsSchema(cls, code)!;

  it("a connector needs only a standard; AC/DC alone is a current, not a power type", () => {
    const schema = detailsOf("component", "connector");
    expect(
      schema.safeParse({ kind: "connector", v: 1, standard: "UNKNOWN", current: "ac" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ kind: "connector", v: 1, standard: "UNKNOWN", current: "ac/dc" }).success,
    ).toBe(false);
  });

  it("an EVSE may stand for several identical charge points", () => {
    const schema = detailsOf("component", "evse");
    expect(schema.safeParse({ kind: "evse", v: 1, quantity: 4 }).success).toBe(true);
    expect(schema.safeParse({ kind: "evse", v: 1, quantity: 1 }).success).toBe(false);
  });

  it("a site takes a website, verbatim tariff and opening-hours text and a brand", () => {
    const schema = detailsOf("feature", "charging_site");
    const good = {
      kind: "charging_site",
      v: 1,
      website: "https://example.org/site",
      tariffText: [{ lang: "en", text: "0.40 EUR/kWh" }],
      openingHoursText: [{ lang: "en", text: "Mon-Fri 6-22" }],
      brand: "Example",
    };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, website: "not a url" }).success).toBe(false);
  });

  it("NACS is a connector standard and OCPI's SAE_J3400 maps to it", () => {
    expect(registry.vocabulary("connector_standard")?.values).toContain("SAE_J3400");
    expect(registry.crosswalk.value("connector_standard", "ocpi", "SAE_J3400")).toBe("SAE_J3400");
  });

  it("OCPI weekdays map to the opening-hours day codes", () => {
    expect(OCPI_DAYS.MONDAY).toBe("MO");
    expect(OCPI_DAYS.SUNDAY).toBe("SU");
    expect(Object.keys(OCPI_DAYS)).toHaveLength(7);
  });
});

describe("OICP statuses", () => {
  it("map without collapsing occupied", () => {
    expect(chargingCrosswalk.value("evse_status", "oicp", "Occupied")).toBe("occupied");
    expect(chargingCrosswalk.value("evse_status", "oicp", "OutOfService")).toBe("out_of_order");
    expect(chargingCrosswalk.value("evse_status", "oicp", "Available")).toBe("available");
    expect(chargingCrosswalk.value("evse_status", "oicp", "Reserved")).toBe("reserved");
    expect(chargingCrosswalk.value("evse_status", "oicp", "Unknown")).toBe("unknown");
    expect(chargingCrosswalk.value("evse_status", "oicp", "EvseNotFound")).toBe("unknown");
  });
});
