import {
  buildCrosswalk,
  defineDomain,
  extendVocabulary,
  type RegistryModule,
  vocabularyCrosswalk,
  withFeatureCrosswalks,
} from "@openconditions/model";
import {
  DATEX2_CONNECTOR_STANDARDS,
  DATEX2_CONNECTOR_STANDARDS_OUT,
  DATEX2_ENERGY_SITE_TYPES,
  DATEX2_REFILL_POINT_STATUSES,
  DATEX2_REFILL_POINT_STATUSES_OUT,
} from "./crosswalk/datex2.js";
import {
  OCPI_CONNECTOR_STANDARDS,
  OCPI_CONNECTOR_STANDARDS_OUT,
  OCPI_EVSE_STATUSES,
  OCPI_EVSE_STATUSES_OUT,
  OCPI_FACILITIES,
  OCPI_FACILITIES_OUT,
} from "./crosswalk/ocpi.js";
import { OICP_EVSE_STATUSES } from "./crosswalk/oicp.js";
import {
  CHARGING_KINDS,
  CHARGING_PROPERTIES,
  chargingSiteStatusVocabulary,
  connectorStandardVocabulary,
  evseStatusVocabulary,
} from "./kinds.js";

const chargingKinds = withFeatureCrosswalks(
  CHARGING_KINDS,
  [
    { target: "datex2_v3", table: DATEX2_ENERGY_SITE_TYPES },
    { target: "osm", table: { "amenity=charging_station": "charging_site" } },
  ],
  [],
);

/**
 * The publisher formats the charging parsers read; the shared standards and
 * layouts are the kernel's. Digitraffic and LTA publish charging data in the
 * same formats as their road data, which roads already registers.
 */
export const CHARGING_SOURCE_FORMATS = [
  "ocpi",
  "oicp",
  "bnetza",
  "irve",
  "afdc",
  "nobil",
  "eipa",
  "cynap",
  "chargy",
  "evroam",
  "keco",
  "tdx",
  "ocm",
] as const;

/**
 * The charging registry module: the `charging` domain, charging sites with
 * their charge points and connectors, the status properties, the energy
 * tariff offer and the source formats of the charging publishers.
 * Definitions only.
 */
export const chargingModule: RegistryModule = {
  name: "charging",
  entries: [
    defineDomain({
      code: "charging",
      description: "Where an electric vehicle can charge, and whether a point is free.",
    }),
    extendVocabulary({ vocabulary: "source_format", values: CHARGING_SOURCE_FORMATS }),
    evseStatusVocabulary,
    chargingSiteStatusVocabulary,
    connectorStandardVocabulary,
    ...chargingKinds,
    ...CHARGING_PROPERTIES,
    vocabularyCrosswalk(
      "evse_status",
      [
        { target: "ocpi", table: OCPI_EVSE_STATUSES },
        { target: "oicp", table: OICP_EVSE_STATUSES },
        { target: "datex2_v3", table: DATEX2_REFILL_POINT_STATUSES },
      ],
      [
        { target: "ocpi", table: OCPI_EVSE_STATUSES_OUT },
        { target: "datex2_v3", table: DATEX2_REFILL_POINT_STATUSES_OUT },
      ],
    ),
    vocabularyCrosswalk(
      "connector_standard",
      [
        { target: "ocpi", table: OCPI_CONNECTOR_STANDARDS },
        { target: "datex2_v3", table: DATEX2_CONNECTOR_STANDARDS },
      ],
      [
        { target: "ocpi", table: OCPI_CONNECTOR_STANDARDS_OUT },
        { target: "datex2_v3", table: DATEX2_CONNECTOR_STANDARDS_OUT },
      ],
    ),
    vocabularyCrosswalk(
      "amenity",
      [{ target: "ocpi", table: OCPI_FACILITIES }],
      [{ target: "ocpi", table: OCPI_FACILITIES_OUT }],
    ),
  ],
};

/** The charging crosswalks, for parsers that cannot depend on the assembled registry. */
export const chargingCrosswalk = buildCrosswalk(chargingModule.entries);
