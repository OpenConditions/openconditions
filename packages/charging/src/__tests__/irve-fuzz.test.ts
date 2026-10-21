import { fuzzTimeout, pinnedOrUnavailable } from "@openconditions/conformance";
import {
  IRVE_DYNAMIC_SCHEMA,
  IRVE_STATIC_SCHEMA,
  IRVE_V2,
} from "@openconditions/conformance/standards/irve-v2";
import { beforeAll, describe, test } from "vitest";
import { fixture } from "./helpers/charging-feed.js";
import { distinct, evseComponents, fuzzJson, parseFeed, parseProblems } from "./helpers/fuzz.js";
import { csvRecords, type TableSchema } from "./helpers/table-schema.js";

/**
 * Random IRVE consolidations through the real format: the captured static
 * and dynamic tables with their cells changed, rows dropped and repeated,
 * and values swapped for others the table schemas list (an enumeration, or
 * the true and false values of a boolean column). Every record seals, and
 * every charge point row is a charge point or counted as skipped.
 */

type Row = Record<string, unknown>;

const FEED = "fr-irve-charging";

/** Table Schema's default true and false values. */
const BOOLEANS = ["true", "True", "TRUE", "1", "false", "False", "FALSE", "0"];

/** The values each column of a table schema lists, by column name. */
function columnValues(schema: TableSchema): Map<string, string[]> {
  return new Map(
    schema.fields.flatMap((f) => {
      const values =
        f.constraints?.enum?.map(String) ??
        (f.type === "boolean" ? [...(f.trueValues ?? []), ...(f.falseValues ?? [])] : []);
      const list = f.type === "boolean" && values.length === 0 ? BOOLEANS : values;
      return list.length === 0 ? [] : [[f.name, list] as const];
    }),
  );
}

let staticEnums = new Map<string, string[]>();
let dynamicEnums = new Map<string, string[]>();
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(IRVE_V2);
  if ("unavailable" in pinned) {
    unavailable = pinned.unavailable;
    return;
  }
  const schema = (name: string) =>
    JSON.parse(pinned.files.find((f) => f.fileName === name)!.contents) as TableSchema;
  staticEnums = columnValues(schema(IRVE_STATIC_SCHEMA));
  dynamicEnums = columnValues(schema(IRVE_DYNAMIC_SCHEMA));
}, 120_000);

function table(name: string): { header: string[]; rows: Row[] } {
  const [header = [], ...rows] = csvRecords(fixture(name).toString("utf8"));
  return {
    header,
    rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))),
  };
}

const quote = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

/** Rows as a CSV body; a cell that is no text is written as JavaScript writes it. */
const csv = (header: readonly string[], rows: readonly unknown[]) =>
  Buffer.from(
    `${[
      header,
      ...rows.map((r) =>
        header.map((h) => (typeof r === "object" && r !== null ? String((r as Row)[h] ?? "") : "")),
      ),
    ]
      .map((cells) => cells.map(quote).join(","))
      .join("\n")}\n`,
  );

const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

describe("IRVE", () => {
  const STATIC = table("irve-static.csv");
  const DYNAMIC = table("irve-dynamic.csv");
  const cells = (path: readonly (string | number)[]) => path.length === 2;

  test(
    "the static consolidation",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const status = [fixture("irve-dynamic.csv")];
      fuzzJson(STATIC.rows, { within: cells, enums: staticEnums, runs: 200 }, (rows) =>
        parseProblems(parseFeed(FEED, { main: [csv(STATIC.header, rows as unknown[])], status }), {
          expected: distinct(
            rows as unknown[],
            (r) => text(r["id_pdc_itinerance"]) ?? text(r["id_pdc_local"]),
          ),
          produced: evseComponents,
        }),
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "the dynamic consolidation",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const main = [fixture("irve-static.csv")];
      fuzzJson(DYNAMIC.rows, { within: cells, enums: dynamicEnums, runs: 100 }, (rows) =>
        parseProblems(parseFeed(FEED, { main, status: [csv(DYNAMIC.header, rows as unknown[])] })),
      );
    },
    fuzzTimeout(5_000),
  );
});
