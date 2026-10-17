import { assertCovered, pinnedJson, pinnedOrUnavailable } from "@openconditions/conformance";
import { DIGITRAFFIC_ROAD } from "@openconditions/conformance/standards/digitraffic-road";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, test } from "vitest";
import { weatherDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/weather-feed.js";

/**
 * The road weather parser held to the enumerations of Digitraffic's own
 * OpenAPI document: every station state, collection status and value
 * reliability it defines is shown handled by running the parser over a
 * capture carrying it.
 */

const FETCHED = "2026-10-14T23:25:19Z";
const feed = () => catalogFeed("fi-digitraffic-weather");
const format = weatherDomain.formats["digitraffic-weather"]!;
const NUPURI = "oc:feature:fi-digitraffic-weather:1001";

interface Schemas {
  components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
}

let api: Schemas | undefined;
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(DIGITRAFFIC_ROAD);
  if ("unavailable" in pinned) unavailable = pinned.unavailable;
  else api = await pinnedJson<Schemas>(DIGITRAFFIC_ROAD, "openapi.json");
}, 60_000);

beforeEach(() => __resetSkips());

const enumOf = (schema: string, property: string): string[] =>
  api!.components.schemas[schema]?.properties[property]?.enum ?? [];

/** The full parse of the capture with Nupuri's list entry changed, and whether it counted a value not read. */
function withStation(change: Record<string, unknown>): { out: ParseOutput; unread: boolean } {
  const list = JSON.parse(fixture("fi-digitraffic-weather-stations.json").toString("utf8")) as {
    features: { properties: Record<string, unknown> }[];
  };
  Object.assign(list.features.find((f) => f.properties["id"] === 1001)!.properties, change);
  const payloads: FeedPayloads = {
    sites: [Buffer.from(JSON.stringify(list))],
    details: [fixture("fi-digitraffic-weather-station-1001.json")],
    status: [fixture("fi-digitraffic-weather-data.json")],
  };
  __resetSkips();
  const out = format.parse(feed(), payloads, parseContext(FETCHED));
  return { out, unread: (drainSkipped(feed().id).unknown_value ?? 0) > 0 };
}

describe("digitraffic-weather against Digitraffic's OpenAPI", () => {
  test("every station state is a device status", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered(
      "WeatherStationPropertiesSimpleV1.state",
      enumOf("WeatherStationPropertiesSimpleV1", "state"),
      {
        handled: (state) => {
          const { out, unread } = withStation({ state });
          return (
            !unread &&
            out.observations.some(
              (o) =>
                o["property"] === "device.status" &&
                (o["subject"] as { featureId: string }).featureId === NUPURI,
            )
          );
        },
      },
    );
  });

  test("every collection status is a lifecycle, or withdraws the station", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered(
      "WeatherStationPropertiesSimpleV1.collectionStatus",
      enumOf("WeatherStationPropertiesSimpleV1", "collectionStatus"),
      {
        handled: (collectionStatus) => {
          const { out, unread } = withStation({ collectionStatus });
          const nupuri = out.features.find((f) => f["id"] === NUPURI);
          return !unread && (nupuri === undefined || nupuri["lifecycle"] !== "unknown");
        },
      },
    );
  });

  test("every value reliability is read, or keeps a faulty value out", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const index = withStation({}).out.statusIndex!;
    assertCovered("SensorValueDtoV1.reliability", enumOf("SensorValueDtoV1", "reliability"), {
      handled: (reliability) => {
        const data = {
          dataUpdatedTime: "2026-10-14T23:24:19Z",
          stations: [
            {
              id: 1001,
              sensorValues: [
                {
                  id: 1,
                  name: "ILMA",
                  measuredTime: "2026-10-14T23:19:55Z",
                  unit: "°C",
                  value: 9.7,
                  reliability,
                },
              ],
            },
          ],
        };
        __resetSkips();
        const out = format.parseStatus!(
          feed(),
          { status: [Buffer.from(JSON.stringify(data))] },
          parseContext(FETCHED),
          index,
        );
        const counted = (drainSkipped(feed().id).unknown_value ?? 0) > 0;
        return !counted && (out.observations.length === 1) !== (reliability === "FAULTY");
      },
    });
  });
});
