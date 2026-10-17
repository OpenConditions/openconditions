import {
  type JsonValidator,
  jsonSchemaValidator,
  pinnedJson,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { GEOJSON } from "@openconditions/conformance/standards/geojson";
import { beforeAll, describe, expect, test } from "vitest";
import { fixture } from "./helpers/hazards-feed.js";

/**
 * The hazard feeds that publish GeoJSON held to RFC 7946's own schema: the
 * captured answers are valid feature collections, so a parser reads them as
 * GeoJSON and not as one publisher's dialect of it. The NWS alerts are
 * GeoJSON-LD, a GeoJSON collection with an `@context` the schema allows.
 */

let collection: JsonValidator | undefined;
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(GEOJSON);
  if ("unavailable" in pinned) {
    unavailable = pinned.unavailable;
    return;
  }
  collection = jsonSchemaValidator(
    await pinnedJson<Record<string, unknown>>(GEOJSON, "FeatureCollection.json"),
  );
}, 60_000);

describe("captured GeoJSON answers against the RFC 7946 schema", () => {
  test.for([
    "usgs-all-day.geojson",
    "usgs-all-month.geojson",
    "effis-burnt-areas.geojson",
    "hms-smoke.geojson",
    "nifc-incidents.geojson",
    "nifc-perimeters.geojson",
    "nws-alerts-active.json",
    "dwd-areas-coast.json",
    "dwd-areas-lakes.json",
    "meteoalarm-geocodes.json",
  ])("%s is a valid feature collection", (name, { skip }) => {
    if (unavailable) skip(unavailable);
    expect(collection!(JSON.parse(fixture(name).toString("utf8")))).toEqual([]);
  });
});
