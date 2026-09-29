import {
  buildCrosswalk,
  defineDomain,
  type RegistryModule,
  vocabularyCrosswalk,
} from "@openconditions/model";
import {
  DATEX2_OPENING_STATUSES_OUT,
  DATEX2_V2_OPENING_STATUSES,
  DATEX2_V3_OPENING_STATUSES,
} from "./crosswalk/datex2.js";
import { FACILITIES_KINDS, FACILITIES_PROPERTIES, facilityOpenStatusVocabulary } from "./kinds.js";

/**
 * The facilities registry module: the `facilities` domain, rest areas and
 * weigh stations, and whether an operated site is open. The open status is
 * observed on any feature kind with the kernel's `operated_site` trait, so
 * toll plazas and border crossings of other modules share it. Definitions
 * only: OpenConditions parses no facility feed yet.
 */
export const facilitiesModule: RegistryModule = {
  name: "facilities",
  entries: [
    defineDomain({
      code: "facilities",
      description:
        "Roadside facilities for drivers and vehicles: rest areas, service areas, weigh stations.",
    }),
    facilityOpenStatusVocabulary,
    ...FACILITIES_KINDS,
    ...FACILITIES_PROPERTIES,
    vocabularyCrosswalk(
      "facility_open_status",
      [
        { target: "datex2_v3", table: DATEX2_V3_OPENING_STATUSES },
        { target: "datex2_v2", table: DATEX2_V2_OPENING_STATUSES },
      ],
      [{ target: "datex2_v3", table: DATEX2_OPENING_STATUSES_OUT }],
    ),
  ],
};

/** The facilities crosswalks, for parsers that cannot depend on the assembled registry. */
export const facilitiesCrosswalk = buildCrosswalk(facilitiesModule.entries);
