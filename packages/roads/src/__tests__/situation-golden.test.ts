import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseAutobahn } from "../autobahn.js";
import { parseDatexSnapshot } from "../datex.js";
import { parseDigitrafficSnapshot } from "../digitraffic.js";
import { FEED_SOURCES, feedToSourceDescriptor } from "../feeds.js";
import { parseFlatJson } from "../flatjson.js";
import { parseGddkia } from "../gddkia.js";
import { parseGeoJson } from "../geojson.js";
import { parseIbi511, parseIbi511Conditions } from "../ibi511.js";
import { parseLtaIncidents } from "../lta.js";
import { parseOhgoEvents } from "../ohgo-events.js";
import { parseOpen511 } from "../open511.js";
import { situationDrafts } from "../situation/assemble.js";
import type { RoadSnapshotRecord, SnapshotEvent } from "../snapshot.js";
import { parseTrafikverket } from "../trafikverket.js";
import type { SourceDescriptor } from "../types.js";
import { parseVicDisruptions } from "../vic-disruptions.js";
import { parseWzdx } from "../wzdx.js";

/**
 * Golden fixtures for every current road event source format: the reviewed
 * source fixture goes through its real parser and the situation assembler,
 * every draft must seal (hard validation against the production kinds), and
 * the sealed records are compared with the committed golden file. A parser or
 * crosswalk change shows up as a golden diff to review; `vitest -u` rewrites
 * the files after review.
 */
const registry = buildRegistry([kernelModule, roadsModule]);
const FROZEN = "2026-09-18T10:00:00.000Z";

interface Parsed {
  events: SnapshotEvent[];
  records?: RoadSnapshotRecord[];
}
type Parse = (input: Buffer, src: SourceDescriptor) => Parsed;

const events =
  (fn: (input: Buffer, src: SourceDescriptor) => SnapshotEvent[]): Parse =>
  (input, src) => ({ events: fn(input, src) });
const datex: Parse = (input, src) => {
  const report = parseDatexSnapshot(input, src);
  return {
    events: report.records.flatMap((r) => (r.event ? [r.event] : [])),
    records: report.records,
  };
};
const digitraffic: Parse = (input, src) => {
  const report = parseDigitrafficSnapshot(JSON.parse(input.toString("utf8")), src, {
    fetchedAt: FROZEN,
  });
  return {
    events: report.records.flatMap((r) => (r.event ? [r.event] : [])),
    records: report.records,
  };
};

function descriptor(feedId: string, fallback?: Partial<SourceDescriptor>): SourceDescriptor {
  const feed = FEED_SOURCES.find((f) => f.id === feedId);
  if (feed) return feedToSourceDescriptor(feed);
  return { id: feedId, attribution: feedId, country: "SE", license: "CC0-1.0", ...fallback };
}

