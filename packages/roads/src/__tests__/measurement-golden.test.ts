import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import type { FlowOutput, FlowSites } from "../flow-output.js";
import { parseHkDetectors } from "../hk.js";
import { parseMivConfig } from "../miv.js";
import { measuredDataReader } from "../parse.js";
import { parsePredefinedLocations } from "../predefined-locations.js";
import { parseDatexSiteTable } from "../siteTable.js";
import { parseBcnTramsStations } from "../stations-bcn.js";
import { parseFintrafficStations } from "../stations-fintraffic.js";
import { parseWebtrisSites } from "../stations-webtris.js";
import { CTX, fixture, flowFeed, flows, NOW, text } from "./flow-fixtures.js";

/**
 * Golden fixtures for every flow format: the source fixture goes through
 * `parseFlows` (with its site table or station registry where the format has
 * one); every measurement site, reading and derived congestion situation it
 * drafts must seal against the production kinds, and the sealed records are
 * compared with the committed golden file. `vitest -u` rewrites the files
 * after review.
 */
const registry = buildRegistry([kernelModule, roadsModule]);

type Case = [
  name: string,
  feed: string,
  format: string,
  input: () => Buffer,
  sites?: () => FlowSites,
];

const CASES: Case[] = [
  [
    "datex2-ndw",
    "nl-ndw-flow",
    "datex2",
    () => fixture("ndw-flow/trafficspeed.xml"),
    () => parseDatexSiteTable(fixture("ndw-flow/measurement_site_table.xml")),
  ],
  [
    "datex2-autobahn",
    "de-by-autobahn",
    "datex2",
    () => fixture("autobahn-bab-datex2/measured.xml"),
    () => parseDatexSiteTable(fixture("autobahn-bab-datex2/verortung.xml")),
  ],
  [
    "datex2-measured-inline-sites",
    "fr-dir-flow",
    "datex2",
    () => fixture("datex-measured-data/measured_data.xml"),
  ],
  [
    "datex-elaborated-nrw",
    "de-nw-autobahn-fahrstreifen",
    "datex-elaborated",
    () => fixture("autobahn-bab-nrw/data.xml"),
    () => parsePredefinedLocations(fixture("autobahn-bab-nrw/verortung.xml")),
  ],
  [
    "datex-elaborated-los",
    "de-nw-autobahn-loslane",
    "datex-elaborated",
    () => fixture("autobahn-bab/elaborated.xml"),
    () => parsePredefinedLocations(fixture("autobahn-bab/verortung.xml")),
  ],
  [
    "digitraffic",
    "fi-digitraffic-flow",
    "digitraffic",
    () => fixture("digitraffic-flow/flow.json"),
  ],
  [
    "fintraffic-tms",
    "fi-fintraffic",
    "fintraffic-tms",
    () => fixture("flow/fintraffic-tms.json"),
    () => parseFintrafficStations(fixture("flow/fintraffic-stations.json")),
  ],
  [
    "webtris",
    "gb-webtris",
    "webtris",
    () => fixture("flow/webtris.json"),
    () => parseWebtrisSites(fixture("flow/webtris-sites.json")),
  ],
  ["nyc-dot", "us-nyc-dot", "nyc-dot", () => fixture("flow/nyc-dot.json")],
  ["ohgo", "us-oh-ohgo", "ohgo", () => fixture("flow/ohgo.json")],
  [
    "trafikverket-flow",
    "se-trafikverket-flow",
    "trafikverket-flow",
    () => fixture("flow/trafikverket-flow.json"),
  ],
  [
    "lta-speedbands",
    "sg-lta-speedbands",
    "lta-speedbands",
    () => fixture("flow/lta-speedbands.json"),
  ],
  [
    "geojson-flow-rennes",
    "fr-rennesmetropole",
    "geojson-flow",
    () => fixture("flow/geojson-flow.json"),
  ],
  [
    "bcn-trams",
    "es-bcn-ajuntament",
    "bcn-trams",
    () => fixture("flow/bcn-trams.dat"),
    () => parseBcnTramsStations(text("flow/bcn-trams.csv")),
  ],
  ["bonn", "de-nw-bonn", "bonn", () => fixture("flow/bonn.json")],
  ["informo", "es-madrid", "informo", () => fixture("flow/informo.xml")],
  ["fdt", "it-turin", "fdt", () => fixture("flow/fdt.xml")],
  [
    "hk-td",
    "hk-td",
    "hk-td",
    () => fixture("flow/hk-td.xml"),
    () => parseHkDetectors(fixture("flow/hk-detectors.csv")),
  ],
  [
    "miv",
    "be-miv",
    "miv",
    () => fixture("flow/miv.xml"),
    () => parseMivConfig(fixture("flow/miv-config.xml")),
  ],
];

const golden = (name: string) => join(import.meta.dirname, "golden", `flow-${name}.json`);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function seal(drafts: readonly Record<string, unknown>[]) {
  const sealed = drafts.map((d) =>
    sealRecord(registry, d, { instanceId: "golden.test", revision: 1, recordedAt: NOW }),
  );
  const failures = sealed.flatMap((s, i) => {
    if (!s.ok) return [{ id: drafts[i]!["id"], issues: s.issues.slice(0, 5) }];
    // A sealed record is a stored record as it is: validating it changes nothing.
    const stored = registry.validate(s.value);
    return stored.ok && isDeepStrictEqual(stored.value, s.value)
      ? []
      : [{ id: drafts[i]!["id"], issues: stored.ok ? ["changed by validation"] : stored.issues }];
  });
  return { values: sealed.flatMap((s) => (s.ok ? [s.value] : [])), failures };
}

function sealAll(out: FlowOutput) {
  const sites = seal(out.features);
  const readings = seal(out.observations);
  const situations = seal(out.situations);
  return {
    failures: [...sites.failures, ...readings.failures, ...situations.failures],
    sealed: {
      features: sites.values,
      observations: readings.values,
      situations: situations.values,
    },
  };
}

describe("measurement golden fixtures", () => {
  it.each(CASES)(
    "%s: every site, reading and derived situation seals and matches its golden file",
    async (name, feedId, format, input, sites) => {
      const out = flows(flowFeed(feedId, format), input(), sites?.());
      expect(out.observations.length).toBeGreaterThan(0);
      const { failures, sealed } = sealAll(out);
      expect(failures).toEqual([]);
      await expect(json(sealed)).toMatchFileSnapshot(golden(name));
    },
  );

  it("the streaming DATEX reader drafts exactly what the buffered parse does, in any chunking", () => {
    const feed = flowFeed("nl-ndw-flow");
    const sites = parseDatexSiteTable(fixture("ndw-flow/measurement_site_table.xml"));
    const doc = fixture("ndw-flow/trafficspeed.xml");
    const buffered = flows(feed, doc, sites);
    for (const size of [1, 7, 64, 1000]) {
      const reader = measuredDataReader(feed, sites, CTX);
      for (let i = 0; i < doc.length; i += size) reader.write(doc.subarray(i, i + size));
      const { failed, ...streamed } = reader.close();
      expect(failed).toBe(false);
      expect(streamed).toEqual(buffered);
    }
  });
});
