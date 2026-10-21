import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fuzzParameters,
  fuzzTimeout,
  mutateXml,
  mutations,
  pinnedOrUnavailable,
  xsdEnumerations,
} from "@openconditions/conformance";
import { DATEX2_V2 } from "@openconditions/conformance/standards/datex2-v2";
import { DATEX2_V3 } from "@openconditions/conformance/standards/datex2-v3";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { eventAccounting, parseFuzzed, quiet, report } from "./helpers/fuzz.js";
import { testFeed } from "./helpers/test-feeds.js";

/**
 * Random DATEX II situation publications: captured v2 and v3 feeds with
 * their situations changed at random. A text that is one value of a DATEX
 * enumeration is swapped for another value of every enumeration it belongs
 * to, in either version, so a record type, cause or impact the parser maps
 * and one it does not are both tried.
 */
const CASES = [
  ["lu-cita-events", "cita-lu/situations.xml"],
  ["es-dgt-events", "dgt-es/situations.xml"],
  ["fr-dir-events", "dir-fr/situations.xml"],
  ["be-flanders-events", "flanders-be/situations.xml"],
  ["hr-hc-events", "hc-hr/events.datex3.xml"],
  ["nl-ndw-events", "ndw/restrictions-v3.xml"],
] as const;

const documents = CASES.map(([feed, path]) => ({
  feed,
  path,
  xml: readFileSync(join(import.meta.dirname, "fixtures", path), "utf8"),
}));

let unavailable: string | undefined;
const enumerations: string[][] = [];

beforeAll(async () => {
  quiet();
  for (const set of [DATEX2_V2, DATEX2_V3]) {
    const pinned = await pinnedOrUnavailable(set);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    enumerations.push(...xsdEnumerations(pinned.files).map((e) => e.values));
  }
}, 120_000);

/** Mutations land inside a situation: the publication around it stays readable. */
const inSituation = (path: string) => /(^|\/)(\w+:)?situation\//.test(path);

/** The situation records of a document, which the parser reads or counts. */
const recordCount = (xml: string) => xml.match(/<(\w+:)?situationRecord[\s>/]/g)?.length ?? 0;

/**
 * The distinct situation records of a document: an element repeating
 * another's id is that record published twice, which the parser reads once.
 */
function distinctRecords(xml: string): number {
  const ids = new Set<string>();
  let anonymous = 0;
  for (const [tag] of xml.matchAll(/<(\w+:)?situationRecord[\s>/][^>]*>/g)) {
    const id = /\sid="([^"]*)"/.exec(tag)?.[1];
    if (id === undefined) anonymous++;
    else ids.add(id);
  }
  return ids.size + anonymous;
}

describe("DATEX II parser over random situation publications", () => {
  it(
    "reads or counts every situation record, and every draft seals",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      fc.assert(
        fc.property(fc.nat(), mutations({ max: 5 }), (pick, list) => {
          const { feed: feedId, path, xml } = documents[pick % documents.length]!;
          const { xml: mutated, applied } = mutateXml(xml, list, {
            within: inSituation,
            enumerations,
          });
          const payload = Buffer.from(mutated);
          // Read as a partial feed: a complete snapshot refuses a bad record whole.
          const feed = testFeed(feedId, { snapshot: undefined });
          let problems: string[];
          try {
            problems = [
              ...parseFuzzed(feed, payload).problems,
              ...eventAccounting(feed, payload, recordCount(mutated), distinctRecords(mutated)),
            ];
          } catch (error) {
            problems = [`threw ${(error as Error).stack}`];
          }
          expect(problems, `${path}\n${report(applied, problems)}`).toEqual([]);
        }),
        fuzzParameters(150),
      );
    },
    fuzzTimeout(20_000),
  );

  it(
    "accounts for every record of a complete snapshot, or refuses it",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      fc.assert(
        fc.property(fc.nat(), mutations({ max: 3 }), (pick, list) => {
          const { feed: feedId, path, xml } = documents[pick % documents.length]!;
          const { xml: mutated, applied } = mutateXml(xml, list, {
            within: inSituation,
            enumerations,
          });
          const feed = testFeed(feedId, { snapshot: { completeness: "complete" } });
          let problems: string[];
          try {
            const { out, problems: found } = parseFuzzed(feed, Buffer.from(mutated));
            problems = found;
            if (out.records?.inputCount !== recordCount(mutated)) {
              problems.push(`${recordCount(mutated)} records, ${out.records?.inputCount} counted`);
            }
          } catch (error) {
            // A snapshot holding a record it cannot account for (no id, an
            // unreadable version or time) is refused whole, by design.
            const refused = /^snapshot (parse error|version conflict)/.test(
              (error as Error).message,
            );
            problems = refused ? [] : [`threw ${(error as Error).stack}`];
          }
          expect(problems, `${path}\n${report(applied, problems)}`).toEqual([]);
        }),
        fuzzParameters(100),
      );
    },
    fuzzTimeout(20_000),
  );
});
