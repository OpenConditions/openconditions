import { fuzzTimeout, pinnedOrUnavailable, xsdEnumerations } from "@openconditions/conformance";
import { DATEX2_V3 } from "@openconditions/conformance/standards/datex2-v3";
import { beforeAll, describe, test } from "vitest";
import { datexFixture } from "./helpers/charging-feed.js";
import { fuzzXml, parseFeed, parseProblems } from "./helpers/fuzz.js";

/**
 * Random DATEX II v3 energy infrastructure publications through the real
 * format: the captured tables and status with elements deleted and repeated,
 * enumerated values swapped for others of the same DATEX enumeration, and
 * texts, numbers, times and language tags made awkward. Every record seals.
 */

let enumerations: string[][] = [];
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(DATEX2_V3);
  if ("unavailable" in pinned) unavailable = pinned.unavailable;
  else enumerations = xsdEnumerations(pinned.files).map((e) => e.values);
}, 120_000);

/** Below the publication's table: the payload root and its type stay readable. */
const inTable = (path: string) => path.split("/").length > 2;

describe("DATEX II v3 energy infrastructure", () => {
  for (const [label, feed, name] of [
    ["the DGT table (energy infrastructure namespace)", "es-dgt-charging", "es-dgt-energy.xml"],
    ["the Slovenian table (AFIR profile)", "si-nap-charging", "si-nap-energy.xml"],
  ] as const) {
    test(
      label,
      ({ skip }) => {
        if (unavailable) skip(unavailable);
        fuzzXml(
          datexFixture(name).toString("utf8"),
          { enumerations, within: inTable, runs: 100 },
          (xml) => parseProblems(parseFeed(feed, { main: [Buffer.from(xml)] })),
        );
      },
      fuzzTimeout(10_000),
    );
  }

  test(
    "a status publication",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const main = [datexFixture("si-nap-energy.xml")];
      fuzzXml(
        datexFixture("lt-energy-status.xml").toString("utf8"),
        { enumerations, within: inTable, runs: 100 },
        (xml) => parseProblems(parseFeed("es-dgt-charging", { main, status: [Buffer.from(xml)] })),
      );
    },
    fuzzTimeout(10_000),
  );
});
