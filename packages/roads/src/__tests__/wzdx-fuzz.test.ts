import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  enumsByProperty,
  fuzzParameters,
  fuzzTimeout,
  jsonSchemaEnums,
  mutateJson,
  mutations,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import {
  WZDX_EXAMPLES,
  WZDX_V31,
  WZDX_V40,
  WZDX_V41,
  WZDX_V42,
} from "@openconditions/conformance/standards/wzdx";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { eventAccounting, parseFuzzed, quiet, report } from "./helpers/fuzz.js";
import { testFeed } from "./helpers/test-feeds.js";

/**
 * Random WZDx feeds: the captured fixtures and the standard's own examples,
 * their road events changed at random. Every enumerated value is swapped
 * among the values its property takes in any WZDx version's schema, so a
 * value one version has and another lacks is tried in both.
 */
const FEED = testFeed("us-wzdx-events");
const FIXTURES = join(import.meta.dirname, "fixtures/wzdx");

let unavailable: string | undefined;
const documents: { name: string; doc: { features: unknown[] } }[] = [];
let enums = new Map<string, string[]>();

beforeAll(async () => {
  quiet();
  for (const name of ["feed.json", "modot-v41.json", "quebec-v31.json", "cwz-pbs.json"]) {
    documents.push({ name, doc: JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) });
  }
  const all = new Map<string, string[]>();
  for (const set of [WZDX_V31, WZDX_V40, WZDX_V41, WZDX_V42, ...Object.values(WZDX_EXAMPLES)]) {
    const pinned = await pinnedOrUnavailable(set);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    for (const file of pinned.files) {
      const json = JSON.parse(file.contents) as Record<string, unknown>;
      if (Array.isArray(json["features"])) {
        documents.push({ name: file.fileName, doc: json as { features: unknown[] } });
      } else {
        for (const [pointer, values] of jsonSchemaEnums(json)) {
          all.set(`${file.fileName}${pointer}`, values);
        }
      }
    }
  }
  enums = enumsByProperty(all);
}, 120_000);

describe("WZDx parser over random feeds", () => {
  it(
    "reads or counts every road event, and every draft seals",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      fc.assert(
        fc.property(fc.nat(), mutations({ max: 5 }), (pick, list) => {
          const { name, doc } = documents[pick % documents.length]!;
          const { doc: mutated, applied } = mutateJson(doc, list, {
            within: (path) => path[0] === "features" && path.length >= 2,
            enums,
          });
          const payload = Buffer.from(JSON.stringify(mutated));
          const records = (mutated as { features: unknown[] }).features.length;
          let problems: string[];
          try {
            problems = [
              ...parseFuzzed(FEED, payload).problems,
              ...eventAccounting(FEED, payload, records),
            ];
          } catch (error) {
            problems = [`threw ${(error as Error).stack}`];
          }
          expect(problems, `${name}\n${report(applied, problems)}`).toEqual([]);
        }),
        fuzzParameters(250),
      );
    },
    fuzzTimeout(15_000),
  );
});
