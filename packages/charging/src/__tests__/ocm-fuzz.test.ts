import {
  enumsByProperty,
  fuzzTimeout,
  jsonSchemaEnums,
  parseYaml,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { OCM } from "@openconditions/conformance/standards/ocm";
import { beforeAll, describe, test } from "vitest";
import { fixture } from "./helpers/charging-feed.js";
import { distinct, fuzzJson, json, parseFeed, parseProblems, providerIds } from "./helpers/fuzz.js";

/**
 * Random Open Charge Map POIs through the real format: the captured answer
 * with its POIs changed, reference ids swapped for others the reference data
 * lists and text values for others the API description enumerates. Every
 * record seals, and every POI is a site or counted as skipped.
 */

type Rec = Record<string, unknown>;

const POIS = JSON.parse(fixture("ocm.json").toString("utf8")) as unknown[];

const field = (r: Rec, key: string): Rec =>
  typeof r[key] === "object" && r[key] !== null ? (r[key] as Rec) : {};

/**
 * Whether Open Charge Map publishes a POI: one not live (under review,
 * rejected, delisted) or marked a duplicate of another is withheld.
 */
function published(poi: Rec): boolean {
  const submission = field(poi, "SubmissionStatus");
  const submissionId = poi["SubmissionStatusTypeID"];
  if (submission["IsLive"] === false) return false;
  if (
    submission["IsLive"] === undefined &&
    submissionId != null &&
    !["100", "200"].includes(String(submissionId).trim())
  ) {
    return false;
  }
  return String(field(poi, "StatusType")["ID"] ?? poi["StatusTypeID"] ?? "").trim() !== "210";
}

let enums = new Map<string, string[]>();
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(OCM);
  if ("unavailable" in pinned) {
    unavailable = pinned.unavailable;
    return;
  }
  const file = (name: string) => pinned.files.find((f) => f.fileName === name)!.contents;
  enums = enumsByProperty(jsonSchemaEnums(parseYaml(file("ocm-openapi-spec.yaml"))));
}, 120_000);

describe("Open Charge Map", () => {
  for (const keepTypes of [true, false]) {
    test(
      `POIs, ${keepTypes ? "schema-shaped" : "with values of the wrong type"}`,
      ({ skip }) => {
        if (unavailable) skip(unavailable);
        // Below each POI: the answer stays a list of objects.
        fuzzJson(POIS, { enums, keepTypes, within: (path) => path.length > 1, runs: 150 }, (pois) =>
          parseProblems(parseFeed("ocm-charging", { main: [json(pois)] }), {
            expected: distinct(pois as unknown[], (p: Rec) =>
              typeof p["ID"] === "number" && published(p) ? p["ID"] : undefined,
            ),
            produced: providerIds,
          }),
        );
      },
      fuzzTimeout(5_000),
    );
  }
});
