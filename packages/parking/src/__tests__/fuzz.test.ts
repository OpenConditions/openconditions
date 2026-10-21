import {
  enumsByProperty,
  fuzzParameters,
  fuzzTimeout,
  type JsonPath,
  type JsonValidator,
  jsonSchemaEnums,
  type Mutation,
  mutateJson,
  mutateXml,
  mutations,
  openApiValidator,
  pinnedOrUnavailable,
  xsdEnumerations,
} from "@openconditions/conformance";
import { DATEX2_V2 } from "@openconditions/conformance/standards/datex2-v2";
import { DATEX2_V3 } from "@openconditions/conformance/standards/datex2-v3";
import { PARKAPI_V3 as PARKAPI_SCHEMA } from "@openconditions/conformance/standards/parkapi-v3";
import type { ParseOutput } from "@openconditions/ingest-framework";
import { PARKAPI_V3 } from "@openconditions/model-parking";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { runFormat, runProblems } from "./helpers/fuzz.js";
import * as feeds from "./helpers/parking-feed.js";

/**
 * The parking formats over random documents: the captured fixtures, changed
 * inside their records (fields deleted, nulled, duplicated or emptied, values
 * swapped for others the standard enumerates, for awkward text, times,
 * numbers and language tags, and for keys every object inherits). Whatever a
 * record holds, the parse does not fail, every draft seals and is sound, and
 * where a payload's records are counted one by one each source site is
 * published or counted as skipped, even where a value is of another JSON
 * type than the field's. Seeded:
 * `FUZZ_SCALE` and `FUZZ_SEED` widen the search.
 */

type Json = Record<string, unknown>;

const json = (name: string): unknown => JSON.parse(feeds.fixture(name).toString("utf8"));

/** Whether a path lies below a payload's list of records, so the envelope stays readable. */
const below =
  (prefix: JsonPath) =>
  (path: JsonPath): boolean =>
    path.length > prefix.length + 1 && prefix.every((key, i) => path[i] === key);

const at = (doc: unknown, path: JsonPath): unknown =>
  path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)?.[key], doc);

interface JsonCase {
  name: string;
  format: string;
  feed: () => ParkingCatalogFeed;
  fetchedAt: string;
  /** The payload files by role; the first role holds the sites. */
  payloads: Record<string, string[]>;
  /** Where each role's records are. */
  records: Record<string, JsonPath>;
  /**
   * For a format whose every site record is one site, the sites a document's
   * records should give: the published ones and the skipped ones together.
   */
  sites?: (records: unknown[]) => number;
}

const all = (records: unknown[]) => records.length;

