import {
  assertCovered,
  definitionEnum,
  jsonSchemaEnums,
  pinnedJson,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { DIGITRAFFIC_ROAD } from "@openconditions/conformance/standards/digitraffic-road";
import { __resetSkips, drainSkipped, type ParseOutput } from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FEED = "fi-digitraffic-cameras";
const FETCHED = "2026-10-08T07:16:00Z";

/**
 * The captured Inkoo station (C01503) with its list entry and details
 * changed by `edit`, parsed with the data document; its skips are drained.
 */
function parse(
  edit: (station: Record<string, unknown>, details: Record<string, unknown>) => void,
): { out: ParseOutput; unknown: number } {
  const sites = JSON.parse(fixture("fi-digitraffic-stations.json").toString("utf8"));
  const details = JSON.parse(fixture("fi-digitraffic-station-C01503.json").toString("utf8"));
  sites.features = sites.features.slice(0, 1);
  edit(sites.features[0].properties, details.properties);
  const out = camerasDomain.formats["digitraffic"]!.parse(
    catalogFeed(FEED),
    {
      sites: [Buffer.from(JSON.stringify(sites))],
      details: [Buffer.from(JSON.stringify(details))],
      status: [fixture("fi-digitraffic-data.json")],
    },
    parseContext(FETCHED, 600),
  );
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  return { out, unknown: drainSkipped(FEED)["unknown_value"] ?? 0 };
}

const statusOf = (out: ParseOutput, preset: string) =>
  (
    out.observations.find(
      (o) => (o["subject"] as { componentKey: string }).componentKey === preset,
    )?.["result"] as { value: { status: string } } | undefined
  )?.value.status;

/**
 * The weather camera parser held to Fintraffic's published Digitraffic road
 * OpenAPI: every value its weather camera schemas enumerate is read, shown
 * by running the parser over the captured station carrying it, or listed as
 * unsupported with the reason.
 */
describe("Digitraffic weather cameras against the road OpenAPI", () => {
  let api: unknown;
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DIGITRAFFIC_ROAD);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else api = await pinnedJson(DIGITRAFFIC_ROAD, "openapi.json");
  }, 60_000);

  beforeEach(() => __resetSkips());

  /** An inline enumeration of a property of a named schema. */
  const propertyEnum = (schema: string, property: string): string[] => {
    const values = jsonSchemaEnums(api).get(
      `#/components/schemas/${schema}/properties/${property}`,
    );
    if (values === undefined) throw new Error(`no enumeration ${schema}.${property}`);
    return values;
  };

  test("preset directions: along the road a direction, crossing roads and special views none", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    assertCovered(
      "WeathercamPresetDirectionV1",
      definitionEnum(api, "WeathercamPresetDirectionV1"),
      {
        handled: (v) => {
          const { out, unknown } = parse((_, details) => {
            (details["presets"] as Record<string, unknown>[])[0]!["direction"] = v;
          });
          const view = (
            out.features[0]?.["components"] as { details: Record<string, unknown> }[] | undefined
          )?.[0];
          const along = v === "INCREASING_DIRECTION" || v === "DECREASING_DIRECTION";
          return unknown === 0 && (view?.details["direction"] !== undefined) === along;
        },
      },
    );
  });

  test("station states: a confirmed fault or a pending repair is offline, the rest read by image time", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    const offline = new Set([
      "FAULT_CONFIRMED",
      "FAULT_CONFIRMED_NOT_FIXED_IN_NEAR_FUTURE",
      "REPAIR_REQUEST_POSTED",
    ]);
    for (const schema of [
      "WeathercamStationPropertiesSimpleV1",
      "WeathercamStationPropertiesDetailedV1",
    ]) {
      assertCovered(`${schema}.state`, propertyEnum(schema, "state"), {
        handled: (v) => {
          const { out, unknown } = parse((station) => {
            station["state"] = v;
          });
          return unknown === 0 && (statusOf(out, "C0150301") === "offline") === offline.has(v);
        },
      });
    }
  });

  test("collection statuses: gathering reads online, a removal offline", ({ skip }) => {
    if (unavailable) skip(unavailable);
    for (const schema of [
      "WeathercamStationPropertiesSimpleV1",
      "WeathercamStationPropertiesDetailedV1",
    ]) {
      assertCovered(`${schema}.collectionStatus`, propertyEnum(schema, "collectionStatus"), {
        handled: (v) => {
          const { out, unknown } = parse((station) => {
            station["collectionStatus"] = v;
          });
          const expected = v === "GATHERING" ? "online" : "offline";
          return unknown === 0 && statusOf(out, "C0150301") === expected;
        },
      });
    }
  });

  test("camera makes are not read", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const makes = propertyEnum("WeathercamStationPropertiesDetailedV1", "cameraType");
    assertCovered("WeathercamStationPropertiesDetailedV1.cameraType", makes, {
      handled: [],
      unsupported: Object.fromEntries(
        makes.map((v) => [
          v,
          "the camera's make or protocol; the camera model has no field for it",
        ]),
      ),
    });
  });
});
