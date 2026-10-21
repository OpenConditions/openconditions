import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  enumsByProperty,
  fuzzTimeout,
  jsonSchemaEnums,
  pinnedJson,
  pinnedOrUnavailable,
  xsdEnumerations,
} from "@openconditions/conformance";
import { DATEX2_DGT_ES } from "@openconditions/conformance/standards/datex2-dgt-es";
import { DIGITRAFFIC_ROAD } from "@openconditions/conformance/standards/digitraffic-road";
import { beforeAll, describe, test } from "vitest";
import { fixture } from "./helpers/cameras-feed.js";
import { childText, elements, fuzzJson, fuzzXml, idOf } from "./helpers/fuzz.js";

const json = (name: string): unknown => JSON.parse(fixture(name).toString("utf8"));
/** The value at a dotted path, or a path of keys and indexes. */
const at = (node: unknown, path: string | readonly (string | number)[]): unknown => {
  for (const step of typeof path === "string" ? path.split(".") : path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string | number, unknown>)[step];
  }
  return node;
};
const listAt = (doc: unknown, path: readonly (string | number)[]): unknown[] => {
  const list = at(doc, path);
  return Array.isArray(list) ? list : [];
};
/** The records of the list at `prefix` and anything below them, so the document's envelope stays readable. */
const below =
  (...prefix: (string | number)[]) =>
  (path: readonly (string | number)[]) =>
    path.length > prefix.length && prefix.every((step, i) => path[i] === step);

/**
 * Captured camera documents, changed at random (fields deleted, values
 * swapped for the standard's other values, awkward text, numbers and times,
 * records duplicated), through the real parsers: none throws, every draft
 * seals, and each source record becomes a camera or is counted as skipped.
 */
describe("Digitraffic weather cameras, mutated within the road OpenAPI's value lists", () => {
  let enums = new Map<string, string[]>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DIGITRAFFIC_ROAD);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else
      enums = enumsByProperty(jsonSchemaEnums(await pinnedJson(DIGITRAFFIC_ROAD, "openapi.json")));
  }, 120_000);

  const details = {
    details: [
      fixture("fi-digitraffic-station-C01503.json"),
      fixture("fi-digitraffic-station-C01632.json"),
    ],
    status: [fixture("fi-digitraffic-data.json")],
  };

  test(
    "the station list",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      fuzzJson(
        {
          feed: "fi-digitraffic-cameras",
          role: "sites",
          base: json("fi-digitraffic-stations.json"),
          others: details,
          records: (doc) => listAt(doc, ["features"]).map((f) => idOf(at(f, "properties.id"))),
        },
        { within: below("features"), enums },
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "a station's details and the image times",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const sites = json("fi-digitraffic-stations.json");
      const stations = listAt(sites, ["features"]).map((f) => idOf(at(f, "properties.id")));
      const list = { sites: [fixture("fi-digitraffic-stations.json")] };
      // Each station of the list is a camera whatever its details and images say.
      for (const [role, base, others] of [
        [
          "details",
          json("fi-digitraffic-station-C01503.json"),
          { ...list, status: details.status },
        ],
        ["status", json("fi-digitraffic-data.json"), { ...list, details: details.details }],
      ] as const) {
        fuzzJson(
          {
            feed: "fi-digitraffic-cameras",
            role,
            base,
            others,
            records: () => stations,
            runs: 100,
          },
          { within: (p) => (role === "status" ? below("stations")(p) : p.length > 0), enums },
        );
      }
    },
    fuzzTimeout(5_000),
  );
});

describe("DGT's DATEX II device publication, mutated within the schemas' enumerations", () => {
  let enumerations: string[][] = [];
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DATEX2_DGT_ES);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else enumerations = xsdEnumerations(pinned.files).map((e) => e.values);
  }, 120_000);

  const DGT = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "datex2",
      "src",
      "__tests__",
      "fixtures",
      "es-dgt-cameras.xml",
    ),
    "utf8",
  );

  test(
    "devices",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      fuzzXml(
        {
          feed: "es-dgt-cameras",
          role: "main",
          base: DGT,
          // A device of another type is no camera and is not counted.
          records: (xml) =>
            elements(xml, "ns2:device")
              .filter((d) => childText(d, "ns2:typeOfDevice")?.trim() === "camera")
              .map((d) => idOf(/^<ns2:device\b[^>]*\sid="([^"]*)"/.exec(d)?.[1])),
        },
        { within: (path) => path.includes("ns2:device/"), enumerations },
      );
    },
    fuzzTimeout(5_000),
  );
});

