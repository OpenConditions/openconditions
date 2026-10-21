import { pinnedOrUnavailable, type SchemaFile, xsdErrors } from "@openconditions/conformance";
import {
  DATEX2_V3,
  MESSAGE_CONTAINER_SCHEMA,
} from "@openconditions/conformance/standards/datex2-v3";
import { DATEX2_RECORDS } from "@openconditions/model-roads";
import { beforeAll, describe, expect, it } from "vitest";
import { datexRecordsOf, situationsToDatex } from "../situation-datex.js";

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
  situation("works-informant-delay-direction", {
    severity: { label: "none", source: "declared" },
    details: {
      kind: "roadworks",
      v: 1,
      scale: "minor",
      durationClass: "short_term",
      urgent: true,
      underTraffic: false,
    },
    provenance: {
      sourceUpdatedAt: "2026-09-06T09:00:00Z",
      informationSource: {
        type: "police_patrol",
        name: [{ lang: "de", text: "Autobahnpolizei" }],
        id: "AP-1",
        country: "DE",
        reliable: false,
      },
    },
    effects: [
      effect("lanes", "lane_restriction", {
        vehicleImpact: "unknown",
        lanesTotal: 3,
        lanesRestricted: 2,
        lanesOperational: 1,
        direction: { value: "both", basis: "text", text: "bothWays" },
      }),
      effect("speed", "speed_limit", {
        limit: { value: 60, unit: "km/h" },
        direction: { value: "unknown", basis: "compass", compass: "NE", text: "northEastBound" },
      }),
      effect("delay", "delay", {
        delayBand: "between_one_hour_and_three_hours",
        delayType: "delays_of_uncertain_duration",
      }),
    ],
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
  situation("planned-approved", {
    validity: { status: "planned", start: "2026-09-06T08:00:00Z" },
    effects: [
      effect("closure", "closure", { scope: "carriageway", actionStatus: "approved" }),
      effect("speed", "speed_limit", {
        limit: { value: 60, unit: "km/h" },
        actionStatus: "being_terminated",
      }),
    ],
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
  let schemas: SchemaFile[] = [];
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DATEX2_V3);
    if ("files" in pinned) schemas = pinned.files;
    else unavailable = pinned.unavailable;
  }, 120_000);

  const validate = (xml: string) =>
    xsdErrors(xml, schemas, MESSAGE_CONTAINER_SCHEMA, "situations.xml");

  it.for<[string, Rec[]]>([
    ["every classification DATEX has a record for", everyNature],
    ["every effect record and location shape", variants],
    [
      "future same-type effect intervals",
      [
        situation("future-closure", {
          kind: "closure",
          type: "closure",
          subtype: "full",
          effects: [
            effect("closure", "closure", {
              scope: "road",
              validity: {
                status: "planned",
                start: "2026-09-07T20:00:00Z",
                end: "2026-09-08T05:00:00Z",
              },
            }),
          ],
        }),
      ],
    ],
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

  it("validates source text carrying characters XML 1.0 cannot represent", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    const dirty = (text: string) => `${text}\u0001\u0008\u000B\u000C\u001F\uD800\uFFFE\uFFFF`;
    const xml = situationsToDatex(
      [
        situation("control-chars", {
          id: dirty("oc:situation:test:control"),
          headline: [{ lang: "de", text: dirty("Bauarbeiten\tA 46\r\n") }],
          location: {
            geometry: { type: "Point", coordinates: [6.81, 51.2] },
            roads: [{ ref: dirty("A46"), name: [{ lang: "de", text: dirty("Autobahn 46") }] }],
          },
          effects: [effect("closure", "closure", { scope: "road", sourceRecordRef: dirty("r1") })],
        }),
      ],
      AT,
      { ...INFO, attribution: dirty("OpenConditions") },
      "de",
    );
    expect(xml).toMatch(/^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u);
    expect(xml).toContain("Bauarbeiten\tA 46\r\n\uFFFD");
    expect(await validate(xml)).toEqual([]);
  }, 60_000);

  it("cuts text past the 1024 characters a DATEX string holds, and says so", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    // Counted in characters: an astral character is one, though two UTF-16 units.
    const long = (c: string) => c.repeat(1025);
    const record = situation("long-text", {
      headline: [{ lang: "de", text: long(String.fromCodePoint(0x1f6a7)) }],
      location: {
        geometry: { type: "Point", coordinates: [6.81, 51.2] },
        roads: [{ ref: long("A"), name: [{ lang: "de", text: long("B") }] }],
      },
      provenance: {
        sourceUpdatedAt: "2026-09-06T09:00:00Z",
        informationSource: { id: long("C"), name: [{ lang: "de", text: long("D") }] },
      },
    });
    const diagnostics: { code: string; path: string }[] = [];
    datexRecordsOf(record, AT, (d) => diagnostics.push(d));
    expect(
      diagnostics.filter((d) => d.code === "field_precision_reduced").map((d) => d.path),
    ).toEqual([
      "/provenance/informationSource/id",
      "/provenance/informationSource/name/0/text",
      "/headline/0/text",
      "/location/roads/0/name/0/text",
      "/location/roads/0/ref",
    ]);
    const xml = situationsToDatex([record], AT, { ...INFO, attribution: long("E") }, "de");
    expect(xml).toContain(`<loc:roadNumber>${"A".repeat(1024)}</loc:roadNumber>`);
    expect(await validate(xml)).toEqual([]);
  }, 60_000);

  it("validates an empty publication with the default country", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(await validate(situationsToDatex([], AT, INFO))).toEqual([]);
  }, 60_000);
});
