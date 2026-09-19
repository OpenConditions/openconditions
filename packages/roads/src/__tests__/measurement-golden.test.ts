import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FEED_SOURCES, feedToSourceDescriptor } from "../feeds.js";
import { type FlowParseResult, parseDatexMeasuredData, parseDigitrafficFlow } from "../flow.js";
import { parseBcnTramsFlow } from "../flow-bcn.js";
import { parseBonnFlow } from "../flow-bonn.js";
import { parseElaboratedFlow } from "../flow-elaborated.js";
import { parseFintrafficFlow } from "../flow-fintraffic.js";
import { parseGeojsonFlow } from "../flow-geojson.js";
import { parseLtaSpeedBands } from "../flow-lta-speedbands.js";
import { parseMadridFlow } from "../flow-madrid.js";
import { parseNycDotFlow } from "../flow-nycdot.js";
import { parseOhgoFlow } from "../flow-ohgo.js";
import { parseTrafikverketFlow } from "../flow-trafikverket.js";
import { parseTurinFlow } from "../flow-turin.js";
import { parseWebtrisFlow } from "../flow-webtris.js";
import { parseHkDetectors, parseHkRawFlow } from "../hk.js";
import { parseMivConfig, parseMivFlow } from "../miv.js";
import { parsePredefinedLocations } from "../predefined-locations.js";
import { measurementDrafts } from "../sites/assemble.js";
import { parseDatexSiteTable } from "../siteTable.js";
import { situationDrafts } from "../situation/assemble.js";
import { parseBcnTramsStations } from "../stations-bcn.js";
import { parseFintrafficStations } from "../stations-fintraffic.js";
import { parseWebtrisSites } from "../stations-webtris.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Golden fixtures for every flow format: the source fixture goes through its
 * real parser (with its site table or station registry where the format has
 * one) and the measurement assembler; every feature, observation and derived
 * congestion situation must seal against the production kinds, and the sealed
 * records are compared with the committed golden file. `vitest -u` rewrites
 * the files after review.
 */
const registry = buildRegistry([kernelModule, roadsModule]);
const FROZEN = "2026-09-18T10:00:00.000Z";

const fixture = (path: string) => readFileSync(join(import.meta.dirname, "fixtures", path));
const text = (path: string) => fixture(path).toString("utf8");

function descriptor(feedId: string): SourceDescriptor {
  const feed = FEED_SOURCES.find((f) => f.id === feedId);
  if (feed) return feedToSourceDescriptor(feed);
  return { id: feedId, attribution: feedId, country: "FI", license: "CC-BY-4.0" };
}

type Parse = (src: SourceDescriptor) => FlowParseResult;

