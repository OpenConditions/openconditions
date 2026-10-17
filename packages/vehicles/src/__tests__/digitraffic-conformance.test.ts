import { assertCovered, pinnedJson, pinnedOrUnavailable } from "@openconditions/conformance";
import { DIGITRAFFIC_ROAD } from "@openconditions/conformance/standards/digitraffic-road";
import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeAll, describe, expect, test } from "vitest";
import { vehiclesDomain } from "../domain.js";
import { UNREAD_TASKS } from "../formats/digitraffic.js";
import { catalogFeed, parseContext } from "./helpers/vehicles-feed.js";

/**
 * The maintenance tracking parser held to the task codes of Digitraffic's
 * own OpenAPI document: every task it defines is shown read into an activity
 * by running the parser over a tracking carrying it, or is listed with the
 * reason it names none.
 */

const FETCHED = "2026-10-14T23:24:56Z";
const format = vehiclesDomain.formats["digitraffic"]!;
const feed = catalogFeed("fi-digitraffic-maintenance");

interface Schemas {
  components: {
    schemas: Record<string, { properties: Record<string, { items?: { enum?: string[] } }> }>;
  };
}

let tasks: string[] = [];
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(DIGITRAFFIC_ROAD);
  if ("unavailable" in pinned) {
    unavailable = pinned.unavailable;
    return;
  }
  const api = await pinnedJson<Schemas>(DIGITRAFFIC_ROAD, "openapi.json");
  tasks =
    api.components.schemas["MaintenanceTrackingLatestPropertiesV1"]?.properties["tasks"]?.items
      ?.enum ?? [];
}, 60_000);

/** The position a tracking carrying one task reads as, and the skips its parse recorded. */
function readTask(task: string) {
  const body = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [24.94, 60.17, 0] },
        properties: { id: 1, time: "2026-10-14T23:24:00Z", tasks: [task] },
      },
    ],
  };
  __resetSkips();
  const out = format.parse(
    feed,
    { main: [Buffer.from(JSON.stringify(body))] },
    parseContext(FETCHED),
  );
  const reading = out.observations[0]!;
  return {
    value: (reading["result"] as { value: Record<string, unknown> }).value,
    extras: reading["extras"],
    skips: drainSkipped(feed.id),
  };
}

describe("digitraffic maintenance tracking against Digitraffic's OpenAPI", () => {
  test("every task is an activity, or is listed with why it names none", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("MaintenanceTrackingLatestPropertiesV1.tasks", tasks, {
      handled: (task) => readTask(task).value["activity"] !== undefined,
      unsupported: UNREAD_TASKS,
    });
  });

  test("a listed task keeps its code and counts nothing", ({ skip }) => {
    if (unavailable) skip(unavailable);
    for (const task of Object.keys(UNREAD_TASKS)) {
      const { value, extras, skips } = readTask(task);
      expect(value, task).not.toHaveProperty("activity");
      expect(extras, task).toEqual({ tasks: [task] });
      expect(skips, task).toEqual({});
    }
  });
});