describe("camera formats without a pinned schema, mutated from their captures", () => {
  const field = (path: string) => (record: unknown) => idOf(at(record, path));
  /** Each case: the feed, its capture, the list of its records and a record's camera id. */
  const cases: [string, string, string, (string | number)[], (r: unknown) => string | undefined][] =
    [
      [
        "trafikverket",
        "se-trafikverket-cameras",
        "se-trafikverket-cameras.json",
        ["RESPONSE", "RESULT", 0, "Camera"],
        field("Id"),
      ],
      ["ibi511 (Ontario)", "ca-on-511-cameras", "ca-on-511-cameras.json", [], field("Id")],
      ["ibi511 (Georgia)", "us-ga-511-cameras", "us-ga-511-cameras.json", [], field("Id")],
      ["ibi511 (Idaho)", "us-id-511-cameras", "us-id-511-cameras.json", [], field("Id")],
      ["ibi511 (Louisiana)", "us-la-511-cameras", "us-la-511-cameras.json", [], field("Id")],
      ["tfl", "gb-eng-tfl-cameras", "gb-eng-tfl-jamcams.json", [], field("id")],
      ["nps", "us-nps-cameras", "us-nps-webcams.json", ["data"], field("id")],
      ["windy", "windy-cameras", "windy-webcams.json", ["webcams"], field("webcamId")],
      [
        "tripcheck",
        "us-or-tripcheck-cameras",
        "us-or-tripcheck-cctv-inventory.json",
        ["CCTVInventoryRequest"],
        field("device-id"),
      ],
      ["tdx", "tw-tdx-cameras", "tw-tdx-cctv-highway.json", ["CCTVs"], field("CCTVID")],
      [
        "overpass",
        "osm-cameras",
        "osm-cameras.json",
        ["elements"],
        (r) => idOf(`${String(at(r, "type"))}/${String(at(r, "id"))}`),
      ],
      [
        "json layout (NSW)",
        "au-nsw-livetraffic-cameras",
        "au-nsw-cameras.geojson",
        ["features"],
        field("id"),
      ],
      [
        "json layout (Iceland)",
        "is-vegagerdin-cameras",
        "is-vegagerdin.json",
        [],
        field("Maelist_nr"),
      ],
      [
        "json layout (Caltrans)",
        "us-ca-caltrans-cameras",
        "us-ca-caltrans-d9.json",
        ["data"],
        (r) => {
          const parts = [field("cctv.location.district")(r), field("cctv.index")(r)];
          return parts.every((p) => p !== undefined) ? parts.join(":") : undefined;
        },
      ],
      [
        "geojson layout (Norway)",
        "no-vegvesen-cameras",
        "no-vegvesen-cctvsimple.json",
        ["features"],
        (r) => idOf(/^([^_]+)_/.exec(String(at(r, "properties.cameraId")))?.[1]),
      ],
    ];

  test.each(cases)(
    "%s",
    (_name, feed, file, list, id) => {
      fuzzJson(
        {
          feed,
          role: "main",
          base: json(file),
          // A camera the publisher marks deleted is left out, as it should be.
          records: (doc) =>
            listAt(doc, list)
              .filter((r) => at(r, "Deleted") !== true)
              .map(id),
        },
        { within: below(...list) },
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "hk-td",
    () => {
      fuzzXml(
        {
          feed: "hk-td-cameras",
          role: "main",
          base: fixture("hk-td-cameras-en.xml").toString("utf8"),
          others: { names: [fixture("hk-td-cameras-tc.xml")] },
          records: (xml) => elements(xml, "image").map((e) => idOf(childText(e, "key"))),
        },
        { within: (path) => path.split("/").length > 1 },
      );
    },
    fuzzTimeout(5_000),
  );

  test(
    "cars-cctv",
    () => {
      fuzzXml(
        {
          feed: "us-ny-511-cameras",
          role: "main",
          base: fixture("us-ny-511-cctv.xml").toString("utf8"),
          records: (xml) =>
            elements(xml, "inventory-item").map((e) => idOf(childText(e, "device-id"))),
        },
        { within: (path) => path.includes("inventory-item") },
      );
    },
    fuzzTimeout(5_000),
  );
});
