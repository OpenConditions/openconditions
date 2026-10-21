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
import { weatherDomain } from "../domain.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/weather-feed.js";

const FETCHED = "2026-10-14T23:25:19Z";
const FEED = "fi-digitraffic-weather";

const json = (name: string): unknown => JSON.parse(fixture(name).toString("utf8"));
const body = (doc: unknown) => Buffer.from(JSON.stringify(doc));

const CAPTURE = {
  sites: "fi-digitraffic-weather-stations.json",
  details: [
    "fi-digitraffic-weather-station-1001.json",
    "fi-digitraffic-weather-station-1030.json",
    "fi-digitraffic-weather-station-1071.json",
    "fi-digitraffic-weather-station-1174.json",
    "fi-digitraffic-weather-station-7037.json",
  ],
  status: "fi-digitraffic-weather-data.json",
};

/** The capture's payloads, with one role's documents replaced. */
function payloads(role: keyof typeof CAPTURE, docs: unknown[]): FeedPayloads {
  const captured: FeedPayloads = {
    sites: [fixture(CAPTURE.sites)],
    details: CAPTURE.details.map(fixture),
    status: [fixture(CAPTURE.status)],
  };
  return { ...captured, [role]: docs.map(body) };
}

const idOf = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : undefined;

/**
 * The stations of a list each parse should account for: a permanently
 * removed one is left out by design, and one listed twice is one station.
 */
function stationsOf(list: unknown): number {
  const features = (list as { features?: unknown }).features;
  const ids = (Array.isArray(features) ? features : []).flatMap((f) => {
    const props = (f as { properties?: Record<string, unknown> } | null)?.properties;
    if (typeof props !== "object" || props === null) return [undefined];
    const status = props["collectionStatus"];
    return typeof status === "string" && status.trim() === "REMOVED_PERMANENTLY"
      ? []
      : [idOf(props["id"])];
  });
  return new Set(ids.filter((id) => id !== undefined)).size + ids.filter((id) => !id).length;
}

/** One parse checked: no throw, every draft seals and is valid data, and no station is lost unseen. */
function check(input: FeedPayloads, applied: readonly string[], stations?: number) {
  __resetSkips();
  const feed = catalogFeed(FEED);
  const out = weatherDomain.formats["digitraffic-weather"]!.parse(
    feed,
    input,
    parseContext(FETCHED),
  );
  const what = JSON.stringify(applied);
  const drafts = [...out.features, ...out.observations, ...out.offers];
  expect(sealFailures(drafts), what).toEqual([]);
  expect(draftProblems(drafts), what).toEqual([]);
  const skipped = skippedRecords(drainSkipped(feed.id));
  if (stations !== undefined) {
    const written = new Set(out.features.map((f) => f["id"])).size;
    expect(written, what).toBeLessThanOrEqual(stations);
    expect(written + skipped + (out.rejected ?? 0), what).toBeGreaterThanOrEqual(stations);
  }
}

const below =
  (...prefix: string[]) =>
  (path: JsonPath) =>
    path.length > prefix.length && prefix.every((step, i) => path[i] === step);

/**
 * Digitraffic's road weather capture changed at random (fields deleted,
 * values swapped for others of the road OpenAPI's value lists, awkward
 * text, numbers and times, entries duplicated) through the real parser: it
 * never throws, every draft seals, and every listed station is written or
 * counted.
 */
describe("digitraffic-weather, mutated within the road OpenAPI's value lists", () => {
  let enums = new Map<string, string[]>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DIGITRAFFIC_ROAD);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else
      enums = enumsByProperty(jsonSchemaEnums(await pinnedJson(DIGITRAFFIC_ROAD, "openapi.json")));
  }, 120_000);

  test(
    "the station list",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const base = json(CAPTURE.sites);
      fc.assert(
        fc.property(mutations(), (list) => {
          const { doc, applied } = mutateJson(base, list, { within: below("features"), enums });
          check(payloads("sites", [doc]), applied, stationsOf(doc));
        }),
        fuzzParameters(120),
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "the details and the values",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const stations = stationsOf(json(CAPTURE.sites));
      const details = CAPTURE.details.map(json);
      const data = json(CAPTURE.status);
      fc.assert(
        fc.property(mutations(), fc.nat(details.length - 1), (list, which) => {
          const { doc, applied } = mutateJson(details[which], list, {
            within: (p) => p.length > 0,
            enums,
          });
          check(
            payloads(
              "details",
              details.map((d, i) => (i === which ? doc : d)),
            ),
            applied,
            stations,
          );
        }),
        fuzzParameters(100),
      );
      fc.assert(
        fc.property(mutations(), (list) => {
          const { doc, applied } = mutateJson(data, list, { within: below("stations"), enums });
          check(payloads("status", [doc]), applied, stations);
        }),
        fuzzParameters(100),
      );
    },
    fuzzTimeout(5_000),
  );
});
