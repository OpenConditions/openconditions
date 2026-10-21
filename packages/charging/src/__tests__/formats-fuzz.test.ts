import { fuzzTimeout } from "@openconditions/conformance";
import { describe, test } from "vitest";
import { fixture } from "./helpers/charging-feed.js";
import { distinct, fuzzJson, json, parseFeed, parseProblems, providerIds } from "./helpers/fuzz.js";

/**
 * Random documents of the charging formats that publish no machine-readable
 * schema: each captured answer with its records changed, dropped and
 * repeated, and its values made awkward or of the wrong type. Every record
 * seals; where a format makes one site of each source record, every record
 * is a site or counted as skipped.
 */

type Rec = Record<string, unknown>;
type Path = readonly (string | number)[];

const read = (name: string) => JSON.parse(fixture(name).toString("utf8")) as Rec;
/** Below each record of a document's list: the envelope stays readable. */
const inRecords = (list: string) => (path: Path) => path[0] === list && path.length > 2;
const records = (doc: Rec, list: string) =>
  Array.isArray(doc[list]) ? (doc[list] as unknown[]) : [];

describe("charging formats without a schema", () => {
  test(
    "NOBIL's charger stations",
    () => {
      fuzzJson(read("nobil.json"), { within: inRecords("chargerstations"), runs: 150 }, (doc) =>
        parseProblems(parseFeed("no-nobil-charging", { main: [json(doc)] }), {
          expected: distinct(records(doc as Rec, "chargerstations"), (s) => {
            const csmd = s["csmd"];
            return typeof csmd === "object" && csmd !== null ? (csmd as Rec)["id"] : undefined;
          }),
          produced: providerIds,
        }),
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "AFDC's fuel stations",
    () => {
      fuzzJson(read("afdc.json"), { within: inRecords("fuel_stations"), runs: 150 }, (doc) =>
        parseProblems(parseFeed("us-afdc-charging", { main: [json(doc)] }), {
          expected: distinct(records(doc as Rec, "fuel_stations"), (s) =>
            typeof s["id"] === "number" || typeof s["id"] === "string"
              ? String(s["id"]).trim() || undefined
              : undefined,
          ),
          produced: providerIds,
        }),
      );
    },
    fuzzTimeout(5_000),
  );

  // An element that is no charging station, or one for bicycles alone, is
  // not a site of this domain, so Overpass answers are not counted here.
  test(
    "OpenStreetMap's charging stations from Overpass",
    () => {
      fuzzJson(
        read("overpass-charging.json"),
        { within: inRecords("elements"), runs: 150 },
        (doc) => parseProblems(parseFeed("osm-charging", { main: [json(doc)] })),
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "LTA's charging points",
    () => {
      fuzzJson(read("lta-batch.json"), { within: inRecords("value"), runs: 100 }, (doc) =>
        parseProblems(parseFeed("sg-lta-charging", { main: [json(doc)] })),
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "NZTA's EVRoam sites",
    () => {
      fuzzJson(read("evroam.geojson"), { within: inRecords("features"), runs: 100 }, (doc) =>
        parseProblems(parseFeed("nz-nzta-charging", { main: [json(doc)] })),
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "TDX's stations, rates and live status",
    () => {
      const rest = { tariffs: [fixture("tdx-rate.json")], status: [fixture("tdx-live.json")] };
      fuzzJson(read("tdx-station.json"), { within: inRecords("Stations"), runs: 100 }, (doc) =>
        parseProblems(parseFeed("tw-tdx-charging", { sites: [json(doc)], ...rest })),
      );
    },
    fuzzTimeout(5_000),
  );
});
