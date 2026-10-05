import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FuelFeed, fuelDomain } from "@openconditions/fuel";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type RegistryModule,
  sealRecord,
} from "@openconditions/model";
import { type ParkingFeed, parkingDomain } from "@openconditions/parking";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Facilities fit check: real published records of parking sites, charging
 * sites and filling stations, mapped onto Feature, Component, Observation and
 * Offer and sealed against the production registry. Records captured
 * 2026-09-22 from the MobiData BW charge-point database (OCPI 2.2 locations
 * and tariffs, CC BY 4.0), MobiData BW ParkAPI v3 (parking sites and their
 * upstream sources), NDW (CC0: lorry-park table in DATEX II v2 and its status
 * in DATEX II v3), Autobahn GmbH (lorry parking along the A1, no licence published),
 * MINETUR (Spain, prices per grade), MIMIT (Italy, self and attended prices)
 * and E-Control (Austria, an on-demand source queried by radius).
 * ParkAPI, NDW, MINETUR and E-Control run through the parking and fuel
 * domains' own parsers, whose formats their modules register; the formats
 * OpenConditions does not parse are registered by a test-only module.
 *
 * The Austrian records are kept without their contact block: that feed
 * publishes what look like the operators' private mail addresses, and a
 * business contact is the only contact the model carries.
 */
