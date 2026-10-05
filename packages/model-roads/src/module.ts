import {
  buildCrosswalk,
  defineChangeKind,
  defineDomain,
  extendVocabulary,
  inClassPaths,
  type MappingTarget,
  type RegistryModule,
  type SourceCrosswalk,
  vocabularyCrosswalk,
  withFeatureCrosswalks,
  withPropertyCrosswalks,
  withSituationCrosswalks,
} from "@openconditions/model";
import {
  DATEX2_CAUSES,
  DATEX2_CERTAINTIES,
  DATEX2_SEVERITIES,
  DATEX2_SITUATIONS,
} from "./crosswalk/datex2.js";
import {
  GTFS_RT_CAUSE_VALUES,
  GTFS_RT_CAUSES,
  ROAD511_TYPES,
  TRAFF_EVENTS,
} from "./crosswalk/emitters.js";
import { IBI511_SITUATIONS } from "./crosswalk/ibi511.js";
import {
  DATEX2_DEVICE_HEALTH,
  DATEX2_MEASURED_TRAFFIC,
  DATEX2_TRAFFIC_STATUSES,
  DATEX2_TRAVEL_TIME_TRENDS,
  DATEX2_TRAVEL_TIME_TRENDS_OUT,
  DATEX2_VMS_TYPES,
  DATEX2_VMS_WORKING_STATUSES,
  WZDX_DEVICE_STATUSES,
  WZDX_DEVICE_TYPES,
} from "./crosswalk/infrastructure.js";
import {
  OPEN511_CERTAINTIES,
  OPEN511_SEVERITIES,
  OPEN511_SITUATIONS,
} from "./crosswalk/open511.js";
import { WZDX_SITUATIONS } from "./crosswalk/wzdx.js";
import {
  cameraStatusVocabulary,
  deviceStatusVocabulary,
  ROADS_INFRASTRUCTURE_KINDS,
  ROADS_PROPERTIES,
  ROADS_RESULT_SCHEMAS,
  vmsWorkingStatusVocabulary,
} from "./infrastructure.js";
import { ROADS_SITUATION_KINDS } from "./kinds.js";
import { ROADS_NETWORK_KINDS } from "./network.js";
import { ROADS_TOLL_KINDS, ROADS_TOLL_PROPERTIES } from "./tolls.js";
import { ROADS_TRAVEL_TIME_KINDS, ROADS_TRAVEL_TIME_PROPERTIES } from "./travel-time.js";
import { DATEX2_V2, DATEX2_V3 } from "./vocabularies/datex2.js";
import {
  DATEX2_V2_INFRASTRUCTURE,
  DATEX2_V3_INFRASTRUCTURE,
} from "./vocabularies/datex2-infrastructure.js";
import {
  chainLevelVocabulary,
  passStatusVocabulary,
  ROADS_WINTER_KINDS,
  ROADS_WINTER_PROPERTIES,
} from "./winter.js";

/**
 * Every wire format a roads source is read from: the event and flow parsers
 * and the reference tables they load (site tables, predefined locations,
 * station lists). The roads package checks its parsers and feed catalogue
 * against this list.
 */
export const ROADS_SOURCE_FORMATS = [
  "autobahn",
  "bcn-trams",
  "bcn-trams-csv",
  "bonn",
  "datex2-elaborated",
  "datex2-locations",
  "datex2-measured",
  "datex2-sites",
  "digitraffic",
  "digitraffic-traffic-measurement",
  "fdt",
  "fintraffic-stations",
  "fintraffic-tms",
  "flatjson",
  "france-comptage-csv",
  "gddkia",
  "geojson-flow",
  "hk-detector-csv",
  "hk-td",
  "ibi511",
  "ibi511-conditions",
  "informo",
  "lta",
  "lta-speedbands",
  "miv",
  "miv-config",
  "nyc-dot",
  "ohgo",
  "ohgo-events",
  "open511",
  "trafikverket",
  "trafikverket-flow",
  "vic-disruptions",
  "webtris",
  "webtris-sites",
  "wzdx",
] as const;

type DatexVocabulary = typeof DATEX2_V3 | typeof DATEX2_V2;

/** Whether a `Class` / `Class:value` key exists in one DATEX version. */
function inDatex(v: DatexVocabulary) {
  const classes = new Set<string>(v.recordClasses);
  const discriminators = v.discriminators as Record<string, { values: readonly string[] }>;
  return (code: string) => {
    const [cls, value] = code.split(":");
    if (!classes.has(cls!)) return false;
    return value === undefined || (discriminators[cls!]?.values.includes(value) ?? false);
  };
}

const datex = (
  table: Readonly<Record<string, string | null>>,
  list: (v: DatexVocabulary) => readonly string[] | ((code: string) => boolean),
): SourceCrosswalk[] =>
  (
    [
      ["datex2_v3", DATEX2_V3],
      ["datex2_v2", DATEX2_V2],
    ] as [MappingTarget, DatexVocabulary][]
  ).map(([target, v]) => {
    const l = list(v);
    return {
      target,
      table,
      include: typeof l === "function" ? l : (code: string) => l.includes(code),
    };
  });

const situationKinds = withSituationCrosswalks(
  ROADS_SITUATION_KINDS,
  [
    ...datex(DATEX2_SITUATIONS, inDatex),
    { target: "wzdx", table: WZDX_SITUATIONS },
    { target: "open511", table: OPEN511_SITUATIONS },
    { target: "ibi511", table: IBI511_SITUATIONS },
  ],
  [
    { target: "traff", table: TRAFF_EVENTS },
    { target: "gtfs_rt", table: GTFS_RT_CAUSES },
    { target: "road511", table: ROAD511_TYPES },
  ],
);

