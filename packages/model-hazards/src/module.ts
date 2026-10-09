import {
  buildCrosswalk,
  defineDomain,
  extendVocabulary,
  type RegistryModule,
  vocabularyCrosswalk,
  withSituationCrosswalks,
} from "@openconditions/model";
import { alertKind, CAP_VOCABULARIES } from "./alerts.js";
import {
  CAP_CATEGORIES,
  CAP_CERTAINTIES,
  CAP_MSG_TYPES,
  CAP_RESPONSE_TYPES,
  CAP_SCOPES,
  CAP_SEVERITIES,
  CAP_SEVERITY_LABELS,
  CAP_STATUSES,
  CAP_URGENCIES,
} from "./crosswalk/cap.js";
import {
  CAP_CP_CLASSES,
  DWD_II_CLASSES,
  METEOALARM_CLASSES,
  NWS_CLASSES,
  SAME_CLASSES,
  VTEC_CLASSES,
} from "./crosswalk/cap-events.js";
import { GTFS_RT_HAZARD_CAUSES, ROAD511_HAZARD_TYPES } from "./crosswalk/emitters.js";
import { FIRE_PROPERTIES, naturalHazardKind } from "./natural-hazards.js";

const cap = (vocabulary: string, table: Readonly<Record<string, string | null>>) =>
  vocabularyCrosswalk(vocabulary, [{ target: "cap", table }], []);

/**
 * The wire formats hazards parses: CAP XML, NWS's GeoJSON-LD projection of
 * CAP, MeteoAlarm's CAP as JSON, the FIRMS fire-pixel CSV, NIFC's WFIGS
 * incidents and perimeters, EFFIS burnt areas, NOAA HMS smoke, the USGS
 * earthquake GeoJSON, NASA EONET events and GDACS's RSS.
 */
export const HAZARDS_SOURCE_FORMATS = [
  "cap",
  "nws",
  "meteoalarm",
  "firms",
  "wfigs",
  "effis",
  "hms",
  "usgs",
  "eonet",
  "gdacs",
] as const;

/**
 * The hazards registry module: warnings an authority issues as CAP alerts,
 * and hazard events from authorities and satellites (fire perimeters,
 * burnt areas, smoke, floods, earthquakes, storms, eruptions) with the fire
 * pixels satellites detect. Warnings of every kind live here, weather warnings included; a
 * road closed by a flood stays a roads situation that the flood causes.
 */
export const hazardsModule: RegistryModule = {
  name: "hazards",
  entries: [
    defineDomain({
      code: "hazards",
      description:
        "Warnings and hazard events from authorities and satellites, typically area-based: CAP alerts of every category, wildfires, smoke, floods, earthquakes, tropical cyclones, volcanoes.",
    }),
    extendVocabulary({ vocabulary: "source_format", values: HAZARDS_SOURCE_FORMATS }),
    extendVocabulary({
      vocabulary: "external_id_scheme",
      values: ["irwin", "usgs:event", "gdacs:event", "glide"],
    }),
    extendVocabulary({
      vocabulary: "admin_geocode_scheme",
      values: ["warncellid", "emma_id", "sgc", "eccc_clc", "cisorp", "fips10_4"],
    }),
    ...CAP_VOCABULARIES,
    cap("cap_status", CAP_STATUSES),
    cap("cap_msg_type", CAP_MSG_TYPES),
    cap("cap_scope", CAP_SCOPES),
    cap("cap_category", CAP_CATEGORIES),
    cap("cap_response_type", CAP_RESPONSE_TYPES),
    cap("cap_urgency", CAP_URGENCIES),
    cap("cap_severity", CAP_SEVERITIES),
    cap("cap_certainty", CAP_CERTAINTIES),
    cap("severity", CAP_SEVERITY_LABELS),
    cap("certainty", CAP_CERTAINTIES),
    ...withSituationCrosswalks(
      [alertKind, naturalHazardKind],
      [
        DWD_II_CLASSES,
        CAP_CP_CLASSES,
        VTEC_CLASSES,
        METEOALARM_CLASSES,
        NWS_CLASSES,
        SAME_CLASSES,
      ].map((table) => ({ target: "cap" as const, table })),
      [
        { target: "road511", table: ROAD511_HAZARD_TYPES },
        { target: "gtfs_rt", table: GTFS_RT_HAZARD_CAUSES },
      ],
    ),
    ...FIRE_PROPERTIES,
  ],
};

/** The hazards crosswalks, for parsers that cannot depend on the assembled registry. */
export const hazardsCrosswalk = buildCrosswalk(hazardsModule.entries);
