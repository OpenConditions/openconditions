import { parseDigitrafficFlow } from "./flow.js";
import { parseBcnTramsFlow } from "./flow-bcn.js";
import { parseBonnFlow } from "./flow-bonn.js";
import { parseElaboratedFlow } from "./flow-elaborated.js";
import { parseFintrafficFlow } from "./flow-fintraffic.js";
import { parseGeojsonFlow } from "./flow-geojson.js";
import { parseLtaSpeedBands } from "./flow-lta-speedbands.js";
import { parseMadridFlow } from "./flow-madrid.js";
import { parseNycDotFlow } from "./flow-nycdot.js";
import { parseOhgoFlow } from "./flow-ohgo.js";
import type { FlowParser } from "./flow-reading.js";
import { parseTrafikverketFlow } from "./flow-trafikverket.js";
import { parseTurinFlow } from "./flow-turin.js";
import { parseWebtrisFlow } from "./flow-webtris.js";
import { parseHkRawFlow } from "./hk.js";
import { parseDatexMeasuredData } from "./measuredData.js";
import { parseMivFlow } from "./miv.js";

/** Every flow format; the wire formats `FLOW_PARSERS` reads. */
export const FLOW_FORMAT_CODES = [
  "digitraffic",
  "datex2",
  "datex-elaborated",
  "fintraffic-tms",
  "webtris",
  "nyc-dot",
  "ohgo",
  "trafikverket-flow",
  "bonn",
  "informo",
  "lta-speedbands",
  "miv",
  "fdt",
  "hk-td",
  "geojson-flow",
  "bcn-trams",
] as const;

/** The flow parser of every flow format. */
const FLOW_PARSERS: Record<(typeof FLOW_FORMAT_CODES)[number], FlowParser> = {
  digitraffic: parseDigitrafficFlow,
  datex2: parseDatexMeasuredData,
  "datex-elaborated": parseElaboratedFlow,
  "fintraffic-tms": parseFintrafficFlow,
  webtris: parseWebtrisFlow,
  "nyc-dot": parseNycDotFlow,
  ohgo: parseOhgoFlow,
  "trafikverket-flow": parseTrafikverketFlow,
  bonn: parseBonnFlow,
  informo: parseMadridFlow,
  "lta-speedbands": parseLtaSpeedBands,
  miv: parseMivFlow,
  fdt: parseTurinFlow,
  "hk-td": parseHkRawFlow,
  "geojson-flow": parseGeojsonFlow,
  "bcn-trams": parseBcnTramsFlow,
};

/** The flow parser of a format; throws when no flow parser reads it. */
export function flowParserOf(format: string): FlowParser {
  if (!Object.hasOwn(FLOW_PARSERS, format)) {
    throw new Error(`No flow parser registered for format: ${format}`);
  }
  return FLOW_PARSERS[format as keyof typeof FLOW_PARSERS];
}