const fitFormats: RegistryModule = {
  name: "facilities-fit",
  entries: [
    extendVocabulary({
      vocabulary: "source_format",
      values: ["ocpi", "autobahn-parking", "mimit"],
    }),
  ],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const crosswalk = registry.crosswalk;
const FETCHED = "2026-09-22T11:10:00Z";

const text = (name: string) =>
  readFileSync(new URL(`./fixtures/facilities/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(text(name));
const csv = (name: string, separator: string) => {
  const [, header, ...rows] = text(name).trim().split("\n");
  const keys = header!.split(separator);
  return rows.map((row) => Object.fromEntries(row.split(separator).map((v, i) => [keys[i]!, v])));
};

type Draft = Record<string, unknown>;

function provenance(
  sourceId: string,
  sourceFormat: string,
  recordId: string,
  provider: string,
  license: string,
  accessMode: "bulk" | "on_demand" = "bulk",
) {
  return {
    origin: "feed",
    sourceId,
    sourceFormat,
    accessMode,
    recordId,
    attribution: { provider, license },
    privacy: { class: "authoritative" },
  };
}

const point = (lon: number, lat: number) => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  extent: "point",
  geometryOrigin: "source",
  fuzziness: "exact",
});

const de = (value: string) => [{ lang: "de", text: value }];

interface Feature {
  id: string;
  location: unknown;
  provenance: ReturnType<typeof provenance>;
  freshness?: { fetchedAt: string; expiresAt?: string };
}

function observation(
  feature: Feature,
  o: {
    property: string;
    result: unknown;
    at: { instant: string } | { start: string; end: string };
    componentKey?: string;
    qualifiers?: Record<string, unknown>;
    aggregation?: string;
  },
): Draft {
  const draft = {
    class: "observation",
    kind: "observation",
    property: o.property,
    temporality: "live",
    location: feature.location,
    provenance: feature.provenance,
    freshness: feature.freshness ?? { fetchedAt: FETCHED },
    subject: {
      kind: "feature",
      featureId: feature.id,
      ...(o.componentKey === undefined ? {} : { componentKey: o.componentKey }),
    },
    ...(o.qualifiers === undefined ? {} : { qualifiers: o.qualifiers }),
    result: o.result,
    phenomenonTime: o.at,
    aggregation: o.aggregation ?? "instantaneous",
  };
  return { id: observationId(feature.provenance.sourceId, draft as never), ...draft };
}

const category = (value: string, vocabulary: string) => ({ type: "category", value, vocabulary });
const money = (amount: string, currency: string, per?: string) => ({
  type: "money",
  amount,
  currency,
  ...(per === undefined ? {} : { per }),
});

/** Seals every record; returns the validation issues of those that fail. */
function sealAll(records: readonly Draft[]) {
  return records.flatMap((r) => {
    const sealed = sealRecord(registry, r, {
      instanceId: "fit.example",
      revision: 1,
      recordedAt: FETCHED,
    });
    return sealed.ok ? [] : [{ id: r["id"], issues: sealed.issues }];
  });
}

interface OcpiConnector {
  id: string;
  standard: string;
  format: string;
  power_type: string;
  max_voltage?: number;
  max_amperage?: number;
  max_electric_power?: number;
}
interface OcpiEvse {
  uid: string;
  evse_id?: string;
  status: string;
  capabilities?: string[];
  connectors: OcpiConnector[];
  last_updated: string;
}
interface OcpiLocation {
  id: string;
  address: string;
  postal_code: string;
  city: string;
  country: string;
  coordinates: { latitude: number; longitude: number };
  operator?: { name: string };
  opening_times?: { twentyfourseven?: boolean };
  publish?: boolean;
  source: string;
  original_id: string;
  last_updated: string;
  evses: OcpiEvse[];
}

/**
 * An OCPI location is one charging site: its charge points become `evse`
 * components and their plugs `connector` components below them. The database
 * that publishes these relays a national register, so each record names the
 * register it came from as its upstream publisher.
 */
function ocpiChargingSites() {
  const features: Draft[] = [];
  const observations: Draft[] = [];
  for (const loc of json("ocpi-locations.json").items as OcpiLocation[]) {
    const prov = {
      ...provenance("de-bw-ocpdb", "ocpi", loc.id, "MobiData BW", "CC-BY-4.0"),
      upstream: [{ publisher: loc.source, recordId: loc.original_id }],
    };
    const feature: Feature = {
      id: `oc:feature:de-bw-ocpdb:${loc.id}`,
      location: {
        ...point(loc.coordinates.longitude, loc.coordinates.latitude),
        address: {
          street: loc.address,
          postalCode: loc.postal_code,
          city: loc.city,
          country: "DE",
        },
      },
      provenance: prov,
    };
    const components = loc.evses.flatMap((evse) => [
      {
        key: evse.uid,
        kind: "evse",
        ...(evse.evse_id === undefined
          ? {}
          : { externalIds: [{ scheme: "emi3:evse", id: evse.evse_id }] }),
        details: {
          kind: "evse",
          v: 1,
          ...(evse.evse_id === undefined ? {} : { evseId: evse.evse_id }),
          uid: evse.uid,
          ...(evse.capabilities === undefined ? {} : { capabilities: evse.capabilities }),
        },
      },
      ...evse.connectors.map((c) => ({
        key: c.id,
        parentKey: evse.uid,
        kind: "connector",
        details: {
          kind: "connector",
          v: 1,
          standard: crosswalk.value("connector_standard", "ocpi", c.standard) ?? "UNKNOWN",
          format: c.format.toLowerCase(),
          powerType: c.power_type,
          ...(c.max_voltage === undefined ? {} : { maxVoltage: c.max_voltage }),
          ...(c.max_amperage === undefined ? {} : { maxAmperage: c.max_amperage }),
          ...(c.max_electric_power === undefined
            ? {}
            : { maxPowerKw: c.max_electric_power / 1000 }),
        },
      })),
    ]);
    features.push({
      ...feature,
      class: "feature",
      kind: "charging_site",
      temporality: "static",
      lifecycle: "operational",
      // The database's row id, not an operator's OCPI location id: it keeps
      // one row per upstream source of a site.
      externalIds: [{ scheme: "provider", id: loc.id, authority: "de-bw-ocpdb" }],
      ...(loc.operator === undefined
        ? {}
        : { operator: { role: "operator", name: de(loc.operator.name) } }),
      ...(loc.opening_times?.twentyfourseven === true
        ? { openingHours: { osm: "24/7", twentyFourSeven: true } }
        : {}),
      freshness: { fetchedAt: FETCHED },
      components,
      details: {
        kind: "charging_site",
        v: 1,
        ...(loc.publish === undefined ? {} : { publish: loc.publish }),
      },
    });
    for (const evse of loc.evses) {
      observations.push(
        observation(feature, {
          property: "charging.evse_status",
          componentKey: evse.uid,
          result: category(
            crosswalk.value("evse_status", "ocpi", evse.status) ?? "unknown",
            "evse_status",
          ),
          at: { instant: evse.last_updated },
        }),
      );
    }
  }
  return { features, observations };
}

interface OcpiTariff {
  id: string;
  currency: string;
  source: string;
  elements: {
    price_components: { type: string; price: number; taxes?: { percentage: string }[] }[];
    restrictions?: { min_duration?: number; max_duration?: number };
  }[];
}

/** An OCPI tariff is an offer on the site it belongs to. */
function ocpiTariffs() {
  const site = (json("ocpi-locations.json").items as OcpiLocation[])[0]!;
  return (json("ocpi-tariffs.json").items as OcpiTariff[]).map((tariff) => ({
    id: `oc:offer:de-bw-ocpdb:${tariff.id}`,
    class: "offer",
    kind: "energy_tariff",
    temporality: "static",
    location: point(site.coordinates.longitude, site.coordinates.latitude),
    provenance: {
      ...provenance("de-bw-ocpdb", "ocpi", tariff.id, "MobiData BW", "CC-BY-4.0"),
      upstream: [{ publisher: tariff.source }],
    },
    freshness: { fetchedAt: FETCHED },
    subject: { class: "feature", id: `oc:feature:de-bw-ocpdb:${site.id}` },
    currency: tariff.currency,
    elements: tariff.elements.map((el) => ({
      components: el.price_components.map((c) => ({
        type: (
          { ENERGY: "energy", TIME: "time", FLAT: "flat", PARKING_TIME: "parking_time" } as Record<
            string,
            string
          >
        )[c.type],
        price: { amount: c.price.toFixed(4), currency: tariff.currency },
        ...(c.taxes?.[0] === undefined ? {} : { vatPct: Number(c.taxes[0].percentage) }),
      })),
      ...(el.restrictions === undefined
        ? {}
        : {
            restrictions: {
              ...(el.restrictions.min_duration === undefined
                ? {}
                : { minDuration: { value: el.restrictions.min_duration, unit: "s" } }),
              ...(el.restrictions.max_duration === undefined
                ? {}
                : { maxDuration: { value: el.restrictions.max_duration, unit: "s" } }),
            },
          }),
    })),
    priceIncludesVat: false,
    validity: { status: "active" },
  }));
}

const parkapi = parkingDomain.formats["parkapi-v3"]!;

/**
 * `de-bw-mobidata-parking` as `feeds/parking/de.jsonc` writes it: the fields
 * its records take from the feed.
 */
const mobidataFeed = {
  id: "de-bw-mobidata-parking",
  format: "parkapi-v3",
  region: "de",
  license: "DL-DE-BY-2.0",
  licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
  attribution: "MobiData BW (NVBW)",
} as ParkingFeed;

/**
 * ParkAPI relays city and operator feeds, so every site names the source it
 * came from. Its per-user-group capacities become areas of the site, and its
 * height limit is published in centimetres.
 */
function parkapiSites() {
  const { features, observations } = parkapi.parse(
    mobidataFeed as Parameters<typeof parkapi.parse>[0],
    {
      main: [Buffer.from(text("parkapi-sites.json"))],
      sources: [Buffer.from(text("parkapi-sources.json"))],
    },
    { fetchedAt: FETCHED, cadenceSec: 300, reference: {} },
  );
  return { features, observations };
}

const datex2 = parkingDomain.formats["datex2"]!;

/** `nl-ndw-truck-parking` as `feeds/parking/nl.jsonc` writes it. */
const ndwFeed = {
  id: "nl-ndw-truck-parking",
  format: "datex2",
  region: "nl",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  attribution: "NDW",
} as ParkingFeed;

/**
 * The Dutch lorry-park feed publishes its table in DATEX II v2 and the status
 * of the same records in DATEX II v3, so one site is assembled from two
 * profiles. Its space groups are the areas the status reports per group.
 */
function ndwTruckParking() {
  return datex2.parse(
    ndwFeed as Parameters<typeof datex2.parse>[0],
    {
      sites: [Buffer.from(text("ndw-parking-table.xml"))],
      status: [Buffer.from(text("ndw-parking-status.xml"))],
    },
    { fetchedAt: FETCHED, cadenceSec: 300, reference: {} },
  );
}

interface AutobahnParking {
  identifier: string;
  title: string;
  subtitle: string;
  coordinate: { coordinates: [number, number] };
  description: string[];
  lorryParkingFeatureIcons: { description?: string }[];
}

/**
 * The German motorway operator publishes its lorry parks with the capacities
 * only inside German prose lines, and a title its own web front end has
 * already failed to fill ("A1 | undefined").
 */
function autobahnLorryParking() {
  const capacity = (lines: string[], label: string) => {
    const line = lines.find((l) => l.startsWith(label));
    const value = line === undefined ? Number.NaN : Number(line.split(":")[1]?.trim());
    return Number.isFinite(value) ? value : undefined;
  };
  return (json("autobahn-parking-lorry.json").parking_lorry as AutobahnParking[]).map((site) => {
    const lorry = capacity(site.description, "LKW Stellplätze");
    const car = capacity(site.description, "PKW Stellplätze");
    const areas = [
      ...(lorry === undefined
        ? []
        : [
            {
              key: "lorry",
              kind: "parking_area",
              details: { kind: "parking_area", v: 1, vehicleType: "truck", capacity: lorry },
            },
          ]),
      ...(car === undefined
        ? []
        : [
            {
              key: "car",
              kind: "parking_area",
              details: { kind: "parking_area", v: 1, vehicleType: "car", capacity: car },
            },
          ]),
    ];
    return {
      id: `oc:feature:de-autobahn-events:${site.identifier}`,
      class: "feature",
      kind: "parking_site",
      type: "rest_area_parking",
      temporality: "static",
      lifecycle: "operational",
      name: de(site.subtitle),
      location: point(...site.coordinate.coordinates),
      provenance: provenance(
        "de-autobahn-events",
        "autobahn-parking",
        site.identifier,
        "Autobahn GmbH des Bundes",
        // verkehr.autobahn.de publishes no licence.
        "NOASSERTION",
      ),
      freshness: { fetchedAt: FETCHED },
      ...(areas.length === 0 ? {} : { components: areas }),
      details: {
        kind: "parking_site",
        v: 1,
        usage: ["truck"],
        ...(lorry === undefined && car === undefined
          ? {}
          : { capacityTotal: (lorry ?? 0) + (car ?? 0) }),
      },
    } as Draft;
  });
}

const minetur = fuelDomain.formats["minetur"]!;

/**
 * `es-minetur-fuel` as `feeds/fuel/es.jsonc` writes it: the fields its records
 * take from the feed (the loader's derived fields play no part in a parse).
 */
const mineturFeed: FuelFeed = {
  id: "es-minetur-fuel",
  format: "minetur",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Ministerio para la Transición Ecológica y el Reto Demográfico (MITECO)",
};

/**
 * Spain publishes every grade of every station in one file, with a decimal
 * comma and an empty string for a grade the station does not sell. The file
 * lists all grades, so an empty one is known-absent rather than unknown.
 */
function mineturStations() {
  const { features, observations } = minetur.parse(
    mineturFeed as Parameters<typeof minetur.parse>[0],
    { main: [Buffer.from(text("minetur-stations.json"))] },
    { fetchedAt: FETCHED, cadenceSec: 1800, reference: {} },
  );
  return { features, observations };
}

const MIMIT_GRADES: Readonly<Record<string, [string, string]>> = {
  Benzina: ["e5", "L"],
  Gasolio: ["diesel", "L"],
  Metano: ["cng", "kg"],
  GPL: ["lpg", "L"],
  "HiQ Diesel": ["diesel_premium", "L"],
  "Blue Super": ["e5", "L"],
  "Blue Diesel": ["diesel_premium", "L"],
};

/**
 * Italy prices the same grade twice, self service and attended, so the two
 * are different products of one station — which is why a price hangs on a
 * product rather than on the station. Methane is sold by the kilogram while
 * everything else is sold by the litre.
 */
function mimitStations() {
  const station = csv("mimit-stations.csv", "|")[0]!;
  const prices = csv("mimit-prices.csv", "|");
  const id = station["idImpianto"]!;
  const prov = provenance("it-mimit", "mimit", id, "MIMIT", "CC-BY-4.0");
  const feature: Feature = {
    id: `oc:feature:it-mimit:${id}`,
    location: {
      ...point(Number(station["Longitudine"]), Number(station["Latitudine"])),
      address: {
        street: station["Indirizzo"],
        city: station["Comune"],
        region: station["Provincia"],
        country: "IT",
      },
    },
    provenance: prov,
  };
  const key = (row: Record<string, string>) => {
    const [grade] = MIMIT_GRADES[row["descCarburante"]!] ?? ["unknown", "L"];
    return `${grade}:${row["isSelf"] === "1" ? "self" : "served"}`;
  };
  const italianTime = (value: string) => {
    const [date, time] = value.split(" ");
    const [day, month, year] = date!.split("/");
    return `${year}-${month}-${day}T${time}+02:00`;
  };
  const known = prices.filter((row) => row["descCarburante"]! in MIMIT_GRADES);
  const features: Draft[] = [
    {
      ...feature,
      class: "feature",
      kind: "fuel_station",
      temporality: "static",
      lifecycle: "operational",
      name: [{ lang: "it", text: station["Nome Impianto"]! }],
      freshness: { fetchedAt: FETCHED },
      components: known.map((row) => {
        const [grade, per] = MIMIT_GRADES[row["descCarburante"]!]!;
        return {
          key: key(row),
          kind: "fuel_product",
          details: {
            kind: "fuel_product",
            v: 1,
            grade,
            per,
            service: row["isSelf"] === "1" ? "self" : "served",
            priceLevel: "standard",
            priceBasis: "gross",
          },
        };
      }),
      details: {
        kind: "fuel_station",
        v: 1,
        brand: station["Bandiera"],
        productsComplete: false,
        truckSuitable: station["Tipo Impianto"] === "Autostradale",
      },
    },
  ];
  const observations = known.map((row) =>
    observation(feature, {
      property: "fuel.price",
      componentKey: key(row),
      result: money(row["prezzo"]!, "EUR", MIMIT_GRADES[row["descCarburante"]!]![1]),
      at: { instant: italianTime(row["dtComu"]!) },
    }),
  );
  return { features, observations };
}

const econtrol = fuelDomain.formats["econtrol"]!;

/**
 * `at-econtrol-fuel` as `feeds/fuel/at.jsonc` writes it: the fields its
 * records take from the feed, its expiry among them.
 */
const econtrolFeed: FuelFeed = {
  id: "at-econtrol-fuel",
  format: "econtrol",
  license: "NOASSERTION",
  attribution: "E-Control (Spritpreisrechner)",
  accessMode: "on_demand",
  onDemand: { cellDeg: 0.1, ttlSec: 900, maxCellsPerRead: 9, probe: [16.37, 48.21] },
};

/**
 * Austria answers only for the area a consumer asks about, so its records are
 * on-demand: they carry the moment their answer goes stale and never enter
 * the history or the federation outbox. The fixture is one diesel answer.
 */
function econtrolStations() {
  const { features, observations } = econtrol.parse(
    econtrolFeed as Parameters<typeof econtrol.parse>[0],
    { main: [Buffer.from(text("econtrol-stations.json"))] },
    { fetchedAt: FETCHED, cadenceSec: 900, reference: {} },
  );
  return { features, observations };
}

const CASES = [
  ["OCPI charging sites", ocpiChargingSites],
  ["ParkAPI parking sites", parkapiSites],
  ["NDW lorry parks", ndwTruckParking],
  ["Autobahn lorry parking", autobahnLorryParking],
  ["MINETUR filling stations", mineturStations],
  ["MIMIT filling stations", mimitStations],
  ["E-Control filling stations", econtrolStations],
] as const;

const recordsOf = (make: (typeof CASES)[number][1]): Draft[] => {
  const produced = make();
  if (Array.isArray(produced)) return produced;
  const offers: Draft[] = "offers" in produced ? (produced.offers as Draft[]) : [];
  return [...produced.features, ...produced.observations, ...offers];
};

describe("facilities fit", () => {
  it.each(CASES)("maps %s onto records that seal", (_name, make) => {
    expect(sealAll(recordsOf(make))).toEqual([]);
  });

  it("seals an OCPI tariff as an offer on its site", () => {
    expect(sealAll(ocpiTariffs())).toEqual([]);
  });

  it("carries the register a relayed charge point came from", () => {
    const site = ocpiChargingSites().features[0]!;
    expect((site["provenance"] as { upstream: unknown[] }).upstream).toEqual([
      { publisher: "bnetza_api", recordId: expect.any(String) },
    ]);
  });

  it("reads a charge point of a static register as being in no known state", () => {
    const status = ocpiChargingSites().observations[0]!;
    expect(status["result"]).toEqual({
      type: "category",
      value: "unknown",
      vocabulary: "evse_status",
    });
  });

  it("converts a height limit published in centimetres", () => {
    const site = parkapiSites().features.find(
      (f) => (f["details"] as { heightLimit?: unknown }).heightLimit !== undefined,
    );
    expect((site!["details"] as { heightLimit: unknown }).heightLimit).toEqual({
      value: 2,
      unit: "m",
    });
  });

  it("keeps a lorry park's own rating scheme rather than converting it", () => {
    const site = ndwTruckParking().features[0]!;
    expect((site["details"] as { securityRating?: unknown }).securityRating).toEqual({
      scheme: "eu_label",
      level: "3",
    });
  });

  it("records an impossible count as no reading instead of repairing it", () => {
    // The feed computes occupied spaces from a capacity it does not always
    // have, and publishes the difference even when it comes out negative. A
    // count of minus 1 261 lorries is not a reading.
    const { features, observations } = ndwTruckParking();
    const asten = features.find((f) => String(f["id"]).endsWith(":NL-12_8"))!["id"];
    const occupied = observations.filter(
      (o) =>
        o["property"] === "parking.occupied" &&
        (o["subject"] as { featureId: string }).featureId === asten,
    );
    expect(occupied).toEqual([]);
    expect(observations.every((o) => (o["result"] as { type: string }).type !== "unknown")).toBe(
      true,
    );
  });

  it("keeps the occupancy numbers a feed publishes as their own series, and drops an impossible one", () => {
    const { observations } = ndwTruckParking();
    const properties = observations
      .filter((o) => (o["subject"] as { componentKey?: string }).componentKey === undefined)
      .map((o) => o["property"]);
    // Both sites report more free spaces (1746, 1601) than their groups hold
    // (402, 420): no free count, while the occupied count and share stand.
    expect(new Set(properties)).toEqual(
      new Set(["parking.occupied", "parking.occupancy_pct", "parking.status"]),
    );
  });

  it("prices the same grade twice when a station sells it self and attended", () => {
    const { features, observations } = mimitStations();
    const keys = (features[0]!["components"] as { key: string }[]).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["e5:self", "e5:served"]));
    const series = observations.map((o) => (o["subject"] as { componentKey: string }).componentKey);
    expect(new Set(series).size).toBe(series.length);
  });

  it("prices methane by the kilogram and petrol by the litre", () => {
    const { observations } = mimitStations();
    const per = new Map(
      observations.map((o) => [
        (o["subject"] as { componentKey: string }).componentKey,
        (o["result"] as { per: string }).per,
      ]),
    );
    expect(per.get("cng:served")).toBe("kg");
    expect(per.get("e5:self")).toBe("L");
  });

  it("treats a grade a complete list leaves empty as one the station does not sell", () => {
    const [station] = mineturStations().features;
    const grades = (station!["components"] as { key: string }[]).map((c) => c.key);
    expect((station!["details"] as { productsComplete: boolean }).productsComplete).toBe(true);
    expect(grades).toContain("diesel");
    expect(grades).not.toContain("adblue");
  });

  it("makes an on-demand answer say when it expires", () => {
    const records = recordsOf(econtrolStations);
    expect(
      records.every((r) => (r["freshness"] as { expiresAt?: string }).expiresAt !== undefined),
    ).toBe(true);
    const noExpiry = records.map((r) => ({ ...r, freshness: { fetchedAt: FETCHED } }));
    expect(sealAll(noExpiry).length).toBe(records.length);
  });

  it("seals records the stored schema takes as they are", () => {
    const drafts = [...CASES.flatMap(([, make]) => recordsOf(make)), ...ocpiTariffs()];
    for (const draft of drafts) {
      const sealed = sealRecord(registry, draft, {
        instanceId: "fit.example",
        revision: 1,
        recordedAt: FETCHED,
      });
      if (!sealed.ok) continue;
      const validated = registry.validate(sealed.value);
      expect(validated.ok, String(draft["id"])).toBe(true);
      if (validated.ok) expect(validated.value).toEqual(sealed.value);
    }
  });

  // The storage tests write these records through the record tables.
  it("seals every record as its golden file holds it", async () => {
    const drafts = [...CASES.flatMap(([, make]) => recordsOf(make)), ...ocpiTariffs()];
    const sealed = drafts.map((r) => {
      const result = sealRecord(registry, r, {
        instanceId: "fit.example",
        revision: 1,
        recordedAt: FETCHED,
      });
      return result.ok ? result.value : { id: r["id"], issues: result.issues };
    });
    await expect(`${JSON.stringify(sealed, null, 2)}\n`).toMatchFileSnapshot(
      join(import.meta.dirname, "golden", "facilities.json"),
    );
  });
});