const CASES: [name: string, feed: string, parse: Parse][] = [
  [
    "datex2-ndw",
    "nl-ndw-flow",
    (src) =>
      parseDatexMeasuredData(
        fixture("ndw-flow/trafficspeed.xml"),
        src,
        parseDatexSiteTable(fixture("ndw-flow/measurement_site_table.xml")),
      ),
  ],
  [
    "datex2-autobahn",
    "de-by-autobahn",
    (src) =>
      parseDatexMeasuredData(
        fixture("autobahn-bab-datex2/measured.xml"),
        src,
        parseDatexSiteTable(fixture("autobahn-bab-datex2/verortung.xml")),
      ),
  ],
  [
    "datex2-measured-inline-sites",
    "fr-dir-flow",
    (src) => parseDatexMeasuredData(fixture("datex-measured-data/measured_data.xml"), src),
  ],
  [
    "datex-elaborated-nrw",
    "de-nw-autobahn-fahrstreifen",
    (src) =>
      parseElaboratedFlow(
        fixture("autobahn-bab-nrw/data.xml"),
        src,
        parsePredefinedLocations(fixture("autobahn-bab-nrw/verortung.xml")),
      ),
  ],
  [
    "datex-elaborated-los",
    "de-nw-autobahn-loslane",
    (src) =>
      parseElaboratedFlow(
        fixture("autobahn-bab/elaborated.xml"),
        src,
        parsePredefinedLocations(fixture("autobahn-bab/verortung.xml")),
      ),
  ],
  [
    "digitraffic",
    "fi-digitraffic-flow",
    (src) => parseDigitrafficFlow(fixture("digitraffic-flow/flow.json"), src),
  ],
  [
    "fintraffic-tms",
    "fi-fintraffic",
    (src) =>
      parseFintrafficFlow(
        fixture("flow/fintraffic-tms.json"),
        src,
        parseFintrafficStations(fixture("flow/fintraffic-stations.json")),
      ),
  ],
  [
    "webtris",
    "gb-webtris",
    (src) =>
      parseWebtrisFlow(
        fixture("flow/webtris.json"),
        src,
        parseWebtrisSites(fixture("flow/webtris-sites.json")),
      ),
  ],
  ["nyc-dot", "us-nyc-dot", (src) => parseNycDotFlow(fixture("flow/nyc-dot.json"), src)],
  ["ohgo", "us-oh-ohgo", (src) => parseOhgoFlow(fixture("flow/ohgo.json"), src)],
  [
    "trafikverket-flow",
    "se-trafikverket-flow",
    (src) => parseTrafikverketFlow(fixture("flow/trafikverket-flow.json"), src),
  ],
  [
    "lta-speedbands",
    "sg-lta-speedbands",
    (src) => parseLtaSpeedBands(fixture("flow/lta-speedbands.json"), src),
  ],
  [
    "geojson-flow-rennes",
    "fr-rennesmetropole",
    (src) => parseGeojsonFlow(fixture("flow/geojson-flow.json"), src),
  ],
  [
    "bcn-trams",
    "es-bcn-ajuntament",
    (src) =>
      parseBcnTramsFlow(
        fixture("flow/bcn-trams.dat"),
        src,
        parseBcnTramsStations(text("flow/bcn-trams.csv")),
      ),
  ],
  ["bonn", "de-nw-bonn", (src) => parseBonnFlow(fixture("flow/bonn.json"), src)],
  ["informo", "es-madrid", (src) => parseMadridFlow(fixture("flow/informo.xml"), src)],
  ["fdt", "it-turin", (src) => parseTurinFlow(fixture("flow/fdt.xml"), src)],
  [
    "hk-td",
    "hk-td",
    (src) =>
      parseHkRawFlow(
        fixture("flow/hk-td.xml"),
        src,
        parseHkDetectors(fixture("flow/hk-detectors.csv")),
      ),
  ],
  [
    "miv",
    "be-miv",
    (src) =>
      parseMivFlow(fixture("flow/miv.xml"), src, parseMivConfig(fixture("flow/miv-config.xml"))),
  ],
];

const golden = (name: string) => join(import.meta.dirname, "golden", `flow-${name}.json`);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function seal(drafts: readonly Record<string, unknown>[]) {
  const sealed = drafts.map((d) =>
    sealRecord(registry, d, { instanceId: "golden.test", revision: 1, recordedAt: FROZEN }),
  );
  const failures = sealed.flatMap((s, i) =>
    s.ok ? [] : [{ id: drafts[i]!["id"], issues: s.issues.slice(0, 5) }],
  );
  return { values: sealed.flatMap((s) => (s.ok ? [s.value] : [])), failures };
}

describe("measurement golden fixtures", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FROZEN));
  });
  afterAll(() => vi.useRealTimers());

  it.each(CASES)(
    "%s: every site, reading and derived situation seals and matches its golden file",
    async (name, feed, parse) => {
      const src = descriptor(feed);
      const parsed = parse(src);
      expect(parsed.flows.length).toBeGreaterThan(0);
      const { features, observations } = measurementDrafts(parsed.flows, { source: src });
      const sites = seal(features);
      const readings = seal(observations);
      const situations = seal(situationDrafts(parsed.events, { source: src }));
      expect([...sites.failures, ...readings.failures, ...situations.failures]).toEqual([]);
      expect(readings.values.length).toBeGreaterThan(0);
      await expect(
        json({
          features: sites.values,
          observations: readings.values,
          situations: situations.values,
        }),
      ).toMatchFileSnapshot(golden(name));
    },
  );
});
