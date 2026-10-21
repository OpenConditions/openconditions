import {
  draftProblems,
  fuzzParameters,
  fuzzTimeout,
  mutateJson,
  mutations,
} from "@openconditions/conformance";
import {
  __resetSkips,
  type CatalogFeed,
  drainSkipped,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { borderDomain } from "../domain.js";
import { cbpFeed, cbsaFeed, fixture, parseContext } from "./helpers/border-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * The border formats over mutated copies of their captured fixtures: the
 * parser must not throw, and every draft must seal and be valid data. A
 * port's waits are read per lane and its place from the crossing table, so
 * the readings of a port are not counted against its record here; the
 * parsers' own tests hold that.
 */

function parsed(feed: CatalogFeed, body: string, fetchedAt: string, applied: readonly string[]) {
  const what = JSON.stringify(applied);
  __resetSkips();
  let out: ParseOutput;
  try {
    out = borderDomain.formats[feed.format]!.parse(
      feed,
      { main: [Buffer.from(body)] },
      parseContext(fetchedAt),
    );
  } catch (error) {
    throw new Error(`threw after ${what}: ${(error as Error).stack}`);
  }
  const drafts = [...out.features, ...out.observations, ...out.offers];
  expect(sealFailures(drafts), what).toEqual([]);
  expect(draftProblems(drafts), what).toEqual([]);
  drainSkipped(feed.id);
}

describe("border formats over mutated fixtures", () => {
  it(
    "CBP's wait times",
    () => {
      const base = JSON.parse(fixture("cbp-bwtnew.json").toString("utf8")) as unknown;
      fc.assert(
        fc.property(mutations(), (list) => {
          const { doc, applied } = mutateJson(base, list, { within: (path) => path.length >= 1 });
          parsed(cbpFeed(), JSON.stringify(doc), "2026-10-14T23:38:05Z", applied);
        }),
        fuzzParameters(150),
      );
    },
    fuzzTimeout(3_000),
  );

  it(
    "CBSA's wait times, its table's cells mutated",
    () => {
      const text = fixture("cbsa-bwt-eng.csv").toString("utf8");
      const [header, ...rows] = text.split(/\r?\n/);
      const table = rows.filter((r) => r.trim() !== "").map((r) => r.split(";;"));
      fc.assert(
        fc.property(mutations({ keepTypes: true }), (list) => {
          const { doc, applied } = mutateJson(table, list);
          // A cell's text cannot hold the table's own separators.
          const body = [
            header,
            ...(doc as string[][]).map((cells) =>
              cells.map((c) => String(c).replace(/[\r\n;]/g, " ")).join(";;"),
            ),
          ].join("\n");
          parsed(cbsaFeed(), body, "2026-10-14T23:38:07Z", applied);
        }),
        fuzzParameters(150),
      );
    },
    fuzzTimeout(3_000),
  );
});
