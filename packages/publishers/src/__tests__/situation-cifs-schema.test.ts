import { pinnedOrUnavailable, type SchemaFile, xsdErrors } from "@openconditions/conformance";
import { CIFS_SCHEMA, CIFS_V2 } from "@openconditions/conformance/standards/cifs-v2";
import { CIFS_INCIDENTS } from "@openconditions/model-roads";
import { beforeAll, describe, expect, it } from "vitest";
import { situationsToCifsXml } from "../situation-cifs.js";

type Rec = Record<string, unknown>;

const AT = new Date("2026-09-06T10:00:00Z");
const INFO = { timestamp: "2026-09-06T10:00:00Z" };

const LINE = {
  type: "LineString",
  coordinates: [
    [9.18, 48.78],
    [9.19, 48.79],
  ],
};

const ROAD = { name: [{ lang: "de", text: "B10 Stuttgart" }] };

const effect = (id: string, kind: string, fields: Rec = {}): Rec => ({
  id,
  kind,
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  ...fields,
});

function situation(id: string, over: Rec = {}): Rec {
  return {
    id: `oc:situation:test:${id}`,
    class: "situation",
    kind: "roadworks",
    type: "works",
    temporality: "live",
    certainty: "observed",
    severity: { label: "moderate", source: "derived" },
    description: [{ lang: "en", text: "Disruption on B10" }],
    validity: { status: "active", start: "2026-09-06T08:00:00Z", end: "2026-09-07T08:00:00Z" },
    effects: [],
    location: {
      geometry: LINE,
      roads: [ROAD],
      direction: { value: "positive", basis: "geometry" },
    },
    provenance: { sourceUpdatedAt: "2026-09-06T09:00:00Z" },
    freshness: { fetchedAt: "2026-09-06T09:30:00Z" },
    ...over,
  };
}

const everyMappedNature = Object.entries(CIFS_INCIDENTS)
  .filter(([, code]) => code !== null)
  .map(([key]) => {
    const [kind, type, subtype] = key.split(".");
    return situation(key, { kind, type, ...(subtype ? { subtype } : {}) });
  });

const variants: Rec[] = [
  situation("road-closed-construction", {
    kind: "roadworks",
    type: "works",
    subtype: "construction",
    effects: [effect("c1", "closure", { scope: "road" })],
  }),
  situation("road-closed-event", {
    kind: "public_event",
    type: "event",
    effects: [effect("c1", "closure", { scope: "road" })],
  }),
  situation("road-closed-hazard", {
    kind: "road_hazard",
    type: "hazard",
    effects: [effect("c1", "closure", { scope: "road" })],
  }),
  situation("road-closed-plain", {
    kind: "closure",
    type: "closure",
    subtype: "full",
    effects: [effect("c1", "closure", { scope: "road" })],
  }),
  situation("lanes-and-source-and-schedule", {
    provenance: {
      sourceUpdatedAt: "2026-09-06T09:00:00Z",
      informationSource: {
        id: "mobidata-bw",
        name: [{ lang: "de", text: "MobiData BW" }],
      },
    },
    validity: {
      status: "active",
      start: "2026-09-01T00:00:00+02:00",
      end: "2026-09-30T23:59:00+02:00",
      periods: [
        {
          repeatFrequency: "P1W",
          byDay: ["MO", "TH", "FR"],
          startTime: "09:00",
          duration: "PT2H",
          scheduleTimezone: "Europe/Berlin",
        },
        {
          repeatFrequency: "P1W",
          byDay: ["SU"],
          startTime: "10:00",
          duration: "PT4H",
          scheduleTimezone: "Europe/Berlin",
        },
      ],
    },
    effects: [
      effect("l1", "lane_restriction", {
        vehicleImpact: "some_lanes_closed",
        lanes: [
          { index: 1, status: "closed" },
          { index: 2, status: "open" },
        ],
      }),
    ],
  }),
  situation("everyday-schedule", {
    validity: {
      status: "active",
      start: "2026-09-01T00:00:00+02:00",
      end: "2026-09-30T23:59:00+02:00",
      periods: [
        {
          repeatFrequency: "P1D",
          startTime: "07:00",
          duration: "PT3H",
          scheduleTimezone: "Europe/Berlin",
        },
      ],
    },
  }),
  situation("bilateral-point-accident", {
    kind: "incident",
    type: "accident",
    severity: { label: "critical", source: "derived" },
    location: {
      geometry: { type: "Point", coordinates: [9.18, 48.78] },
      roads: [ROAD],
      direction: { value: "both", basis: "text", text: "BOTH_DIRECTIONS" },
    },
  }),
  situation("control-chars-and-clamped-times", {
    description: [{ lang: "en", text: "Bad\u0000control\u0007chars" }],
    location: {
      geometry: LINE,
      roads: [{ name: [{ lang: "en", text: "A\u000010" }] }],
    },
    validity: {
      status: "active",
      start: "0000-01-01T00:00:00Z",
      end: "9999-12-31T23:59:59-05:00",
    },
  }),
];

describe("CIFS v2 XML schema conformance", () => {
  let schemas: SchemaFile[] = [];
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(CIFS_V2);
    if ("files" in pinned) schemas = pinned.files;
    else unavailable = pinned.unavailable;
  }, 60_000);

  it("validates every mapped classification and variant against cifsv2.xsd", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    const xml = situationsToCifsXml([...everyMappedNature, ...variants], AT, INFO);
    expect(xml).toContain("<incident ");
    expect(await xsdErrors(xml, schemas, CIFS_SCHEMA, "cifs-variants.xml")).toEqual([]);
  });

  it("validates an empty feed against cifsv2.xsd", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    const xml = situationsToCifsXml([], AT, INFO);
    expect(await xsdErrors(xml, schemas, CIFS_SCHEMA, "cifs-empty.xml")).toEqual([]);
  });
});
