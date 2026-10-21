import {
  enumsByProperty,
  fuzzParameters,
  fuzzTimeout,
  type JsonPath,
  jsonSchemaEnums,
  type Mutation,
  mutateJson,
  mutateXml,
  mutations,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { CAP_V1_2 } from "@openconditions/conformance/standards/cap-v1.2";
import { NWS_API } from "@openconditions/conformance/standards/nws-api";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { capSchema } from "./helpers/cap-xsd.js";
import { runFormat, runProblems } from "./helpers/fuzz.js";
import * as feeds from "./helpers/hazards-feed.js";

/**
 * The hazards formats over random documents: the captured fixtures, changed
 * inside their records (fields deleted, nulled, duplicated, emptied or
 * retyped, values swapped for others the standard enumerates, for awkward
 * text, times, numbers and language tags, and for keys every object
 * inherits). Whatever a record holds, the parse does not fail, every draft
 * seals and is sound, and every source record is published, repeated,
 * terminal or counted as skipped: one to one for the GeoJSON formats, at
 * least once per message for CAP, whose message may hold several hazards. The
 * CSV fire lists give a reading per detection only where it reads, so their
 * rows are held to the parse and the drafts alone. Seeded: `FUZZ_SCALE` and
 * `FUZZ_SEED` widen the search.
 */

const json = (name: string): unknown => JSON.parse(feeds.fixture(name).toString("utf8"));

/** Whether a path lies below a payload's list of records, so the envelope stays readable. */
const below =
  (prefix: JsonPath) =>
  (path: JsonPath): boolean =>
    path.length > prefix.length + 1 && prefix.every((key, i) => path[i] === key);

interface JsonCase {
  name: string;
  format: string;
  feed: () => HazardsCatalogFeed;
  fetchedAt: string;
  /** The payload files by role; the first role's records are mutated. */
  payloads: Record<string, string[]>;
  records: JsonPath;
  accounting?: "cap";
}

const JSON_CASES: JsonCase[] = [
  {
    name: "USGS",
    format: "usgs",
    feed: feeds.usgsFeed,
    fetchedAt: "2026-10-09T01:15:00Z",
    payloads: { recent: ["usgs-all-day.geojson"], window: ["usgs-all-month.geojson"] },
    records: ["features"],
  },
  {
    name: "EONET",
    format: "eonet",
    feed: feeds.eonetFeed,
    fetchedAt: "2026-10-09T01:15:00Z",
    payloads: {
      open: ["eonet-open.json"],
      closed: ["eonet-closed.json", "eonet-closed-volcano.json"],
    },
    records: ["events"],
  },
  {
    name: "WFIGS",
    format: "wfigs",
    feed: feeds.wfigsFeed,
    fetchedAt: "2026-10-09T01:15:00Z",
    payloads: { perimeters: ["nifc-perimeters.geojson"], incidents: ["nifc-incidents.geojson"] },
    records: ["features"],
  },
  {
    name: "EFFIS",
    format: "effis",
    feed: feeds.effisFeed,
    fetchedAt: "2026-10-09T01:15:00Z",
    payloads: { main: ["effis-burnt-areas.geojson"] },
    records: ["features"],
  },
  {
    name: "HMS",
    format: "hms",
    feed: feeds.hmsFeed,
    fetchedAt: "2026-09-30T12:00:00Z",
    payloads: { main: ["hms-smoke.geojson"] },
    records: ["features"],
  },
  {
    name: "NWS",
    format: "nws",
    feed: feeds.nwsFeed,
    fetchedAt: "2026-10-09T01:15:00Z",
    payloads: {
      alerts: ["nws-alerts-active.json"],
      zones: ["nws-zone-county-FLC079.json", "nws-zone-forecast-FLZ019.json"],
    },
    records: ["features"],
    accounting: "cap",
  },
  {
    name: "MeteoAlarm",
    format: "meteoalarm",
    feed: feeds.meteoalarmFeed,
    fetchedAt: "2026-10-05T09:00:00Z",
    payloads: {
      alerts: ["meteoalarm-austria.json", "meteoalarm-france.json"],
      geocodes: ["meteoalarm-geocodes.json"],
    },
    records: ["warnings"],
    accounting: "cap",
  },
];

let enums = new Map<string, string[]>();
let capValues: string[][] = [];
let unavailable: string | undefined;

beforeAll(async () => {
  const [nws, cap] = await Promise.all([
    pinnedOrUnavailable(NWS_API),
    pinnedOrUnavailable(CAP_V1_2),
  ]);
  if ("unavailable" in nws || "unavailable" in cap) {
    unavailable =
      "unavailable" in nws ? nws.unavailable : (cap as { unavailable: string }).unavailable;
    return;
  }
  // The NWS document's enumerations, the CAP ones among them, by the property holding them.
  enums = enumsByProperty(jsonSchemaEnums(JSON.parse(nws.files[0]!.contents)));
  capValues = [...capSchema(cap.files).enumerations.values()].map((values) => [...values]);
}, 120_000);

describe("hazards formats over mutated captures", () => {
  it.for(JSON_CASES)(
    "$name: never fails, seals every draft and accounts for every record",
    { timeout: fuzzTimeout(15_000) },
    ({ format, feed, fetchedAt, payloads, records, accounting }, { skip }) => {
      if (unavailable) skip(unavailable);
      const docs = Object.fromEntries(
        Object.entries(payloads).map(([role, files]) => [role, files.map(json)]),
      );
      const role = Object.keys(payloads)[0]!;
      fc.assert(
        fc.property(fc.nat(), mutations({ max: 5 }), (pick, list: Mutation[]) => {
          const which = pick % docs[role]!.length;
          const mutated = mutateJson(docs[role]![which], list, { within: below(records), enums });
          const bodies = Object.fromEntries(
            Object.entries(docs).map(([key, list]) => [
              key,
              list.map((doc, i) =>
                Buffer.from(JSON.stringify(key === role && i === which ? mutated.doc : doc)),
              ),
            ]),
          );
          const run = runFormat(format, feed(), bodies, fetchedAt);
          expect(
            runProblems(run, accounting ? { accounting } : {}),
            mutated.applied.join("; "),
          ).toEqual([]);
        }),
        fuzzParameters(150),
      );
    },
  );

  it.for([
    {
      name: "DWD",
      feed: feeds.dwdFeed,
      fetchedAt: "2026-09-29T05:40:00Z",
      files: ["dwd-thunderstorm.xml", "dwd-coastal-gusts-mul.xml", "dwd-coast-strong-wind-mul.xml"],
      areas: ["dwd-areas-coast.json", "dwd-areas-lakes.json"],
    },
    {
      name: "ECCC",
      feed: feeds.ecccFeed,
      fetchedAt: "2026-09-30T15:00:00Z",
      files: ["eccc-storm-surge.xml", "eccc-storm-surge-ended.xml", "eccc-fog.xml"],
      areas: [],
    },
  ])(
    "CAP 1.2 ($name): never fails, seals every draft and accounts for every message",
    { timeout: fuzzTimeout(15_000) },
    ({ feed, fetchedAt, files, areas }, { skip }) => {
      if (unavailable) skip(unavailable);
      const texts = files.map((f) => feeds.fixture(f).toString("utf8"));
      const shapes = areas.map(feeds.fixture);
      fc.assert(
        fc.property(fc.nat(), mutations({ max: 5 }), (pick, list) => {
          const which = pick % texts.length;
          // The other messages stay as captured, so the parse always has one that reads.
          const { xml, applied } = mutateXml(texts[which]!, list, { enumerations: capValues });
          const alerts = texts.map((t, i) => Buffer.from(i === which ? xml : t));
          const run = runFormat("cap", feed(), { alerts, areas: shapes }, fetchedAt);
          expect(runProblems(run, { accounting: "cap" }), applied.join("; ")).toEqual([]);
        }),
        fuzzParameters(150),
      );
    },
  );

  it("GDACS: never fails and seals every draft", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const rss = feeds.fixture("gdacs-rss.xml").toString("utf8");
    const cap = feeds.fixture("gdacs-cap.xml").toString("utf8");
    fc.assert(
      fc.property(fc.boolean(), mutations({ max: 5 }), (inRss, list) => {
        const { xml, applied } = mutateXml(inRss ? rss : cap, list, {
          enumerations: capValues,
          // Below the channel, so the payload stays one.
          within: (path) => path.split("/").length >= 3,
        });
        const run = runFormat(
          "gdacs",
          feeds.gdacsFeed(),
          { events: [Buffer.from(inRss ? xml : rss)], areas: [Buffer.from(inRss ? cap : xml)] },
          "2026-10-09T01:15:00Z",
        );
        expect(runProblems(run), applied.join("; ")).toEqual([]);
      }),
      fuzzParameters(100),
    );
  });

  it.for([
    {
      name: "FIRMS",
      format: "firms",
      feed: feeds.firmsViirsFeed,
      fetchedAt: "2026-10-08T21:10:00Z",
      role: "main",
      files: ["firms-viirs-n21.csv", "firms-viirs-n20.csv"],
      extra: {} as Record<string, Buffer[]>,
    },
    {
      name: "SLSTR FRP",
      format: "slstr-frp",
      feed: () => feeds.catalogFeed("eumetsat-slstr-fires"),
      fetchedAt: "2026-10-16T21:00:00Z",
      role: "fires",
      files: ["slstr-frp-s3a-day.csv", "slstr-frp-s3b-night.csv"],
      extra: { granules: [Buffer.from('{"type":"FeatureCollection","features":[]}')] },
    },
  ])(
    "$name: never fails and seals every reading",
    { timeout: fuzzTimeout(15_000) },
    ({ format, feed, fetchedAt, role, files, extra }) => {
      const tables = files.map((f) =>
        feeds
          .fixture(f)
          .toString("utf8")
          .split("\n")
          .map((line) => line.split(",")),
      );
      const csv = (rows: unknown[][]) =>
        rows
          .map((row) => row.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join(","))
          .join("\n");
      fc.assert(
        fc.property(fc.nat(), mutations({ keepTypes: true, max: 5 }), (pick, list) => {
          const which = pick % tables.length;
          const table = tables[which]!;
          const header = table.findIndex((row) => !row[0]!.startsWith("#") && row.length > 3);
          // A cell of a data row: the header and the comment lines stay as captured.
          const { doc, applied } = mutateJson({ rows: table }, list, {
            within: (path) => typeof path[1] === "number" && path[1] > header && path.length === 3,
          });
          const bodies = {
            ...extra,
            [role]: tables.map((t, i) =>
              Buffer.from(csv(i === which ? (doc as { rows: unknown[][] }).rows : t)),
            ),
          };
          const run = runFormat(format, feed(), bodies, fetchedAt);
          expect(runProblems(run, { accounting: false }), applied.join("; ")).toEqual([]);
        }),
        fuzzParameters(150),
      );
    },
  );
});
