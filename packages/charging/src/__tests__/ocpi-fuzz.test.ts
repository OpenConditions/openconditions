import {
  enumsByProperty,
  fuzzTimeout,
  jsonSchemaEnums,
  parseYaml,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { OCPI_2_2_1, OCPI_2_3_0 } from "@openconditions/conformance/standards/ocpi";
import { beforeAll, describe, test } from "vitest";
import { ocpiFixture } from "./helpers/charging-feed.js";
import { distinct, fuzzJson, json, parseFeed, parseProblems, providerIds } from "./helpers/fuzz.js";

/**
 * Random OCPI documents through the real OCPI and Digitraffic formats:
 * captured locations, tariffs and statuses with their records changed, their
 * enumerated values swapped for others OCPI 2.2.1 and 2.3.0 define. Every
 * record seals, and every location is a site or counted as skipped.
 */

type Rec = Record<string, unknown>;

const read = (name: string) => JSON.parse(ocpiFixture(name).toString("utf8")) as unknown;
const upper = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : undefined);

/** Every EVSE of a location taken away: OCPI's way of saying the location is gone. */
function removed(loc: Rec): boolean {
  const evses = Array.isArray(loc["evses"]) ? (loc["evses"] as unknown[]) : [];
  return (
    evses.length > 0 &&
    evses.every(
      (e) => typeof e === "object" && e !== null && upper((e as Rec)["status"]) === "REMOVED",
    )
  );
}

/** The locations a parse must account for: those published and not gone, once per id. */
const publishedLocations = (locations: unknown[]) =>
  distinct(locations, (l) =>
    l["publish"] === false || removed(l)
      ? undefined
      : [upper(l["country_code"]), upper(l["party_id"]), l["id"]],
  );

let enums = new Map<string, string[]>();
let unavailable: string | undefined;

beforeAll(async () => {
  for (const set of [OCPI_2_2_1, OCPI_2_3_0]) {
    const pinned = await pinnedOrUnavailable(set);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    for (const file of pinned.files) {
      for (const [name, values] of enumsByProperty(jsonSchemaEnums(parseYaml(file.contents)))) {
        enums.set(name, [...new Set([...(enums.get(name) ?? []), ...values])]);
      }
    }
  }
}, 120_000);

describe("OCPI locations and tariffs", () => {
  const LOCATIONS = read("ndw-locations.json") as unknown[];
  const tariffs = [ocpiFixture("ndw-tariffs.json")];

  for (const keepTypes of [true, false]) {
    test(
      `NDW locations, ${keepTypes ? "schema-shaped" : "with values of the wrong type"}`,
      ({ skip }) => {
        if (unavailable) skip(unavailable);
        fuzzJson(LOCATIONS, { enums, keepTypes, runs: 150 }, (locations) =>
          parseProblems(parseFeed("nl-ndw-charging", { main: [json(locations)], tariffs }), {
            expected: publishedLocations(locations as unknown[]),
            produced: providerIds,
          }),
        );
      },
      fuzzTimeout(5_000),
    );
  }

  test(
    "NDW tariffs",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const main = [ocpiFixture("ndw-locations.json")];
      fuzzJson(read("ndw-tariffs.json"), { enums, runs: 150 }, (list) =>
        parseProblems(parseFeed("nl-ndw-charging", { main, tariffs: [json(list)] })),
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "OCPDB locations with their tariffs, associations and sources",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const rest = {
        tariffs: [ocpiFixture("ocpdb-tariffs.json")],
        associations: [ocpiFixture("ocpdb-associations.json")],
        sources: [ocpiFixture("ocpdb-sources.json")],
      };
      // The page envelope stays as it is: only its records change.
      fuzzJson(
        read("ocpdb-locations.json"),
        { enums, within: (path) => path.length > 2, runs: 100 },
        (page) =>
          parseProblems(parseFeed("de-bw-mobidata-charging", { main: [json(page)], ...rest })),
      );
    },
    fuzzTimeout(5_000),
  );
});

describe("Digitraffic's OCPI as GeoJSON", () => {
  const main = [ocpiFixture("digitraffic-locations.json")];
  const status = [ocpiFixture("digitraffic-statuses.json")];
  const tariffs = [ocpiFixture("digitraffic-tariffs.json")];
  const inList = (list: string) => (path: readonly (string | number)[]) =>
    path[0] === list && path.length > 1;

  test(
    "locations",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      fuzzJson(
        read("digitraffic-locations.json"),
        { enums, within: inList("features"), runs: 150 },
        (doc) =>
          parseProblems(
            parseFeed("fi-digitraffic-charging", { main: [json(doc)], status, tariffs }),
            {
              expected: distinct((doc as Rec)["features"] as unknown[], (f) =>
                typeof f["properties"] === "object" && f["properties"] !== null
                  ? (f["properties"] as Rec)["id"]
                  : undefined,
              ),
              produced: providerIds,
            },
          ),
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "statuses and tariffs",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      fuzzJson(
        read("digitraffic-statuses.json"),
        { enums, within: inList("statuses"), runs: 100 },
        (doc) =>
          parseProblems(
            parseFeed("fi-digitraffic-charging", { main, status: [json(doc)], tariffs }),
          ),
      );
      fuzzJson(
        read("digitraffic-tariffs.json"),
        { enums, within: inList("tariffs"), runs: 100 },
        (doc) =>
          parseProblems(
            parseFeed("fi-digitraffic-charging", { main, status, tariffs: [json(doc)] }),
          ),
      );
    },
    fuzzTimeout(5_000),
  );
});
