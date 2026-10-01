import { readFileSync } from "node:fs";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type RegistryModule,
  sealRecord,
} from "@openconditions/model";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Facilities fit check: real published records of parking sites, charging
 * sites and filling stations, mapped onto Feature, Component, Observation and
 * Offer and sealed against the production registry. Records captured
 * 2026-09-22 from the MobiData BW charge-point database (OCPI 2.2 locations
 * and tariffs, CC BY 4.0), MobiData BW ParkAPI v3 (parking sites and their
 * upstream sources), NDW (CC0: lorry-park table in DATEX II v2 and its status
 * in DATEX II v3), Autobahn GmbH (lorry parking along the A1, CC BY 4.0),
 * MINETUR (Spain, prices per grade), MIMIT (Italy, self and attended prices)
 * and E-Control (Austria, an on-demand source queried by radius).
 * OpenConditions parses none of these formats yet, so they are registered by
 * a test-only module.
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
      values: [
        "ocpi",
        "parkapi",
        "datex2-parking",
        "autobahn-parking",
        "minetur",
        "mimit",
        "econtrol",
      ],
    }),
  ],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const crosswalk = registry.crosswalk;
const FETCHED = "2026-09-22T11:10:00Z";

const text = (name: string) =>
  readFileSync(new URL(`./fixtures/facilities/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(text(name));
const xml = (name: string) =>
  new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true }).parse(
    text(name),
  );
const list = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
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

const count = (value: number) => ({ type: "count", value });
const quantity = (value: number, unit: string) => ({ type: "quantity", value, unit });
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

interface ParkapiSite {
  id: number;
  source_id: number;
  original_uid: string;
  name: string;
  operator_name?: string;
  public_url?: string;
  address?: string;
  type: string;
  purpose: string;
  max_height?: number;
  capacity?: number;
  capacity_disabled?: number;
  capacity_woman?: number;
  capacity_family?: number;
  capacity_charging?: number;
  realtime_free_capacity?: number;
  realtime_data_updated_at?: string;
  static_data_updated_at: string;
  lat: number;
  lon: number;
}

const PARKAPI_AREAS: Readonly<Record<string, string>> = {
  capacity_disabled: "disabled",
  capacity_woman: "women",
  capacity_family: "family",
  capacity_charging: "ev_charging",
};

/**
 * ParkAPI relays city and operator feeds, so every site names the source it
 * came from. Its per-user-group capacities become areas of the site, and its
 * height limit is published in centimetres.
 */
function parkapiSites() {
  const sources = new Map<
    number,
    { uid: string; name: string; attribution_license: string | null }
  >(
    (
      json("parkapi-sources.json").items as {
        id: number;
        uid: string;
        name: string;
        attribution_license: string | null;
      }[]
    ).map((s) => [s.id, s]),
  );
  const features: Draft[] = [];
  const observations: Draft[] = [];
  for (const site of json("parkapi-sites.json").items as ParkapiSite[]) {
    const source = sources.get(site.source_id);
    const prov = {
      ...provenance("de-bw-parkapi", "parkapi", String(site.id), "MobiData BW", "CC-BY-4.0"),
      ...(source === undefined
        ? {}
        : {
            upstream: [
              {
                publisher: source.uid,
                recordId: site.original_uid,
                ...(source.attribution_license === null
                  ? {}
                  : { license: source.attribution_license }),
              },
            ],
          }),
    };
    const feature: Feature = {
      id: `oc:feature:de-bw-parkapi:${site.id}`,
      location: {
        ...point(site.lon, site.lat),
        ...(site.address === undefined ? {} : { address: { text: site.address, country: "DE" } }),
      },
      provenance: prov,
    };
    const classification = crosswalk.feature(
      "parkapi",
      `purpose:${site.purpose}|type:${site.type}`,
    );
    const areas = Object.entries(PARKAPI_AREAS)
      .filter(([field]) => ((site as unknown as Record<string, number>)[field] ?? 0) > 0)
      .map(([field, userGroup]) => ({
        key: field,
        kind: "parking_area",
        details: {
          kind: "parking_area",
          v: 1,
          vehicleType: site.purpose === "BIKE" ? "bicycle" : "car",
          userGroup,
          capacity: (site as unknown as Record<string, number>)[field]!,
        },
      }));
    features.push({
      ...feature,
      class: "feature",
      kind: "parking_site",
      ...(classification?.type === undefined ? {} : { type: classification.type }),
      temporality: "static",
      lifecycle: "operational",
      name: de(site.name),
      ...(site.operator_name === undefined
        ? {}
        : {
            operator: { role: "operator", name: de(site.operator_name), website: site.public_url },
          }),
      freshness: { fetchedAt: FETCHED },
      ...(areas.length === 0 ? {} : { components: areas }),
      details: {
        kind: "parking_site",
        v: 1,
        ...(site.capacity === undefined ? {} : { capacityTotal: site.capacity }),
        ...(site.max_height === undefined
          ? {}
          : { heightLimit: { value: site.max_height / 100, unit: "m" } }),
      },
    });
    if (site.realtime_free_capacity !== undefined && site.realtime_data_updated_at !== undefined) {
      observations.push(
        observation(feature, {
          property: "parking.available",
          result: count(site.realtime_free_capacity),
          at: { instant: site.realtime_data_updated_at },
        }),
      );
    }
  }
  return { features, observations };
}

interface NdwGroup {
  "@groupIndex": string;
  assignedParkingAmongOthers?: { vehicleType?: string; vehicleType2?: string };
  parkingNumberOfSpaces?: number;
}
interface NdwRecord {
  "@id": string;
  parkingName?: { values: { value: string | { "#text": string } } };
  parkingLocation: {
    pointByCoordinates: { pointCoordinates: { latitude: number; longitude: number } };
  };
  groupOfParkingSpaces?: NdwGroup | NdwGroup[];
  parkingUsageScenario?: { parkingUsageScenario: { parkingUsageScenario: string } };
  parkingStandardsAndSecurity?: {
    labelSecurityLevel?: string;
    parkingSecurity?: string | string[];
    parkingSupervision?: string | string[];
  };
  parkingEquipmentOrServiceFacility?: unknown;
}

const NDW_VEHICLES: Readonly<Record<string, string>> = {
  lorry: "truck",
  car: "car",
  bus: "bus",
  coach: "coach",
  motorcycle: "motorcycle",
  caravan: "caravan",
  heavyHaulageVehicle: "truck",
};
const NDW_SUPERVISION: Readonly<Record<string, string>> = {
  remote: "remote",
  onSite: "on_site",
  controlCentreOnSite: "control_centre",
  controlCentreOffSite: "control_centre",
  patrol: "patrol",
  none: "none",
};

/**
 * The Dutch lorry-park feed publishes its table in DATEX II v2 and the status
 * of the same records in DATEX II v3, so one site is assembled from two
 * profiles. Its space groups are the areas the status reports per group.
 */
function ndwTruckParking() {
  const table = xml("ndw-parking-table.xml");
  const status = xml("ndw-parking-status.xml");
  // The v2 profile has no parking publication of its own: the table arrives
  // inside a generic publication's extension.
  const records = list<NdwRecord>(
    table.d2LogicalModel.payloadPublication.genericPublicationExtension.parkingTablePublication
      .parkingTable.parkingRecord,
  );
  const statuses = new Map<string, Record<string, never>>(
    list<Record<string, never>>(status.payload.parkingRecordStatus).map((s) => [
      (s as unknown as { parkingRecordReference: { "@id": string } }).parkingRecordReference["@id"],
      s,
    ]),
  );
  const features: Draft[] = [];
  const observations: Draft[] = [];
  for (const record of records) {
    const id = record["@id"];
    const coords = record.parkingLocation.pointByCoordinates.pointCoordinates;
    const prov = provenance("nl-ndw-truckparking", "datex2-parking", id, "NDW", "CC0-1.0");
    const feature: Feature = {
      id: `oc:feature:nl-ndw-truckparking:${id}`,
      location: point(coords.longitude, coords.latitude),
      provenance: prov,
    };
    const groups = list(record.groupOfParkingSpaces);
    const areas = groups.map((group) => {
      const vehicle =
        group.assignedParkingAmongOthers?.vehicleType ??
        group.assignedParkingAmongOthers?.vehicleType2;
      return {
        key: group["@groupIndex"],
        kind: "parking_area",
        details: {
          kind: "parking_area",
          v: 1,
          vehicleType: vehicle === undefined ? "any" : (NDW_VEHICLES[vehicle] ?? "any"),
          ...(group.parkingNumberOfSpaces === undefined
            ? {}
            : { capacity: group.parkingNumberOfSpaces }),
        },
      };
    });
    const security = record.parkingStandardsAndSecurity;
    const features_ = list(security?.parkingSecurity)
      .map((v) => crosswalk.value("parking_security", "datex2_v2", v))
      .filter((v): v is string => v !== undefined);
    const supervision = list(security?.parkingSupervision)[0];
    const scenario = record.parkingUsageScenario?.parkingUsageScenario.parkingUsageScenario;
    const classification =
      scenario === undefined
        ? undefined
        : crosswalk.feature("datex2_v2", `usageScenario:${scenario}`);
    const name = record.parkingName?.values.value;
    features.push({
      ...feature,
      class: "feature",
      kind: "parking_site",
      ...(classification?.type === undefined ? {} : { type: classification.type }),
      temporality: "static",
      lifecycle: "operational",
      ...(name === undefined
        ? {}
        : { name: [{ lang: "nl", text: typeof name === "string" ? name : name["#text"] }] }),
      externalIds: [{ scheme: "datex:parking", id, authority: "NDW" }],
      freshness: { fetchedAt: FETCHED },
      ...(areas.length === 0 ? {} : { components: areas }),
      details: {
        kind: "parking_site",
        v: 1,
        ...(security?.labelSecurityLevel === undefined
          ? {}
          : {
              securityRating: {
                scheme: "eu_label",
                level: security.labelSecurityLevel.replace("securityLevel", ""),
              },
            }),
        ...(features_.length === 0 ? {} : { securityFeatures: features_ }),
        ...(supervision === undefined
          ? {}
          : { supervision: NDW_SUPERVISION[supervision] ?? "unknown" }),
      },
    });
    const recordStatus = statuses.get(id) as
      | {
          parkingStatusOriginTime: string;
          parkingOccupancy?: {
            parkingNumberOfVacantSpaces?: number;
            parkingNumberOfOccupiedSpaces?: number;
            parkingOccupancy?: number;
          };
          groupOfParkingSpacesStatus?: unknown;
        }
      | undefined;
    if (recordStatus === undefined) continue;
    const at = { instant: recordStatus.parkingStatusOriginTime };
    const occupancy = recordStatus.parkingOccupancy;
    if (occupancy?.parkingNumberOfVacantSpaces !== undefined) {
      observations.push(
        observation(feature, {
          property: "parking.available",
          result: count(occupancy.parkingNumberOfVacantSpaces),
          at,
        }),
      );
    }
    if (occupancy?.parkingNumberOfOccupiedSpaces !== undefined) {
      // The feed computes occupied spaces from a capacity it does not always
      // have, and publishes the difference even when it comes out negative.
      // A count of minus 1 261 lorries is not a reading, so it is recorded as
      // unknown rather than repaired into a plausible number.
      const occupied = occupancy.parkingNumberOfOccupiedSpaces;
      observations.push(
        observation(feature, {
          property: "parking.occupied",
          result: occupied >= 0 ? count(occupied) : { type: "unknown" },
          at,
        }),
      );
    }
    if (occupancy?.parkingOccupancy !== undefined) {
      observations.push(
        observation(feature, {
          property: "parking.occupancy_pct",
          result: quantity(occupancy.parkingOccupancy, "%"),
          at,
        }),
      );
    }
    for (const group of list<{
      "@groupIndex": string;
      groupOfParkingSpacesStatus: { parkingNumberOfVacantSpaces?: number };
    }>(recordStatus.groupOfParkingSpacesStatus as never)) {
      const vacant = group.groupOfParkingSpacesStatus.parkingNumberOfVacantSpaces;
      if (vacant === undefined || !areas.some((a) => a.key === group["@groupIndex"])) continue;
      observations.push(
        observation(feature, {
          property: "parking.available",
          componentKey: group["@groupIndex"],
          result: count(vacant),
          at,
        }),
      );
    }
  }
  return { features, observations };
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
      id: `oc:feature:de-autobahn:${site.identifier}`,
      class: "feature",
      kind: "parking_site",
      type: "rest_area_parking",
      temporality: "static",
      lifecycle: "operational",
      name: de(site.subtitle),
      location: point(...site.coordinate.coordinates),
      provenance: provenance(
        "de-autobahn",
        "autobahn-parking",
        site.identifier,
        "Autobahn GmbH des Bundes",
        "CC-BY-4.0",
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

const MINETUR_GRADES: Readonly<Record<string, [string, string]>> = {
  "Precio Gasolina 95 E5": ["e5", "L"],
  "Precio Gasolina 95 E10": ["e10", "L"],
  "Precio Gasolina 98 E5": ["sp98", "L"],
  "Precio Gasolina 98 E10": ["sp98", "L"],
  "Precio Gasoleo A": ["diesel", "L"],
  "Precio Gasoleo Premium": ["diesel_premium", "L"],
  "Precio Gasoleo B": ["agricultural_diesel", "L"],
  "Precio Diésel Renovable": ["hvo100", "L"],
  "Precio Biodiesel": ["b100", "L"],
  "Precio Bioetanol": ["ethanol", "L"],
  "Precio Gases licuados del petróleo": ["lpg", "L"],
  "Precio Gas Natural Comprimido": ["cng", "kg"],
  "Precio Gas Natural Licuado": ["lng", "kg"],
  "Precio Hidrogeno": ["h2_700", "kg"],
  "Precio Adblue": ["adblue", "L"],
  "Precio Metanol": ["methanol", "L"],
  "Precio Amoniaco": ["ammonia", "kg"],
  "Precio Gasolina 95 E25": ["e25", "L"],
  "Precio Gasolina 95 E85": ["e85", "L"],
  "Precio Gasolina Renovable": ["renewable_petrol", "L"],
  "Precio Biogas Natural Comprimido": ["cng", "kg"],
  "Precio Biogas Natural Licuado": ["lng", "kg"],
  "Precio Gasolina 95 E5 Premium": ["e5", "L"],
};

/**
 * Spain publishes every grade of every station in one file, with a decimal
 * comma and an empty string for a grade the station does not sell. The file
 * lists all grades, so an empty one is known-absent rather than unknown.
 */
function mineturStations() {
  const file = json("minetur-stations.json");
  const publicationTime = "2026-09-22T11:07:59Z";
  const features: Draft[] = [];
  const observations: Draft[] = [];
  for (const station of file.ListaEESSPrecio as Record<string, string>[]) {
    const id = station["IDEESS"]!;
    const decimal = (value: string) => value.replace(",", ".");
    const prov = provenance(
      "es-minetur",
      "minetur",
      id,
      "Ministerio para la Transición Ecológica",
      "CC-BY-4.0",
    );
    const feature: Feature = {
      id: `oc:feature:es-minetur:${id}`,
      location: {
        ...point(
          Number(decimal(station["Longitud (WGS84)"]!)),
          Number(decimal(station["Latitud"]!)),
        ),
        address: {
          street: station["Dirección"],
          postalCode: station["C.P."],
          city: station["Municipio"],
          country: "ES",
        },
        admin: { country: "ES", geocodes: [{ scheme: "iso3166-2", code: "ES-M" }] },
      },
      provenance: prov,
    };
    const sold = Object.entries(MINETUR_GRADES).filter(([field]) => (station[field] ?? "") !== "");
    features.push({
      ...feature,
      class: "feature",
      kind: "fuel_station",
      temporality: "static",
      lifecycle: "operational",
      name: [{ lang: "es", text: station["Rótulo"]! }],
      freshness: { fetchedAt: FETCHED },
      access: { audience: station["Tipo Venta"] === "P" ? "public" : "restricted" },
      components: sold.map(([, [grade, per]]) => ({
        key: grade,
        kind: "fuel_product",
        details: {
          kind: "fuel_product",
          v: 1,
          grade,
          per,
          priceBasis: "gross",
          priceLevel: "standard",
          vehicleScope: "any",
        },
      })),
      details: { kind: "fuel_station", v: 1, brand: station["Rótulo"], productsComplete: true },
    });
    for (const [field, [grade]] of sold) {
      observations.push(
        observation(feature, {
          property: "fuel.price",
          componentKey: grade,
          result: money(decimal(station[field]!), "EUR", MINETUR_GRADES[field]![1]),
          at: { instant: publicationTime },
        }),
      );
    }
  }
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

const ECONTROL_GRADES: Readonly<Record<string, string>> = { DIE: "diesel", SUP: "e5", GAS: "lpg" };

/**
 * Austria answers only for the area a consumer asks about, so its records are
 * on-demand: they carry the moment their answer goes stale and never enter
 * the history or the federation outbox.
 */
function econtrolStations() {
  const expiresAt = "2026-09-22T11:40:00Z";
  const features: Draft[] = [];
  const observations: Draft[] = [];
  for (const station of json("econtrol-stations.json") as {
    id: number;
    name: string;
    location: {
      address: string;
      postalCode: string;
      city: string;
      latitude: number;
      longitude: number;
    };
    offerInformation: { service: boolean; selfService: boolean };
    open: boolean;
    prices: { fuelType: string; amount: number }[];
  }[]) {
    const prov = provenance(
      "at-econtrol",
      "econtrol",
      String(station.id),
      "E-Control",
      "CC-BY-4.0",
      "on_demand",
    );
    const feature: Feature = {
      id: `oc:feature:at-econtrol:${station.id}`,
      location: {
        ...point(station.location.longitude, station.location.latitude),
        address: {
          street: station.location.address,
          postalCode: station.location.postalCode,
          city: station.location.city,
          country: "AT",
        },
      },
      provenance: prov,
      freshness: { fetchedAt: FETCHED, expiresAt },
    };
    const products = station.prices
      .map((p) => ({ price: p, grade: ECONTROL_GRADES[p.fuelType] }))
      .filter(
        (p): p is { price: { fuelType: string; amount: number }; grade: string } =>
          p.grade !== undefined,
      );
    features.push({
      ...feature,
      class: "feature",
      kind: "fuel_station",
      temporality: "static",
      lifecycle: station.open ? "operational" : "temporarily_closed",
      name: de(station.name),
      freshness: { fetchedAt: FETCHED, expiresAt },
      components: products.map(({ grade }) => ({
        key: grade,
        kind: "fuel_product",
        details: {
          kind: "fuel_product",
          v: 1,
          grade,
          per: "L",
          priceBasis: "gross",
          service: station.offerInformation.selfService ? "self" : "served",
        },
      })),
      details: { kind: "fuel_station", v: 1, productsComplete: false },
    });
    for (const { price, grade } of products) {
      observations.push(
        observation(feature, {
          property: "fuel.price",
          componentKey: grade,
          result: money(price.amount.toFixed(3), "EUR", "L"),
          at: { instant: FETCHED },
        }),
      );
    }
  }
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
  return Array.isArray(produced) ? produced : [...produced.features, ...produced.observations];
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

  it("records an impossible count as unknown instead of repairing it", () => {
    const { observations } = ndwTruckParking();
    const occupied = observations.filter((o) => o["property"] === "parking.occupied");
    expect(occupied.map((o) => (o["result"] as { type: string }).type)).toContain("unknown");
  });

  it("keeps the three occupancy numbers a feed publishes as three series", () => {
    const { observations } = ndwTruckParking();
    const properties = observations.map((o) => o["property"]);
    expect(new Set(properties)).toEqual(
      new Set(["parking.available", "parking.occupied", "parking.occupancy_pct"]),
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
});
