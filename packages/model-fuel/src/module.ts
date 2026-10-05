import {
  buildCrosswalk,
  defineDomain,
  extendVocabulary,
  type RegistryModule,
  vocabularyCrosswalk,
  withFeatureCrosswalks,
} from "@openconditions/model";
import {
  DATEX2_V2_FUEL_GRADES,
  DATEX2_V3_FUEL_GRADES,
  DATEX2_V3_FUEL_GRADES_OUT,
} from "./crosswalk/datex2.js";
import { FUEL_KINDS, FUEL_PROPERTIES, fuelGradeVocabulary } from "./kinds.js";

/** The wire formats the fuel parsers read. */
export const FUEL_SOURCE_FORMATS = [
  "tankerkoenig",
  "econtrol",
  "prix-carburants",
  "minetur",
] as const;

const fuelKinds = withFeatureCrosswalks(
  FUEL_KINDS,
  [{ target: "osm", table: { "amenity=fuel": "fuel_station" } }],
  [],
);

/**
 * The fuel registry module: the `fuel` domain, filling stations with their
 * products, and the price, price-cap and availability properties.
 * Definitions only.
 */
export const fuelModule: RegistryModule = {
  name: "fuel",
  entries: [
    defineDomain({
      code: "fuel",
      description: "Where fuel is sold, and what it costs.",
    }),
    /** US regional averages are published per Petroleum Administration for Defense District. */
    extendVocabulary({ vocabulary: "admin_geocode_scheme", values: ["padd"] }),
    extendVocabulary({ vocabulary: "source_format", values: FUEL_SOURCE_FORMATS }),
    fuelGradeVocabulary,
    ...fuelKinds,
    ...FUEL_PROPERTIES,
    vocabularyCrosswalk(
      "fuel_grade",
      [
        { target: "datex2_v3", table: DATEX2_V3_FUEL_GRADES },
        { target: "datex2_v2", table: DATEX2_V2_FUEL_GRADES },
      ],
      [{ target: "datex2_v3", table: DATEX2_V3_FUEL_GRADES_OUT }],
    ),
  ],
};

/** The fuel crosswalks, for parsers that cannot depend on the assembled registry. */
export const fuelCrosswalk = buildCrosswalk(fuelModule.entries);
