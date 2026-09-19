import { z } from "zod";
import { LIFECYCLES, PAYMENT_METHODS } from "../classes/feature.js";
import { AGGREGATIONS } from "../classes/observation.js";
import { CAUSES, CERTAINTIES, SEVERITY_LABELS } from "../classes/situation.js";
import type { RegistryModule, VocabularyEntry } from "../registry/define.js";
import { defineSelector, defineVocabulary } from "../registry/define.js";
import { ICAL_DAYS } from "../schedule/schedule.js";
import { KERNEL_CHANGE_KINDS } from "./change-kind.js";
import {
  ACTION_STATUSES,
  COMPLIANCE,
  CORE_ISSUE_CODES,
  KERNEL_EFFECTS,
  LOS,
  NORMALIZATION,
} from "./effect.js";
import {
  CARRIAGEWAYS,
  DIRECTION_BASES,
  DIRECTION_VALUES,
  EXTENTS,
  FUZZINESS,
  GEOMETRY_ORIGINS,
  LANE_TYPES,
  ROAD_CLASSES,
} from "./location.js";
import {
  ACCESS_MODES,
  EVIDENCE_STATES,
  FUSION_TIERS,
  GRANT_STATES,
  ORIGINS,
  PRIVACY_CLASSES,
  RELATIONS,
  SOURCE_TIERS,
  TOMBSTONE_REASONS,
} from "./provenance.js";
import { TEMPORALITIES } from "./record-base.js";
import { RESULT_TYPES } from "./result.js";
import { RECORD_CLASSES } from "./scalars.js";
import { ENDED_REASONS, VALIDITY_STATUSES } from "./validity.js";
import { DIMENSIONS, VEHICLE_CLASSES, VEHICLE_FUELS, VEHICLE_USAGES } from "./vehicle.js";

/** The kernel version, negotiated at federation like a kind: a major bump touches every class. */
export const KERNEL_VERSION = "1.0" as const;

const closed = (code: string, values: readonly string[], description: string): VocabularyEntry =>
  defineVocabulary({ code, values, extensible: false, description });
const open = (code: string, values: readonly string[], description: string): VocabularyEntry =>
  defineVocabulary({ code, values, extensible: true, description });

export const kernelModule: RegistryModule = {
  name: "kernel",
  entries: [
    closed("record_class", RECORD_CLASSES, "The four record classes."),
    closed("temporality", TEMPORALITIES, "How a record relates to time."),
    closed("validity_status", VALIDITY_STATUSES, "The source's declared lifecycle."),
    closed("ended_reason", ENDED_REASONS, "Why a validity ended."),
    closed("tombstone_reason", TOMBSTONE_REASONS, "Why a record was tombstoned."),
    closed("origin", ORIGINS, "Where a record came from."),
    closed(
      "access_mode",
      ACCESS_MODES,
      "How OC may fetch a source: bulk polling, or read-through for a consumer's area.",
    ),
    closed("privacy_class", PRIVACY_CLASSES, "The privacy tier a record was produced under."),
    closed("grant_state", GRANT_STATES, "A licence grant."),
    closed("source_tier", SOURCE_TIERS, "What kind of publisher a source is."),
    closed("fusion_tier", FUSION_TIERS, "Default fusion order, highest first."),
    closed("evidence_state", EVIDENCE_STATES, "Crowd-evidence lifecycle state."),
    closed("relation", RELATIONS, "Typed links between records."),
    closed("road_class", ROAD_CLASSES, "OSM-aligned functional road class."),
    closed("carriageway", CARRIAGEWAYS, "Carriageway part of a road reference."),
    closed("direction_value", DIRECTION_VALUES, "Direction relative to the basis's axis."),
    closed("direction_basis", DIRECTION_BASES, "What a direction value is read against."),
    closed("lane_type", LANE_TYPES, "Lane types."),
    closed("extent", EXTENTS, "Spatial extent of a location."),
    closed("geometry_origin", GEOMETRY_ORIGINS, "Where a location's geometry came from."),
    closed("fuzziness", FUZZINESS, "How precisely a location is known."),
    closed(
      "vehicle_class",
      VEHICLE_CLASSES,
      "Vehicle classes (one vocabulary for effects, parking, tolls, offers).",
    ),
    closed("dimension", DIMENSIONS, "Vehicle dimensions; canonical units m, kg or 1."),
    closed("vehicle_usage", VEHICLE_USAGES, "Vehicle usages."),
    closed("vehicle_fuel", VEHICLE_FUELS, "Vehicle propulsion."),
    closed("compliance", COMPLIANCE, "Whether an effect is mandatory."),
    closed("normalization", NORMALIZATION, "How completely a parser typed an effect."),
    closed("action_status", ACTION_STATUSES, "DATEX operator action status of an effect."),
    closed("los", LOS, "Level of service."),
    closed("severity", SEVERITY_LABELS, "Situation severity label."),
    closed("certainty", CERTAINTIES, "Situation certainty."),
    closed("aggregation", AGGREGATIONS, "The statistic an observation reports."),
    closed("result_type", RESULT_TYPES, "Observation result forms."),
    closed("lifecycle", LIFECYCLES, "Feature and component lifecycle."),
    closed("payment_method", PAYMENT_METHODS, "Payment methods."),
    closed("ical_day", ICAL_DAYS, "Days of week in schedules."),
    open("cause", CAUSES, "Why a situation exists."),
    open(
      "issue_code",
      CORE_ISSUE_CODES,
      "Why a parser could not fully type an effect; domain parsers add codes.",
    ),
    open(
      "external_id_scheme",
      [
        "ocpi:location",
        "ocpi:evse",
        "ocpi:connector",
        "oicp:evse",
        "emi3:evse",
        "datex:site",
        "datex:situation",
        "datex:record",
        "datex:parking",
        "datex:vms",
        "datex:refill_point",
        "wzdx:road_event",
        "wzdx:device",
        "open511",
        "tpims:site",
        "nbi:structure",
        "fra:crossing",
        "cbp:port",
        "cbsa:office",
        "osm:node",
        "osm:way",
        "osm:relation",
        "gers",
        "wikidata",
        "tmc",
        "cap",
        "gtfs:stop",
        "gtfs:route",
        "ocm",
        "bnetza",
        "cpo",
        "provider",
      ],
      "Schemes of typed external ids.",
    ),
    open(
      "road_designation_scheme",
      [
        "us_interstate",
        "us_route",
        "us_state_route",
        "de_bab",
        "de_bundesstrasse",
        "e_road",
        "national",
      ],
      "Road numbering schemes.",
    ),
    open(
      "emission_scheme",
      ["euro", "de_plakette", "crit_air", "ulez"],
      "Vehicle emission classification schemes.",
    ),
    open(
      "admin_geocode_scheme",
      ["iso3166-2", "nuts", "fips", "same", "ugc", "ars"],
      "Administrative area code schemes; the fuel domain adds padd.",
    ),
    open(
      "source_format",
      ["crowd", "derived"],
      "Wire formats records are parsed from; parser packages add theirs.",
    ),
    open(
      "amenity",
      [],
      "Feature amenities (DATEX ServiceFacilityType ∪ OCPI Facility ∪ TPIMS); domain packages contribute.",
    ),
    ...KERNEL_EFFECTS,
    ...KERNEL_CHANGE_KINDS,
    defineSelector({
      code: "features",
      version: "1.0",
      description: "Features (or, with componentKey, components) a situation affects.",
      schema: (k) =>
        z
          .array(
            k.RecordRef.refine((r) => r.class === "feature", {
              message: "affects.features holds feature refs",
            }),
          )
          .min(1),
    }),
  ],
};
