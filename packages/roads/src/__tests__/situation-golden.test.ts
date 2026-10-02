import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FEED_SOURCES } from "../feeds.js";
import { parseEvents, type RoadFeed } from "../parse.js";

/**
 * Golden fixtures for every current road event source format: the reviewed
 * source fixture goes through the feed's parse entry, every draft must seal
 * (hard validation against the production kinds), and the sealed records are
 * compared with the committed golden file. A parser or crosswalk change shows
 * up as a golden diff to review; `vitest -u` rewrites the files after review.
 * DATEX and Digitraffic fixtures are read as complete snapshots, the path that
 * carries record versions.
 */
const registry = buildRegistry([kernelModule, roadsModule]);
const FROZEN = "2026-09-18T10:00:00.000Z";

function feedOf(feedId: string, format: string, complete: boolean): RoadFeed {
  const feed = FEED_SOURCES.find((f) => f.id === feedId);
  const base: RoadFeed = feed ?? {
    id: feedId,
    attribution: feedId,
    country: "SE",
    license: "CC0-1.0",
    format: format as RoadFeed["format"],
  };
  const fixed = { ...base, format: format as RoadFeed["format"] };
  return complete ? { ...fixed, snapshot: { completeness: "complete" } } : fixed;
}

const CASES: [name: string, feed: string, fixture: string, format: string][] = [
  ["datex2-ndw-restrictions", "nl-ndw", "ndw/restrictions-v3.xml", "datex2"],
  ["datex2-dgt", "es-dgt", "dgt-es/situations.xml", "datex2"],
  ["datex2-dir", "fr-dir", "dir-fr/situations.xml", "datex2"],
  ["datex2-cita", "lu-cita", "cita-lu/situations.xml", "datex2"],
  ["datex2-flanders", "be-flanders", "flanders-be/situations.xml", "datex2"],
  ["datex2-hc", "hr-hc-events", "hc-hr/events.datex3.xml", "datex2"],
  ["digitraffic-messages", "fi-digitraffic", "digitraffic/messages.json", "digitraffic"],
  ["digitraffic-restrictions", "fi-digitraffic", "digitraffic/v2-restrictions.json", "digitraffic"],
  ["digitraffic-weight", "fi-digitraffic", "digitraffic/weight-restriction.json", "digitraffic"],
  ["digitraffic-exempted", "fi-digitraffic", "digitraffic/exempted-transport.json", "digitraffic"],
  ["wzdx-feed", "us-wzdx", "wzdx/feed.json", "wzdx"],
  ["wzdx-cwz", "us-wzdx", "wzdx/cwz-pbs.json", "wzdx"],
  ["wzdx-modot", "us-wzdx", "wzdx/modot-v41.json", "wzdx"],
  ["wzdx-quebec", "us-wzdx", "wzdx/quebec-v31.json", "wzdx"],
  ["open511-drivebc", "ca-bc-drivebc", "drivebc/events.json", "open511"],
  ["geojson-nzta", "nz-nzta", "nzta-nz/road-events.geojson", "geojson"],
  ["geojson-berlin", "de-be-berlin", "berlin-de/baustellen.geojson", "geojson"],
  ["geojson-mtq", "ca-qc-mtq", "mtq-qc/chantiers.geojson", "geojson"],
  ["geojson-mtq-warnings", "ca-qc-mtq-warnings", "mtq-qc/evenements.geojson", "geojson"],
  ["geojson-brussels", "be-brussels", "brussels-be/traffic_events.geojson", "geojson"],
  ["geojson-vegagerdin", "is-vegagerdin", "vegagerdin-is/pointincident.geojson", "geojson"],
  [
    "geojson-vegagerdin-lines",
    "is-vegagerdin-lines",
    "vegagerdin-is/line-incidents.json",
    "geojson",
  ],
  ["geojson-trafficsa", "au-sa-trafficsa", "trafficsa-au/events.geojson", "geojson"],
  ["geojson-polizei-hh", "de-hh-polizei", "polizei-hamburg-de/hauptmeldungen.geojson", "geojson"],
  ["flatjson-longdo", "th-longdo", "longdo-th/events.json", "flatjson"],
  ["gddkia", "pl-gddkia", "gddkia-pl/utrdane.xml", "gddkia"],
  ["autobahn", "de-autobahn", "autobahn/warning.json", "autobahn"],
  ["ohgo-construction", "us-oh-ohgo-construction", "ohgo-oh/construction.json", "ohgo-events"],
  ["ohgo-incidents", "us-oh-ohgo-incidents", "ohgo-oh/incidents.json", "ohgo-events"],
  ["vic-planned", "au-vic-transportvic-planned", "vic-au/planned.json", "vic-disruptions"],
  ["vic-unplanned", "au-vic-transportvic-unplanned", "vic-au/unplanned.json", "vic-disruptions"],
  ["ibi511", "ca-on-511", "ibi511/events.json", "ibi511"],
  ["ibi511-conditions", "ca-on-511-conditions", "ibi511/conditions.json", "ibi511-conditions"],
  ["lta", "sg-lta", "lta/incidents.json", "lta"],
  ["trafikverket", "se-trafikverket", "trafikverket/situations.json", "trafikverket"],
];

const SNAPSHOT_FORMATS = new Set(["datex2", "digitraffic"]);

function sealAll(name: string, feedId: string, fixture: string, format: string) {
  const feed = feedOf(feedId, format, SNAPSHOT_FORMATS.has(format));
  const input = readFileSync(join(import.meta.dirname, "fixtures", fixture));
  const parsed = parseEvents(feed, [input]);
  const drafts = parsed.situations;
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
      "datex2",
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
        events: parsed.records?.accepted,
        situations: values.length,
        classifications: sorted(byCode),
        effects: sorted(byEffect),
        sample: values.slice(0, 5),
      }),
    ).toMatchFileSnapshot(golden("datex2-ndw-summary"));
  });
});
