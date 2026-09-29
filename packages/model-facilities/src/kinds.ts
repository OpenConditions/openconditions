import {
  defineKind,
  defineProperty,
  defineVocabulary,
  SeasonalWindow,
  VEHICLE_CLASSES,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "facilities";
const V = "1.0";
const HOUR = 3600;

export const FACILITY_OPEN_STATUSES = ["open", "closed", "restricted", "unknown"] as const;

export const facilityOpenStatusVocabulary = defineVocabulary({
  code: "facility_open_status",
  values: FACILITY_OPEN_STATUSES,
  extensible: false,
  description: "Whether an operated site takes traffic: open, closed, or open with a restriction.",
});

/**
 * Roadside facilities: rest areas and weigh stations. A service area is one
 * `rest_area` feature; its car park, filling station and charging site are
 * features of their own kinds that are `part_of` it, so each keeps its own
 * occupancy, prices and status.
 */
export const FACILITIES_KINDS = [
  defineKind({
    class: "feature",
    code: "rest_area",
    domain: DOMAIN,
    version: V,
    description:
      "A place beside the road to stop and rest, from a lay-by with a bench to a service area.",
    types: {
      rest_area: [],
      service_area: [],
      truck_stop: [],
      picnic: [],
      viewpoint: [],
      welcome_centre: [],
    },
    traits: ["operated_site"],
    details: (k) => ({
      /** The carriageway it is reached from; `both` when reachable from either. */
      direction: k.DirectionRef.optional(),
      /** When it is normally closed, in a normal year. */
      seasonalClosure: SeasonalWindow.optional(),
      /** The open season in the source's words, when it names it by holidays ("Victoria Day to Thanksgiving Day"). */
      season: k.Text.optional(),
      paved: z.boolean().optional(),
    }),
    linking: {
      idSchemes: ["osm:node", "osm:way"],
      alwaysMetres: 100,
      neverMetres: 500,
      attribute: { name: 0.5 },
      nameStopwords: [
        "rest",
        "area",
        "rastplatz",
        "rasteplass",
        "raststätte",
        "aire",
        "service",
        "services",
        "centre",
        "center",
        "park",
      ],
      osm: { tags: ["highway=rest_area", "highway=services"] },
    },
  }),
  defineKind({
    class: "feature",
    code: "weigh_station",
    domain: DOMAIN,
    version: V,
    description: "A place where vehicles are weighed and inspected.",
    types: {
      inspection_station: ["small", "large"],
      control_area: [],
      virtual: [],
    },
    traits: ["operated_site"],
    details: (k) => ({
      /** How it weighs: a fixed static scale, weigh-in-motion, a portable scale, or not at all. */
      scaleType: z.enum(["static", "wim", "portable", "none"]).optional(),
      directions: z.array(k.DirectionRef).min(1).optional(),
      vehicleClasses: z.array(z.enum(VEHICLE_CLASSES)).min(1).optional(),
      /** Pre-clearance programmes that let a vehicle bypass the station, verbatim ("PrePass", "Drivewyze"). */
      bypassPrograms: z.array(z.string().min(1)).min(1).optional(),
      /** Spaces for long vehicles to wait in. */
      truckSpaces: z.number().int().nonnegative().optional(),
    }),
    linking: {
      idSchemes: ["osm:node", "osm:way"],
      alwaysMetres: 50,
      neverMetres: 300,
      attribute: { name: 0.5 },
      nameStopwords: [
        "weigh",
        "station",
        "scale",
        "inspection",
        "kontrollstasjon",
        "kontrollplass",
      ],
      osm: { tags: ["amenity=weighbridge"] },
    },
  }),
];

export const FACILITIES_PROPERTIES = [
  defineProperty({
    code: "facility.open_status",
    domain: DOMAIN,
    version: V,
    description: "Whether an operated site is open now.",
    result: { type: "category", vocabulary: "facility_open_status" },
    subjects: [{ kind: "feature", traits: ["operated_site"] }],
    freshnessWindowSec: 24 * HOUR,
    retention: { changeOnly: true },
    routingRelevant: true,
  }),
];
