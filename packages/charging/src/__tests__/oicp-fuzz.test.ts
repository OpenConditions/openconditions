import {
  enumsByProperty,
  fuzzTimeout,
  jsonSchemaEnums,
  parseYaml,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { OICP_2_3 } from "@openconditions/conformance/standards/oicp";
import { beforeAll, describe, test } from "vitest";
import { fixture } from "./helpers/charging-feed.js";
import {
  distinct,
  evseComponents,
  fuzzJson,
  json,
  parseFeed,
  parseProblems,
} from "./helpers/fuzz.js";

/**
 * Random OICP 2.3 EVSE data and status through the real format: the
 * captured pull with its records changed, their enumerated values swapped
 * for others the EMP OpenAPI description defines. Every record seals, and
 * every EVSE record is a charge point or counted as skipped.
 */

type Rec = Record<string, unknown>;

const FEED = "ch-bfe-charging";
const DATA = JSON.parse(fixture("oicp-data.json").toString("utf8")) as Rec;
const STATUS = JSON.parse(fixture("oicp-status.json").toString("utf8")) as Rec;

/** Below an operator block's record list: the blocks themselves stay readable. */
const inRecords = (path: readonly (string | number)[]) => path.length > 3;

/** The EVSE ids of a pull a parse must account for: those not deleted, once each. */
const evseIds = (doc: Rec) =>
  distinct(
    (Array.isArray(doc["EVSEData"]) ? (doc["EVSEData"] as unknown[]) : []).flatMap((block) =>
      typeof block === "object" && block !== null && Array.isArray((block as Rec)["EVSEDataRecord"])
        ? ((block as Rec)["EVSEDataRecord"] as unknown[])
        : [],
    ),
    (r) =>
      r["deltaType"] === "delete" || typeof r["EvseID"] !== "string" ? undefined : r["EvseID"],
  );

let enums = new Map<string, string[]>();
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(OICP_2_3);
  if ("unavailable" in pinned) unavailable = pinned.unavailable;
  else enums = enumsByProperty(jsonSchemaEnums(parseYaml(pinned.files[0]!.contents)));
}, 120_000);

describe("OICP 2.3", () => {
  for (const keepTypes of [true, false]) {
    test(
      `EVSE data, ${keepTypes ? "schema-shaped" : "with values of the wrong type"}`,
      ({ skip }) => {
        if (unavailable) skip(unavailable);
        const status = [fixture("oicp-status.json")];
        fuzzJson(DATA, { enums, keepTypes, within: inRecords, runs: 150 }, (doc) =>
          parseProblems(parseFeed(FEED, { main: [json(doc)], status }), {
            expected: evseIds(doc as Rec),
            produced: evseComponents,
          }),
        );
      },
      fuzzTimeout(5_000),
    );
  }

  test(
    "EVSE status",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const main = [fixture("oicp-data.json")];
      fuzzJson(STATUS, { enums, within: inRecords, runs: 100 }, (doc) =>
        parseProblems(parseFeed(FEED, { main, status: [json(doc)] })),
      );
    },
    fuzzTimeout(5_000),
  );
});
