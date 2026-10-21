import {
  draftProblems,
  fuzzParameters,
  fuzzTimeout,
  type JsonPath,
  type Mutation,
  mutateJson,
  mutations,
} from "@openconditions/conformance";
import {
  __resetSkips,
  type CatalogFeed,
  drainSkipped,
  type ParseOutput,
  skippedRecords,
} from "@openconditions/ingest-framework";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fuelDomain } from "../domain.js";
import {
  econtrolFeed,
  fixture,
  mineturFeed,
  osmFuelFeed,
  parseContext,
  prixCarburantsFeed,
  tankerkoenigFeed,
} from "./helpers/fuel-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * Each fuel format over mutated copies of its captured fixture: fields
 * deleted, retyped or swapped for awkward values inside the station records,
 * the envelope left readable. The parser must not throw, every draft must
 * seal and be valid data, and every station record must become a station or
 * be counted as skipped.
 */

type Rec = Record<string, unknown>;

const json = (name: string): unknown => JSON.parse(fixture(name).toString("utf8"));

/** A record's id as the parsers read one: text, or a finite number's decimal text. */
const idOf = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : undefined;

interface FuzzCase {
  name: string;
  feed: () => CatalogFeed;
  fetchedAt: string;
  /** The payloads, the first of which is mutated. */
  bases: unknown[];
  within: (path: JsonPath) => boolean;
  /**
   * The ids of the station records of a poll's documents, each to become a
   * station or be counted: undefined where the format's records cannot be
   * counted one to one.
   */
  records?: (docs: unknown[]) => (string | undefined)[];
}

const listOf = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);

const CASES: FuzzCase[] = [
  {
    name: "econtrol",
    feed: econtrolFeed,
    fetchedAt: "2026-10-04T01:20:00Z",
    bases: [
      json("econtrol-by-address-die.json"),
      json("econtrol-by-address-gas.json"),
      json("econtrol-by-address-sup.json"),
    ],
    within: (path) => path.length >= 1,
    records: (docs) => docs.flatMap((d) => listOf(d).map((s) => idOf(s?.["id"]))),
  },
  {
    name: "minetur",
    feed: mineturFeed,
    fetchedAt: "2026-10-03T21:55:00Z",
    bases: [json("minetur-stations.json")],
    within: (path) => path[0] === "ListaEESSPrecio" && path.length >= 2,
    records: ([d]) => listOf((d as Rec)["ListaEESSPrecio"]).map((s) => idOf(s?.["IDEESS"])),
  },
  {
    name: "prix-carburants",
    feed: prixCarburantsFeed,
    fetchedAt: "2026-10-17T12:25:00Z",
    bases: [json("prix-carburants.json")],
    within: (path) => path.length >= 1,
    records: ([d]) => listOf(d).map((s) => idOf(s?.["id"])),
  },
  {
    name: "tankerkoenig",
    feed: tankerkoenigFeed,
    fetchedAt: "2026-10-04T01:26:00Z",
    bases: [json("tankerkoenig-list.json")],
    within: (path) => path[0] === "stations" && path.length >= 2,
    records: ([d]) => listOf((d as Rec)["stations"]).map((s) => idOf(s?.["id"])),
  },
  {
    // An Overpass answer holds the stations' outlines and their nodes as well,
    // which no station is made of, so its records are not counted one to one.
    name: "overpass",
    feed: osmFuelFeed,
    fetchedAt: "2026-10-04T01:24:00Z",
    bases: [json("overpass-fuel.json")],
    within: (path) => path[0] === "elements" && path.length >= 2,
  },
];

function run(c: FuzzCase, list: Mutation[]) {
  const { doc, applied } = mutateJson(c.bases[0], list, { within: c.within });
  const docs = [doc, ...c.bases.slice(1)];
  const what = JSON.stringify(applied);
  const feed = c.feed();
  __resetSkips();
  let out: ParseOutput;
  try {
    out = fuelDomain.formats[feed.format]!.parse(
      feed,
      { main: docs.map((d) => Buffer.from(JSON.stringify(d))) },
      parseContext(c.fetchedAt),
    );
  } catch (error) {
    throw new Error(`threw after ${what}: ${(error as Error).stack}`);
  }
  const drafts = [...out.features, ...out.observations, ...out.offers];
  expect(sealFailures(drafts), what).toEqual([]);
  expect(draftProblems(drafts), what).toEqual([]);
  const skipped = skippedRecords(drainSkipped(feed.id));
  const ids = c.records?.(docs);
  if (ids === undefined) return;
  const records =
    new Set(ids.filter((id) => id !== undefined)).size +
    ids.filter((id) => id === undefined).length;
  const stations = new Set(out.features.map((f) => f["id"])).size;
  expect(stations, what).toBeLessThanOrEqual(records);
  expect(stations + skipped + (out.rejected ?? 0), what).toBeGreaterThanOrEqual(records);
}

describe("fuel formats over mutated fixtures", () => {
  for (const c of CASES) {
    it(
      c.name,
      () => {
        fc.assert(
          fc.property(mutations(), (list) => run(c, list)),
          fuzzParameters(150),
        );
      },
      fuzzTimeout(3_000),
    );
  }
});
