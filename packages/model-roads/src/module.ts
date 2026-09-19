import {
  buildCrosswalk,
  defineChangeKind,
  defineDomain,
  extendVocabulary,
  type MappingTarget,
  type RegistryModule,
} from "@openconditions/model";
import {
  type SourceCrosswalk,
  vocabularyCrosswalk,
  withSituationCrosswalks,
} from "./crosswalk/assemble.js";
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
  OPEN511_CERTAINTIES,
  OPEN511_SEVERITIES,
  OPEN511_SITUATIONS,
} from "./crosswalk/open511.js";
import { WZDX_SITUATIONS } from "./crosswalk/wzdx.js";
import { ROADS_SITUATION_KINDS, surfaceStateVocabulary } from "./kinds.js";
import { DATEX2_V2, DATEX2_V3 } from "./vocabularies/datex2.js";

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
  "datex-elaborated",
  "datex-predefined-locations",
  "datex-site-table",
  "datex2",
  "digitraffic",
  "fdt",
  "fintraffic-stations",
  "fintraffic-tms",
  "flatjson",
  "france-comptage-csv",
  "gddkia",
  "geojson",
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
    surfaceStateVocabulary,
    extendVocabulary({ vocabulary: "source_format", values: ROADS_SOURCE_FORMATS }),
    ...situationKinds,
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
