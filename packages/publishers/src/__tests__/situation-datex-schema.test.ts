import { DATEX2_RECORDS } from "@openconditions/model-roads";
import { beforeAll, describe, expect, it } from "vitest";
import { validateXML } from "xmllint-wasm";
import { situationsToDatex } from "../situation-datex.js";
import { datexSchemas, ROOT_SCHEMA } from "./helpers/datex-schemas.js";

type Rec = Record<string, unknown>;

const AT = new Date("2026-09-06T10:00:00Z");
const INFO = { timestamp: "2026-09-06T10:00:00Z", attribution: "OpenConditions" };

const effect = (id: string, kind: string, fields: Rec = {}): Rec => ({
  id,
  kind,
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  ...fields,
});

const ROAD = { ref: "A46", name: [{ lang: "de", text: "Autobahn 46" }] };

function situation(id: string, over: Rec = {}): Rec {
  return {
    id: `oc:situation:test:${id}`,
    revision: 2,
    class: "situation",
    kind: "roadworks",
    type: "works",
    temporality: "live",
    certainty: "observed",
    severity: { label: "major", source: "derived" },
    headline: [{ lang: "de", text: "Bauarbeiten A 46" }],
    validity: { status: "active", start: "2026-09-06T08:00:00Z", end: "2026-09-07T08:00:00Z" },
    effects: [],
    location: { geometry: { type: "Point", coordinates: [6.81, 51.2] }, roads: [ROAD] },
    provenance: { sourceUpdatedAt: "2026-09-06T09:00:00Z" },
    freshness: { fetchedAt: "2026-09-06T09:30:00Z" },
    ...over,
  };
}

/** One situation per classification DATEX has a record for. */
const everyNature = Object.entries(DATEX2_RECORDS)
  .filter(([, code]) => code)
  .map(([key]) => {
    const [kind, type, subtype] = key.split(".");
    return situation(key, { kind, type, subtype });
  });

/** Every effect record, location shape and optional field the emitter writes. */
const variants = [
  situation("lanes-and-speed", {
    certainty: "likely",
    severity: { label: "critical", source: "derived" },
    headline: [
      { lang: "de", text: "Bauarbeiten A 46" },
      { lang: "en", text: "Roadworks A 46" },
    ],
    effects: [
      effect("lanes", "lane_restriction", {
        vehicleImpact: "some_lanes_closed",
        lanesTotal: 3,
        lanesClosed: 1,
        sourceRecordRef: "NLRWS_a46_2",
      }),
      effect("speed", "speed_limit", { limit: { value: 60, unit: "km/h" } }),
      effect("delay", "delay", { delay: { value: 900, unit: "s" } }),
    ],
  }),
  situation("closure", {
    kind: "closure",
    type: "closure",
    subtype: "full",
    effects: [effect("closure", "closure", { scope: "road" })],
  }),
  situation("carriageway", {
    kind: "closure",
    type: "closure",
    subtype: "carriageway",
    effects: [effect("closure", "closure", { scope: "carriageway" })],
  }),
  situation("all-lanes", {
    effects: [effect("lanes", "lane_restriction", { vehicleImpact: "all_lanes_closed" })],
  }),
  situation("contraflow-detour", {
    effects: [effect("contraflow", "contraflow"), effect("detour", "detour")],
  }),
  situation("no-nature-record", {
    kind: "road_hazard",
    type: "hazard",
    subtype: undefined,
    certainty: "possible",
    severity: undefined,
    effects: [effect("closure", "closure", { scope: "road" })],
  }),
  situation("own-place", {
    effects: [
      effect("speed", "speed_limit", {
        limit: { value: 80, unit: "km/h" },
        location: {
          geometry: { type: "Point", coordinates: [6.9, 51.3] },
          extent: "point",
          geometryOrigin: "source",
        },
      }),
    ],
  }),
  situation("suspended-open-ended", {
    certainty: "unlikely",
    headline: undefined,
    validity: { status: "suspended", start: "2026-09-06T08:00:00Z" },
  }),
  situation("no-start", {
    certainty: "unknown",
    validity: { status: "active" },
    effects: [effect("closure", "closure", { scope: "road", compliance: "unknown" })],
  }),
  situation("signal-fault", { kind: "equipment_fault", type: "fault", subtype: "traffic_signal" }),
  situation("line", {
    location: {
      geometry: {
        type: "LineString",
        coordinates: [
          [6.81, 51.2],
          [6.83, 51.21],
        ],
      },
      roads: [{ ref: "A46" }],
    },
  }),
  situation("polygon", {
    location: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [6.81, 51.2],
            [6.83, 51.2],
            [6.83, 51.21],
            [6.81, 51.2],
          ],
        ],
      },
      roads: [{ name: [{ lang: "de", text: "Hauptstraße" }] }, ROAD],
    },
  }),
  situation("collection", {
    location: {
      geometry: {
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [6.81, 51.2] }],
      },
    },
  }),
];

describe("situationsToDatex against the DATEX II v3 schemas", () => {
  let schemas: Awaited<ReturnType<typeof datexSchemas>> | undefined;
  let unavailable: string | undefined;

  beforeAll(async () => {
    try {
      schemas = await datexSchemas();
    } catch (error) {
      // CI always runs this check; only an offline local run may go without it.
      if (process.env["CI"]) throw error;
      unavailable = `DATEX II schemas unavailable (${(error as Error).message}); run once online to cache them`;
    }
  }, 120_000);

  async function validate(xml: string) {
    const all = schemas ?? [];
    const result = await validateXML({
      xml: [{ fileName: "situations.xml", contents: xml }],
      schema: all.filter((s) => s.fileName === ROOT_SCHEMA),
      preload: all.filter((s) => s.fileName !== ROOT_SCHEMA),
      maxMemoryPages: 4096,
    });
    return result.errors.map((e) => e.rawMessage);
  }

  it.for<[string, Rec[]]>([
    ["every classification DATEX has a record for", everyNature],
    ["every effect record and location shape", variants],
    [
      "separate same-type management records",
      [
        situation("repeated", {
          kind: "closure",
          type: "closure",
          subtype: "lane",
          effects: [
            effect("a", "lane_restriction", {
              vehicleImpact: "some_lanes_closed",
              lanesTotal: 3,
              lanesClosed: 1,
            }),
            effect("b", "lane_restriction", {
              vehicleImpact: "some_lanes_closed",
              lanesClosed: 2,
              compliance: "advisory",
              validity: { status: "active", start: "2026-09-06T09:00:00Z" },
            }),
          ],
        }),
      ],
    ],
  ])("validates %s", { timeout: 60_000 }, async ([, situations], { skip }) => {
    if (unavailable) skip(unavailable);
    const xml = situationsToDatex(situations, AT, INFO, "de");
    expect(xml).toContain("<sit:situationRecord");
    expect(await validate(xml)).toEqual([]);
  });

  it("validates an empty publication with the default country", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(await validate(situationsToDatex([], AT, INFO))).toEqual([]);
  }, 60_000);
});
