import {
  draftProblems,
  enumsByProperty,
  fuzzParameters,
  fuzzTimeout,
  type JsonPath,
  jsonSchemaEnums,
  mutateJson,
  mutations,
  pinnedJson,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { DIGITRAFFIC_ROAD } from "@openconditions/conformance/standards/digitraffic-road";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  skippedRecords,
} from "@openconditions/ingest-framework";
import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vitest";
import { vehiclesDomain } from "../domain.js";
import { MAX_POSITION_AGE_SEC } from "../formats/digitraffic.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/vehicles-feed.js";

const FEED = "fi-digitraffic-maintenance";

const json = (name: string): unknown => JSON.parse(fixture(name).toString("utf8"));
const body = (doc: unknown) => Buffer.from(JSON.stringify(doc));

/**
 * The trackings of a document each parse should account for: one whose last
 * position is older than a position stays current is left out by design.
 */
function trackingsOf(doc: unknown, fetchedAt: string): number {
  const features = (doc as { features?: unknown }).features;
  return (Array.isArray(features) ? features : []).filter((f) => {
    const time = (f as { properties?: { time?: unknown } } | null)?.properties?.time;
    const at = Date.parse(typeof time === "string" ? time : "");
    return !(Date.parse(fetchedAt) - at > MAX_POSITION_AGE_SEC * 1000);
  }).length;
}

/** One parse checked: no throw, every draft seals and is valid data, and no tracking is lost unseen. */
function check(
  input: FeedPayloads,
  fetchedAt: string,
  applied: readonly string[],
  trackings: number,
) {
  __resetSkips();
  const feed = catalogFeed(FEED);
  const out = vehiclesDomain.formats["digitraffic"]!.parse(feed, input, parseContext(fetchedAt));
  const what = JSON.stringify(applied);
  const drafts = [...out.features, ...out.observations, ...out.offers];
  expect(sealFailures(drafts), what).toEqual([]);
  expect(draftProblems(drafts), what).toEqual([]);
  const skipped = skippedRecords(drainSkipped(feed.id));
  expect(out.observations.length, what).toBeLessThanOrEqual(trackings);
  expect(out.observations.length + skipped, what).toBeGreaterThanOrEqual(trackings);
}

const below =
  (...prefix: string[]) =>
  (path: JsonPath) =>
    path.length > prefix.length && prefix.every((step, i) => path[i] === step);

/**
 * Digitraffic's maintenance tracking captures changed at random (fields
 * deleted, tasks swapped for others the road OpenAPI lists, awkward text,
 * numbers and times, trackings duplicated) through the real parser: it never
 * throws, every reading seals, and each current tracking is read or counted.
 */
describe("digitraffic maintenance tracking, mutated within the road OpenAPI's value lists", () => {
  let enums = new Map<string, string[]>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DIGITRAFFIC_ROAD);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else
      enums = enumsByProperty(jsonSchemaEnums(await pinnedJson(DIGITRAFFIC_ROAD, "openapi.json")));
  }, 120_000);

  for (const [name, file] of [
    ["the live capture", "fi-digitraffic-maintenance-latest.json"],
    ["the edge cases", "fi-digitraffic-maintenance-edges.json"],
  ]) {
    test(
      name!,
      ({ skip }) => {
        if (unavailable) skip(unavailable);
        const fetchedAt = "2026-10-14T23:24:56Z";
        const base = json(file!);
        fc.assert(
          fc.property(mutations(), (list) => {
            const { doc, applied } = mutateJson(base, list, { within: below("features"), enums });
            check({ main: [body(doc)] }, fetchedAt, applied, trackingsOf(doc, fetchedAt));
          }),
          fuzzParameters(150),
        );
      },
      fuzzTimeout(5_000),
    );
  }

  test(
    "the routes behind the paired capture",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const PAIRED = "2026-10-15T07:04:51Z";
      const latest = json("fi-digitraffic-maintenance-latest-paired.json");
      const routes = json("fi-digitraffic-maintenance-routes.json");
      const trackings = trackingsOf(latest, PAIRED);
      fc.assert(
        fc.property(mutations(), (list) => {
          const { doc, applied } = mutateJson(routes, list, { within: below("features"), enums });
          check({ main: [body(latest)], routes: [body(doc)] }, PAIRED, applied, trackings);
        }),
        fuzzParameters(150),
      );
    },
    fuzzTimeout(5_000),
  );
});