const CASES: [name: string, feed: string, fixture: string, parse: Parse][] = [
  ["datex2-ndw-restrictions", "nl-ndw", "ndw/restrictions-v3.xml", datex],
  ["datex2-dgt", "es-dgt", "dgt-es/situations.xml", datex],
  ["datex2-dir", "fr-dir", "dir-fr/situations.xml", datex],
  ["datex2-cita", "lu-cita", "cita-lu/situations.xml", datex],
  ["datex2-flanders", "be-flanders", "flanders-be/situations.xml", datex],
  ["datex2-hc", "hr-hc-events", "hc-hr/events.datex3.xml", datex],
  ["digitraffic-messages", "fi-digitraffic", "digitraffic/messages.json", digitraffic],
  ["digitraffic-restrictions", "fi-digitraffic", "digitraffic/v2-restrictions.json", digitraffic],
  ["digitraffic-weight", "fi-digitraffic", "digitraffic/weight-restriction.json", digitraffic],
  ["digitraffic-exempted", "fi-digitraffic", "digitraffic/exempted-transport.json", digitraffic],
  ["wzdx-feed", "us-wzdx", "wzdx/feed.json", events(parseWzdx)],
  ["wzdx-cwz", "us-wzdx", "wzdx/cwz-pbs.json", events(parseWzdx)],
  ["wzdx-modot", "us-wzdx", "wzdx/modot-v41.json", events(parseWzdx)],
  ["wzdx-quebec", "us-wzdx", "wzdx/quebec-v31.json", events(parseWzdx)],
  ["open511-drivebc", "ca-bc-drivebc", "drivebc/events.json", events(parseOpen511)],
  ["geojson-nzta", "nz-nzta", "nzta-nz/road-events.geojson", events(parseGeoJson)],
  ["geojson-berlin", "de-be-berlin", "berlin-de/baustellen.geojson", events(parseGeoJson)],
  ["geojson-mtq", "ca-qc-mtq", "mtq-qc/chantiers.geojson", events(parseGeoJson)],
  ["geojson-mtq-warnings", "ca-qc-mtq-warnings", "mtq-qc/evenements.geojson", events(parseGeoJson)],
  ["geojson-brussels", "be-brussels", "brussels-be/traffic_events.geojson", events(parseGeoJson)],
  [
    "geojson-vegagerdin",
    "is-vegagerdin",
    "vegagerdin-is/pointincident.geojson",
    events(parseGeoJson),
  ],
  [
    "geojson-vegagerdin-lines",
    "is-vegagerdin-lines",
    "vegagerdin-is/line-incidents.json",
    events(parseGeoJson),
  ],
  ["geojson-trafficsa", "au-sa-trafficsa", "trafficsa-au/events.geojson", events(parseGeoJson)],
  [
    "geojson-polizei-hh",
    "de-hh-polizei",
    "polizei-hamburg-de/hauptmeldungen.geojson",
    events(parseGeoJson),
  ],
  ["flatjson-longdo", "th-longdo", "longdo-th/events.json", events(parseFlatJson)],
  ["gddkia", "pl-gddkia", "gddkia-pl/utrdane.xml", events(parseGddkia)],
  ["autobahn", "de-autobahn", "autobahn/warning.json", events(parseAutobahn)],
  [
    "ohgo-construction",
    "us-oh-ohgo-construction",
    "ohgo-oh/construction.json",
    events(parseOhgoEvents),
  ],
  ["ohgo-incidents", "us-oh-ohgo-incidents", "ohgo-oh/incidents.json", events(parseOhgoEvents)],
  [
    "vic-planned",
    "au-vic-transportvic-planned",
    "vic-au/planned.json",
    events(parseVicDisruptions),
  ],
  [
    "vic-unplanned",
    "au-vic-transportvic-unplanned",
    "vic-au/unplanned.json",
    events(parseVicDisruptions),
  ],
  [
    "ibi511",
    "ca-on-511",
    "ibi511/events.json",
    events((b, s) => parseIbi511(b.toString("utf8"), s)),
  ],
  [
    "ibi511-conditions",
    "ca-on-511-conditions",
    "ibi511/conditions.json",
    events((b, s) => parseIbi511Conditions(JSON.parse(b.toString("utf8")), s)),
  ],
  ["lta", "sg-lta", "lta/incidents.json", events(parseLtaIncidents)],
  ["trafikverket", "se-trafikverket", "trafikverket/situations.json", events(parseTrafikverket)],
];

function sealAll(name: string, feed: string, fixture: string, parse: Parse) {
  const src = descriptor(feed);
  const input = readFileSync(join(import.meta.dirname, "fixtures", fixture));
  const parsed = parse(input, src);
  const drafts = situationDrafts(parsed.events, { source: src, records: parsed.records });
  const sealed = drafts.map((d) =>
    sealRecord(registry, d, { instanceId: "golden.test", revision: 1, recordedAt: FROZEN }),
  );
  const failures = sealed.flatMap((s, i) =>
    s.ok ? [] : [{ id: drafts[i]!["id"], issues: s.issues.slice(0, 5) }],
  );
  return { name, parsed, drafts, sealed, failures };
}

const golden = (name: string) => join(import.meta.dirname, "golden", `${name}.json`);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("situation golden fixtures", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FROZEN));
  });
  afterAll(() => vi.useRealTimers());

  it.each(CASES)("%s: every situation seals and matches its golden file", async (...args) => {
    const { name, parsed, drafts, sealed, failures } = sealAll(...args);
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(drafts.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    await expect(json(sealed.map((s) => (s.ok ? s.value : null)))).toMatchFileSnapshot(
      golden(name),
    );
  });

  it("nl-ndw full snapshot: every situation seals; the summary matches its golden file", async () => {
    const { sealed, failures, parsed } = sealAll(
      "datex2-ndw",
      "nl-ndw",
      "ndw/actueel_beeld.xml",
      datex,
    );
    expect(failures).toEqual([]);
    const values = sealed.flatMap((s) => (s.ok ? [s.value] : []));
    const byCode: Record<string, number> = {};
    const byEffect: Record<string, number> = {};
    for (const v of values) {
      const code = [v["kind"], v["type"], v["subtype"]].filter(Boolean).join(".");
      byCode[code] = (byCode[code] ?? 0) + 1;
      for (const e of v["effects"] as { kind: string }[])
        byEffect[e.kind] = (byEffect[e.kind] ?? 0) + 1;
    }
    const sorted = (o: Record<string, number>) =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    await expect(
      json({
        events: parsed.events.length,
        situations: values.length,
        classifications: sorted(byCode),
        effects: sorted(byEffect),
        sample: values.slice(0, 5),
      }),
    ).toMatchFileSnapshot(golden("datex2-ndw-summary"));
  });
});
