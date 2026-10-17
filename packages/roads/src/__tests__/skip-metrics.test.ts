import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, it } from "vitest";
import { parseAutobahn } from "../autobahn.js";
import { parseDigitraffic } from "../digitraffic.js";
import { parseOpen511 } from "../open511.js";
import type { SourceDescriptor } from "../types.js";
import { parseWzdx } from "../wzdx.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const src = (id: string): SourceDescriptor => ({
  id,
  attribution: "t",
  country: "XX",
  license: "CC0-1.0",
});

/**
 * Every parser that drops a record for want of coordinates must report it per
 * source. An absent count has to mean "this feed loses nothing", not "nobody
 * measured this feed" — the whole point of the metric is that a silently
 * shrinking feed looks identical to a healthy one.
 */
describe("no-geometry skips are reported by every parser that drops records", () => {
  beforeEach(() => __resetSkips());

  it("autobahn", () => {
    parseAutobahn(readFileSync(join(FIXTURES, "autobahn/warning.json")), src("de-autobahn-events"));
    expect(drainSkipped("de-autobahn-events").no_geometry ?? 0).toBeGreaterThan(0);
  });

  it("digitraffic", () => {
    parseDigitraffic(readFileSync(join(FIXTURES, "digitraffic/messages.json")), src("fi-dt"));
    expect(drainSkipped("fi-dt").no_geometry ?? 0).toBeGreaterThan(0);
  });

  it("wzdx", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "no-geo",
          type: "Feature",
          properties: { core_details: { event_type: "work-zone" } },
          geometry: null,
        },
      ],
    };
    parseWzdx(JSON.stringify(feed), src("us-wzdx-events"));
    expect(drainSkipped("us-wzdx-events").no_geometry ?? 0).toBe(1);
  });

  it("open511", () => {
    const feed = { events: [{ id: "no-geo", status: "ACTIVE", headline: "x" }] };
    parseOpen511(JSON.stringify(feed), src("ca-bc-drivebc-events"));
    expect(drainSkipped("ca-bc-drivebc-events").no_geometry ?? 0).toBe(1);
  });

  it("keeps every source's count separate", () => {
    parseWzdx(
      JSON.stringify({
        type: "FeatureCollection",
        features: [{ id: "a", type: "Feature", properties: {}, geometry: null }],
      }),
      src("feed-a"),
    );
    expect(drainSkipped("feed-b").no_geometry ?? 0).toBe(0);
    expect(drainSkipped("feed-a").no_geometry ?? 0).toBe(1);
  });
});