const CASES: JsonCase[] = [
  {
    name: "ParkAPI v3",
    format: "parkapi-v3",
    feed: feeds.mobidataFeed,
    fetchedAt: "2026-10-05T03:31:40Z",
    payloads: {
      main: ["parkapi-v3-sites.json"],
      sources: ["parkapi-v3-sources.json"],
      spots: ["parkapi-v3-spots.json"],
    },
    records: { main: ["items"], sources: ["items"], spots: ["items"] },
    // Sites for bicycles, motorcycles and items are left out by design.
    sites: (records) =>
      records.filter((r) => {
        const purpose = (r as { purpose?: unknown } | null)?.purpose;
        return typeof purpose !== "string" || purpose === "CAR" || !PURPOSES.has(purpose);
      }).length,
  },
  {
    name: "TfNSW Park&Ride",
    format: "tfnsw",
    feed: feeds.tfnswFeed,
    fetchedAt: "2024-11-25T00:10:00Z",
    payloads: { main: ["tfnsw-full-list.json"] },
    records: { main: [] },
    sites: all,
  },
  {
    name: "SBB",
    format: "sbb",
    feed: feeds.sbbFeed,
    fetchedAt: "2026-10-05T04:04:17Z",
    payloads: { main: ["sbb-parking.json"] },
    records: { main: ["features"] },
    // Bicycle facilities are left out by design.
    sites: (records) =>
      records.filter(
        (r) =>
          (r as { properties?: { parkingFacilityCategory?: unknown } } | null)?.properties
            ?.parkingFacilityCategory !== "BIKE",
      ).length,
  },
  {
    name: "DB BahnPark",
    format: "db-bahnpark",
    feed: feeds.dbBahnparkFeed,
    fetchedAt: "2026-10-05T04:00:00Z",
    payloads: { main: ["db-bahnpark-sample.json"] },
    records: { main: [] },
    sites: all,
  },
  {
    name: "Overpass",
    format: "overpass",
    feed: feeds.osmParkingFeed,
    fetchedAt: "2026-10-05T03:43:24Z",
    payloads: { main: ["overpass-parking.json"] },
    records: { main: ["elements"] },
    sites: all,
  },
  {
    name: "DATEX II Light",
    format: "datex2-light",
    feed: feeds.mobidromFeed,
    fetchedAt: "2026-10-05T03:30:40Z",
    payloads: { main: ["mobidrom-parken-nrw.json"] },
    records: { main: ["parkingPublicationLight", "parkingSite"] },
    sites: all,
  },
  {
    name: "a GeoJSON layout",
    format: "geojson",
    feed: feeds.ghentFeed,
    fetchedAt: "2026-10-05T03:12:30Z",
    payloads: { main: ["ghent.geojson"] },
    records: { main: ["features"] },
    sites: all,
  },
  // Two-payload formats: a status record of a site the table lacks is
  // skipped too, so their sites are not counted one by one.
  {
    name: "RDW",
    format: "rdw",
    feed: feeds.rdwFeed,
    fetchedAt: "2026-10-05T04:00:00Z",
    payloads: {
      specs: ["rdw-nl-specs.json"],
      areas: ["rdw-nl-garage.json", "rdw-nl-pnr.json", "rdw-nl-carpool.json"],
    },
    records: { specs: [], areas: [] },
  },
  {
    name: "Open Data Hub",
    format: "opendatahub",
    feed: feeds.opendatahubFeed,
    fetchedAt: "2026-05-23T12:00:00Z",
    payloads: {
      sites: ["opendatahub-it-stations.json"],
      status: ["opendatahub-it-measurements.json"],
    },
    records: { sites: ["data"], status: ["data"] },
  },
  {
    name: "HDB",
    format: "hdb",
    feed: feeds.hdbFeed,
    fetchedAt: "2026-05-23T02:00:00Z",
    payloads: { sites: ["singapore-static.json"], status: ["singapore-live.json"] },
    records: { sites: ["result", "records"], status: ["items"] },
  },
  {
    name: "UTMC",
    format: "utmc",
    feed: feeds.utmcFeed,
    fetchedAt: "2012-01-14T10:10:00Z",
    payloads: { sites: ["utmc-static-sample.json"], status: ["utmc-dynamic-sample.json"] },
    records: { sites: [], status: [] },
  },
];

const PURPOSES: ReadonlySet<string> = new Set(PARKAPI_V3.purposes);

let enums = new Map<string, string[]>();
let datexValues: string[][] = [];
let validSite: JsonValidator | undefined;
let unavailable: string | undefined;

beforeAll(async () => {
  const [parkapi, v3, v2] = await Promise.all([
    pinnedOrUnavailable(PARKAPI_SCHEMA),
    pinnedOrUnavailable(DATEX2_V3),
    pinnedOrUnavailable(DATEX2_V2),
  ]);
  if ("unavailable" in parkapi || "unavailable" in v3 || "unavailable" in v2) {
    unavailable = [parkapi, v3, v2].flatMap((p) => ("unavailable" in p ? [p.unavailable] : []))[0];
    return;
  }
  const doc = JSON.parse(parkapi.files[0]!.contents) as Json;
  enums = enumsByProperty(jsonSchemaEnums(doc));
  validSite = openApiValidator(doc, "ParkingSite");
  datexValues = [...xsdEnumerations(v3.files), ...xsdEnumerations(v2.files)].map((e) => e.values);
}, 120_000);