type InfrastructureVocabulary = typeof DATEX2_V3_INFRASTRUCTURE | typeof DATEX2_V2_INFRASTRUCTURE;

const DATEX_INFRASTRUCTURE: [MappingTarget, InfrastructureVocabulary][] = [
  ["datex2_v3", DATEX2_V3_INFRASTRUCTURE],
  ["datex2_v2", DATEX2_V2_INFRASTRUCTURE],
];

const datexInfrastructure = (
  table: Readonly<Record<string, string | null>>,
  include: (v: InfrastructureVocabulary) => (code: string) => boolean,
): SourceCrosswalk[] =>
  DATEX_INFRASTRUCTURE.map(([target, v]) => ({ target, table, include: include(v) }));

const infrastructureKinds = withFeatureCrosswalks(
  ROADS_INFRASTRUCTURE_KINDS,
  [
    ...datexInfrastructure(
      DATEX2_VMS_TYPES,
      (v) => (code) => (v.vmsTypes as readonly string[]).includes(code.slice("vmsType:".length)),
    ),
    { target: "wzdx", table: WZDX_DEVICE_TYPES },
  ],
  [],
);

const roadsProperties = withPropertyCrosswalks(
  [...ROADS_PROPERTIES, ...ROADS_TRAVEL_TIME_PROPERTIES],
  datexInfrastructure(DATEX2_MEASURED_TRAFFIC, (v) => inClassPaths(v.measuredValues)),
  [],
);

/**
 * Roads' own change kind: the lane picture of a situation changed (the
 * competitor history API's `lanes_change`), finer than `effects_change`.
 */
export const lanesChange = defineChangeKind({
  code: "lanes_change",
  description: "The lanes closed or open changed.",
  classes: ["situation"],
  select: (r) =>
    ((r["effects"] as { kind: string }[] | undefined) ?? [])
      .filter((e) => e.kind === "lane_restriction")
      .map((e) => {
        const { lanesTotal, lanesClosed, lanes, vehicleImpact } = e as Record<string, unknown>;
        return { lanesTotal, lanesClosed, lanes, vehicleImpact };
      }),
});

/** The roads registry module: domain, situation kinds, vocabularies and crosswalks. */
export const roadsModule: RegistryModule = {
  name: "roads",
  entries: [
    defineDomain({
      code: "roads",
      description:
        "Traffic information about the road network: incidents, works, closures, restrictions and conditions, even when weather-caused.",
    }),
    extendVocabulary({ vocabulary: "source_format", values: ROADS_SOURCE_FORMATS }),
    ...situationKinds,
    cameraStatusVocabulary,
    vmsWorkingStatusVocabulary,
    deviceStatusVocabulary,
    ...infrastructureKinds,
    ...ROADS_RESULT_SCHEMAS,
    ...roadsProperties,
    extendVocabulary({
      vocabulary: "issue_code",
      values: ["value_not_published"],
    }),
    ...ROADS_NETWORK_KINDS,
    passStatusVocabulary,
    chainLevelVocabulary,
    ...ROADS_WINTER_KINDS,
    ...ROADS_WINTER_PROPERTIES,
    ...ROADS_TRAVEL_TIME_KINDS,
    ...ROADS_TOLL_KINDS,
    ...ROADS_TOLL_PROPERTIES,
    vocabularyCrosswalk(
      "trend",
      datexInfrastructure(
        DATEX2_TRAVEL_TIME_TRENDS,
        (v) => (code) =>
          (v.travelTimeTrendTypes as readonly string[]).includes(
            code.slice("travelTimeTrendType:".length),
          ),
      ),
      [{ target: "datex2_v3", table: DATEX2_TRAVEL_TIME_TRENDS_OUT }],
    ),
    vocabularyCrosswalk(
      "vms_working_status",
      [{ target: "datex2_v3", table: DATEX2_VMS_WORKING_STATUSES }],
      [],
    ),
    vocabularyCrosswalk(
      "device_status",
      [
        { target: "datex2_v3", table: DATEX2_DEVICE_HEALTH },
        { target: "wzdx", table: WZDX_DEVICE_STATUSES },
      ],
      [],
    ),
    vocabularyCrosswalk(
      "los",
      datexInfrastructure(
        DATEX2_TRAFFIC_STATUSES,
        (v) => (code) => (v.trafficStatuses as readonly string[]).includes(code),
      ),
      [],
    ),
    vocabularyCrosswalk(
      "cause",
      datex(DATEX2_CAUSES, (v) => v.causeTypes),
      [{ target: "gtfs_rt", table: GTFS_RT_CAUSE_VALUES }],
    ),
    vocabularyCrosswalk(
      "severity",
      [
        ...datex(DATEX2_SEVERITIES, (v) => v.severities),
        { target: "open511", table: OPEN511_SEVERITIES },
      ],
      [],
    ),
    vocabularyCrosswalk(
      "certainty",
      [
        ...datex(DATEX2_CERTAINTIES, (v) => v.probabilities),
        { target: "open511", table: OPEN511_CERTAINTIES },
      ],
      [],
    ),
    lanesChange,
  ],
};

/** The roads crosswalks, for parsers that cannot depend on the assembled registry. */
export const roadsCrosswalk = buildCrosswalk(roadsModule.entries);
