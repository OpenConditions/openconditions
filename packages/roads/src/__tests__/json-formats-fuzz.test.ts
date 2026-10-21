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
import { DIGITRAFFIC_ROAD } from "@openconditions/conformance/standards/digitraffic-road";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { eventAccounting, parseFuzzed, quiet, report } from "./helpers/fuzz.js";
import { testFeed } from "./helpers/test-feeds.js";

/**
 * Random documents of the JSON situation formats: each captured fixture
 * with its records changed at random. Digitraffic's values are swapped
 * among those its OpenAPI document enumerates for the same property; the
 * other formats publish no schema, so their strings are swapped among each
 * other's values and the awkward ones.
 */
interface Case {
  feed: string;
  path: string;
  /** The key of the record list, or none where the document is the list. */
  records?: string;
}

const CASES: Case[] = [
  { feed: "fi-digitraffic-events", path: "digitraffic/messages.json", records: "features" },
  { feed: "fi-digitraffic-events", path: "digitraffic/v2-restrictions.json", records: "features" },
  {
    feed: "fi-digitraffic-events",
    path: "digitraffic/weight-restriction.json",
    records: "features",
  },
  {
    feed: "fi-digitraffic-events",
    path: "digitraffic/exempted-transport.json",
    records: "features",
  },
  { feed: "ca-bc-drivebc-events", path: "drivebc/events.json", records: "events" },
  { feed: "de-autobahn-events", path: "autobahn/warning.json", records: "warning" },
  { feed: "us-oh-ohgo-events", path: "ohgo-oh/incidents.json", records: "results" },
  { feed: "us-oh-ohgo-construction-events", path: "ohgo-oh/construction.json", records: "Results" },
  {
    feed: "au-vic-transportvic-planned-events",
    path: "vic-au/planned.json",
    records: "disruptions",
  },
  {
    feed: "au-vic-transportvic-unplanned-events",
    path: "vic-au/unplanned.json",
    records: "features",
  },
  { feed: "us-ny-511-events", path: "cars-ny/events.json" },
  { feed: "us-ny-511-conditions", path: "cars-ny/conditions.json" },
];

const documents = CASES.map((c) => ({
  ...c,
  doc: JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", c.path), "utf8")) as unknown,
}));

let unavailable: string | undefined;
let enums = new Map<string, string[]>();

beforeAll(async () => {
  quiet();
  const pinned = await pinnedOrUnavailable(DIGITRAFFIC_ROAD);
  if ("unavailable" in pinned) {
    unavailable = pinned.unavailable;
    return;
  }
  enums = enumsByProperty(jsonSchemaEnums(JSON.parse(pinned.files[0]!.contents)));
}, 120_000);

/** Every string of the fixtures, for formats with no schema to take values from. */
const pool = [
  ...new Set(
    documents.flatMap(({ doc }) => {
      const out: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "string" && v.length < 40) out.push(v);
        else if (Array.isArray(v)) for (const x of v) walk(x);
        else if (v !== null && typeof v === "object") for (const x of Object.values(v)) walk(x);
      };
      walk(doc);
      return out;
    }),
  ),
];

const listOf = (doc: unknown, key: string | undefined): unknown[] =>
  ((key === undefined ? doc : (doc as Record<string, unknown>)[key]) as unknown[]) ?? [];

/** The id a record is published under, in any of the formats here. */
function idOf(record: unknown): unknown {
  if (record === null || typeof record !== "object") return undefined;
  const r = record as Record<string, unknown>;
  const p = (r["properties"] ?? {}) as Record<string, unknown>;
  return p["situationId"] ?? p["id"] ?? r["id"] ?? r["identifier"] ?? r["event-id"];
}

/**
 * How many records a list names: two under one id are one record published
 * twice, which the parsers read once.
 */
function distinctOf(list: readonly unknown[]): number {
  const ids = list.map(idOf);
  const named = ids.filter((id) => typeof id === "string" || typeof id === "number");
  return new Set(named.map(String)).size + (ids.length - named.length);
}

/** The formats read as complete snapshots, whose parse accounts for every record. */
const SNAPSHOT_FORMATS = new Set(["digitraffic", "cars"]);

/**
 * A complete snapshot's accounting of a document of `count` records: every
 * one accepted, ended or unplaceable, or the snapshot refused whole because
 * a record has no identity or an unreadable version, as designed.
 */
function snapshotAccounting(feedId: string, payload: Buffer, count: number): string[] {
  const feed = testFeed(feedId, { snapshot: { completeness: "complete" } });
  try {
    const { out, problems } = parseFuzzed(feed, payload);
    return out.records?.inputCount === count
      ? problems
      : [...problems, `${count} records, ${out.records?.inputCount} counted`];
  } catch (error) {
    return /^snapshot (parse error|version conflict|record)/.test((error as Error).message)
      ? []
      : [`complete snapshot threw ${(error as Error).stack}`];
  }
}

describe("JSON situation formats over random documents", () => {
  it(
    "read or count every record, and every draft seals",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      fc.assert(
        fc.property(fc.nat(), mutations({ max: 5 }), (pick, list) => {
          const { feed: feedId, path, records, doc } = documents[pick % documents.length]!;
          // Inside the records only: a broken envelope is an unreadable payload.
          const depth = records === undefined ? 1 : 2;
          const { doc: mutated, applied } = mutateJson(doc, list, {
            within: (p) => p.length >= depth && (records === undefined || p[0] === records),
            enums: feedId === "fi-digitraffic-events" ? enums : undefined,
            pool,
          });
          const payload = Buffer.from(JSON.stringify(mutated));
          const read = listOf(mutated, records);
          const count = read.length;
          const feed = testFeed(feedId, { snapshot: undefined });
          let problems: string[];
          try {
            problems = parseFuzzed(feed, payload).problems;
            // A format that reports snapshots accounts for its records there,
            // ended and withheld ones included, which a partial read leaves out.
            if (!SNAPSHOT_FORMATS.has(feed.format)) {
              problems.push(...eventAccounting(feed, payload, count, distinctOf(read)));
            }
          } catch (error) {
            problems = [`threw ${(error as Error).stack}`];
          }
          if (SNAPSHOT_FORMATS.has(feed.format)) {
            problems.push(...snapshotAccounting(feedId, payload, count));
          }
          expect(problems, `${path}\n${report(applied, problems)}`).toEqual([]);
        }),
        fuzzParameters(300),
      );
    },
    fuzzTimeout(20_000),
  );
});