describe("parking formats over mutated captures", () => {
  it.for(CASES)(
    "$name: never fails, seals every draft and accounts for every site",
    { timeout: fuzzTimeout(15_000) },
    ({ format, feed, fetchedAt, payloads, records, sites }, { skip }) => {
      if (unavailable) skip(unavailable);
      const docs = Object.fromEntries(
        Object.entries(payloads).map(([role, files]) => [role, files.map(json)]),
      );
      const roles = Object.keys(payloads);
      fc.assert(
        fc.property(fc.nat(), fc.nat(), mutations({ max: 5 }), (r, d, list: Mutation[]) => {
          const role = roles[r % roles.length]!;
          const which = d % docs[role]!.length;
          const mutated = mutateJson(docs[role]![which], list, {
            within: below(records[role]!),
            enums,
          });
          const bodies = Object.fromEntries(
            Object.entries(docs).map(([key, list]) => [
              key,
              list.map((doc, i) =>
                Buffer.from(JSON.stringify(key === role && i === which ? mutated.doc : doc)),
              ),
            ]),
          );
          const siteRecords = role === roles[0] ? at(mutated.doc, records[role]!) : undefined;
          const accounting =
            sites !== undefined && Array.isArray(siteRecords)
              ? {
                  input: sites(siteRecords),
                  sites: (out: ParseOutput) =>
                    out.features.filter((f) => !String(f["id"]).includes(":spot/")).length,
                }
              : undefined;
          const problems = runProblems(runFormat(format, feed(), bodies, fetchedAt), accounting);
          expect(problems, `${role}: ${mutated.applied.join("; ")}`).toEqual([]);
        }),
        fuzzParameters(150),
      );
    },
  );

  it("ParkAPI v3: a site its OpenAPI document allows is published or counted", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const capture = (json("parkapi-v3-sites.json") as { items: Json[] }).items;
    const sources = feeds.fixture("parkapi-v3-sources.json");
    let valid = 0;
    fc.assert(
      fc.property(fc.nat(), mutations({ keepTypes: true, max: 4 }), (pick, list) => {
        const base = capture[pick % capture.length]!;
        const { doc, applied } = mutateJson(base, list, { enums });
        const site = doc as Json;
        if (validSite!(site).length > 0) return;
        valid++;
        const run = runFormat(
          "parkapi-v3",
          feeds.mobidataFeed(),
          { main: [Buffer.from(JSON.stringify({ items: [site] }))], sources: [sources] },
          "2026-10-05T03:31:40Z",
        );
        const purpose = typeof site["purpose"] === "string" ? site["purpose"] : "CAR";
        const expected = purpose === "CAR" ? 1 : 0;
        expect(
          runProblems(run, { input: expected, sites: (out) => out.features.length }),
          applied.join("; "),
        ).toEqual([]);
      }),
      fuzzParameters(200),
    );
    // Most mutants stay within the schema, so the property is not vacuous.
    expect(valid).toBeGreaterThan(20);
  });

  it.for([
    {
      name: "NDW (DATEX II v2 table, v3 status)",
      feed: feeds.ndwFeed,
      files: ["ndw-truck-table.xml", "ndw-truck-status.xml"],
    },
    {
      name: "CITA (DATEX II v2)",
      feed: feeds.citaFeed,
      files: ["cita-static.xml", "cita-dynamic.xml"],
    },
  ])(
    "$name: never fails and seals every draft",
    { timeout: fuzzTimeout(15_000) },
    ({ feed, files }, { skip }) => {
      if (unavailable) skip(unavailable);
      const [table, status] = files.map((f) => feeds.fixture(f).toString("utf8")) as [
        string,
        string,
      ];
      fc.assert(
        fc.property(fc.boolean(), mutations({ max: 5 }), (inTable, list) => {
          const { xml, applied } = mutateXml(inTable ? table : status, list, {
            enumerations: datexValues,
            // Below the publication, so the payload stays one.
            within: (path) => path.split("/").length >= 4,
          });
          const run = runFormat(
            "datex2",
            feed(),
            {
              sites: [Buffer.from(inTable ? xml : table)],
              status: [Buffer.from(inTable ? status : xml)],
            },
            "2026-10-05T03:35:30Z",
          );
          expect(runProblems(run), applied.join("; ")).toEqual([]);
        }),
        fuzzParameters(100),
      );
    },
  );
});
