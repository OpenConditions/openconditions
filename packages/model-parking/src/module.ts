import {
  buildCrosswalk,
  defineDomain,
  extendVocabulary,
  type RegistryModule,
  vocabularyCrosswalk,
  withFeatureCrosswalks,
  withPropertyCrosswalks,
} from "@openconditions/model";
import {
  DATEX2_PARKING_MEASURES,
  DATEX2_PARKING_MEASURES_OUT,
  DATEX2_PARKING_SECURITY,
  DATEX2_PARKING_SECURITY_OUT,
  DATEX2_PARKING_TRENDS_OUT,
  DATEX2_V2_FACILITIES,
  DATEX2_V2_PARKING_STATUSES,
  DATEX2_V2_PARKING_STATUSES_OUT,
  DATEX2_V2_PARKING_TRENDS,
  DATEX2_V2_PARKING_TYPES,
  DATEX2_V3_FACILITIES,
  DATEX2_V3_PARKING_STATUSES,
  DATEX2_V3_PARKING_STATUSES_OUT,
  DATEX2_V3_PARKING_TRENDS,
  DATEX2_V3_PARKING_TYPES,
  DATEX2_V3_PARKING_TYPES_OUT,
} from "./crosswalk/datex2.js";
import { PARKAPI_PARKING_TYPES } from "./crosswalk/parkapi.js";
import {
  PARKING_KINDS,
  PARKING_PROPERTIES,
  parkingSecurityVocabulary,
  parkingStatusVocabulary,
} from "./kinds.js";

const parkingKinds = withFeatureCrosswalks(
  PARKING_KINDS,
  [
    { target: "datex2_v3", table: DATEX2_V3_PARKING_TYPES },
    { target: "datex2_v2", table: DATEX2_V2_PARKING_TYPES },
    { target: "parkapi", table: PARKAPI_PARKING_TYPES },
    { target: "osm", table: { "amenity=parking": "parking_site" } },
  ],
  [{ target: "datex2_v3", table: DATEX2_V3_PARKING_TYPES_OUT }],
);

const parkingProperties = withPropertyCrosswalks(
  PARKING_PROPERTIES,
  [
    { target: "datex2_v3", table: DATEX2_PARKING_MEASURES },
    { target: "datex2_v2", table: DATEX2_PARKING_MEASURES },
  ],
  [{ target: "datex2_v3", table: DATEX2_PARKING_MEASURES_OUT }],
);

/** The publisher formats the parking parsers read; the shared standards and layouts are the kernel's. */
export const PARKING_SOURCE_FORMATS = [
  "parkapi-v3",
  "datex2-light",
  "db-bahnpark",
  "rdw",
  "sbb",
  "opendatahub",
  "hdb",
  "utmc",
  "tfnsw",
] as const;

/**
 * The parking registry module: the `parking` domain, parking sites with
 * their areas and spaces, the occupancy properties, the parking-rate offer
 * and the source formats of the parking publishers. Definitions only.
 *
 * ParkAPI's classification is not a vocabulary crosswalk but a pair of
 * fields, so its table is exported for parsers and indexed here under the
 * combined code.
 */
export const parkingModule: RegistryModule = {
  name: "parking",
  entries: [
    defineDomain({
      code: "parking",
      description: "Where vehicles can be parked, and how full it is.",
    }),
    extendVocabulary({ vocabulary: "source_format", values: PARKING_SOURCE_FORMATS }),
    parkingStatusVocabulary,
    parkingSecurityVocabulary,
    ...parkingKinds,
    ...parkingProperties,
    vocabularyCrosswalk(
      "parking_status",
      [
        { target: "datex2_v3", table: DATEX2_V3_PARKING_STATUSES },
        { target: "datex2_v2", table: DATEX2_V2_PARKING_STATUSES },
      ],
      [
        { target: "datex2_v3", table: DATEX2_V3_PARKING_STATUSES_OUT },
        { target: "datex2_v2", table: DATEX2_V2_PARKING_STATUSES_OUT },
      ],
    ),
    vocabularyCrosswalk(
      "trend",
      [
        { target: "datex2_v3", table: DATEX2_V3_PARKING_TRENDS },
        { target: "datex2_v2", table: DATEX2_V2_PARKING_TRENDS },
      ],
      [{ target: "datex2_v3", table: DATEX2_PARKING_TRENDS_OUT }],
    ),
    vocabularyCrosswalk(
      "parking_security",
      [
        { target: "datex2_v3", table: DATEX2_PARKING_SECURITY },
        { target: "datex2_v2", table: DATEX2_PARKING_SECURITY },
      ],
      [
        { target: "datex2_v3", table: DATEX2_PARKING_SECURITY_OUT },
        { target: "datex2_v2", table: DATEX2_PARKING_SECURITY_OUT },
      ],
    ),
    vocabularyCrosswalk(
      "amenity",
      [
        { target: "datex2_v2", table: DATEX2_V2_FACILITIES },
        { target: "datex2_v3", table: DATEX2_V3_FACILITIES },
      ],
      [],
    ),
  ],
};

/** The parking crosswalks, for parsers that cannot depend on the assembled registry. */
export const parkingCrosswalk = buildCrosswalk(parkingModule.entries);
