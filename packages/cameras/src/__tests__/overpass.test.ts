import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

/** OpenStreetMap webcams, read per one-degree cell. */
const osmFeed = () =>
  cameraFeed("global", {
    operator: "osm",
    product: "cameras",
    name: "OpenStreetMap webcams",
    tier: "authoritative",
    format: "overpass",
    endpoints: {
      main: {
        url: "https://overpass-api.de/api/interpreter",
        method: "POST",
        body: 'data=[out:json][timeout:25];nwr["contact:webcam"]({south},{west},{north},{east});out center tags;',
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        cadenceSec: 86400,
      },
    },
    freshnessWindowSec: 172800,
    accessMode: "on_demand",
    onDemand: { cellDeg: 1, ttlSec: 86400, maxCellsPerRead: 32, probe: [11.4, 47.27] },
    coverage: { bbox: [-180, -90, 180, 90] },
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    privacyUrl: "https://osmfoundation.org/wiki/Privacy_Policy",
  });

function parse(body: Buffer): ParseOutput {
  return camerasDomain.formats["overpass"]!.parse(
    osmFeed(),
    { main: [body] },
    parseContext(FETCHED, 86400),
  );
}

const elements = (list: unknown[]) => Buffer.from(JSON.stringify({ elements: list }));
const camera = (out: ParseOutput, element: string) =>
  out.features.find((f) => f["id"] === `oc:feature:osm-cameras:${element}`);
const reading = (out: ParseOutput, element: string) =>
  out.observations.find(
    (o) =>
      (o["subject"] as { featureId: string }).featureId === `oc:feature:osm-cameras:${element}`,
  );
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;
const viewDetails = (draft: RecordDraft | undefined) =>
  ((draft?.["components"] ?? []) as { key: string; details: Record<string, unknown> }[]).map(
    (c) => [c.key, c.details],
  );

describe("overpass", () => {
  test("an OSM webcam page becomes a link, an image URL becomes the still", () => {
    const out = parse(fixture("osm-cameras.json"));
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:osm-cameras:node_8729244903",
      "oc:feature:osm-cameras:node_9569407667",
      "oc:feature:osm-cameras:node_11351370844",
      "oc:feature:osm-cameras:node_11842260461",
      "oc:feature:osm-cameras:node_282834988",
      "oc:feature:osm-cameras:node_11982041643",
      "oc:feature:osm-cameras:way_117881300",
      "oc:feature:osm-cameras:way_127912350",
      "oc:feature:osm-cameras:way_1315949605",
    ]);

    const thaur = camera(out, "node_8729244903");
    expect(thaur).toMatchObject({
      type: "other",
      // The description is a web address, not a name.
      name: [{ lang: "und", text: "Thaurer Alm Weather camera" }],
      externalIds: [{ scheme: "osm:node", id: "8729244903" }],
      provenance: {
        sourceId: "osm-cameras",
        sourceFormat: "overpass",
        recordId: "node/8729244903",
      },
      freshness: { fetchedAt: FETCHED, expiresAt: "2026-10-09T07:00:00Z" },
      details: {
        kind: "camera",
        v: 1,
        ptz: false,
        mounting: "unknown",
        imageRedistribution: "unknown",
      },
    });
    expect(viewDetails(thaur)).toEqual([
      ["0", { kind: "camera_view", v: 1, bearingDeg: 140, imageRedistribution: "unknown" }],
    ]);
    expect(value(reading(out, "node_8729244903"))).toEqual({
      v: 1,
      status: "unknown",
      imageUrl: "https://mdw.ag/camglungezer/thaureralm.jpg",
    });

    // A page is the camera's link; its reading carries no image.
    const panomax = camera(out, "node_11351370844");
    expect(panomax?.["details"]).toEqual({
      kind: "camera",
      v: 1,
      detailUrl: "https://innsbruck-airport.panomax.com/",
      imageRedistribution: "unknown",
    });
    expect(panomax).not.toHaveProperty("name");
    // A range is no bearing.
    expect(viewDetails(panomax)).toEqual([
      [
        "0",
        {
          kind: "camera_view",
          v: 1,
          detailUrl: "https://innsbruck-airport.panomax.com/",
          imageRedistribution: "unknown",
        },
      ],
    ]);
    expect(value(reading(out, "node_11351370844"))).toEqual({ v: 1, status: "unknown" });

    // A way sits at its centre; an image file name in the query is no image path.
    const tower = camera(out, "way_117881300");
    expect(tower).toMatchObject({
      type: "landscape",
      externalIds: [{ scheme: "osm:way", id: "117881300" }],
      location: { geometry: { coordinates: [11.6640858, 48.2613098] } },
      details: {
        detailUrl:
          "https://www.meteo.physik.uni-muenchen.de/dokuwiki/lib/exe/fetch.php?cache=&media=garching.jpg",
      },
    });
    expect(value(reading(out, "way_127912350"))).toMatchObject({
      imageUrl: "https://wolf-hirth.de/webcams/cam5_org_HW.jpg",
    });

    // A hotel's webcam is a landscape camera; a traffic zone makes a traffic camera.
    expect(camera(out, "node_282834988")).toMatchObject({
      type: "landscape",
      name: [{ lang: "und", text: "Hubertus" }],
      details: { detailUrl: "https://www.hotel-hubertus.de/webcam" },
    });
    // The OSM operator is the camera's operator too, which linking compares.
    expect(camera(out, "node_11982041643")).toMatchObject({
      type: "traffic",
      name: [{ lang: "und", text: "Blickrichtung Kufstein bzw Wörgl" }],
      operator: { role: "operator", name: [{ lang: "und", text: "Land Tirol" }] },
      details: { provider: "Land Tirol", mounting: "pole", ptz: false },
    });
    expect(camera(out, "way_1315949605")?.["type"]).toBe("landscape");

    // Every camera has one reading, of its one view.
    expect(out.observations).toHaveLength(9);
    for (const o of out.observations) {
      expect((o["subject"] as { componentKey: string }).componentKey).toBe("0");
      expect(o).not.toHaveProperty("validUntil");
    }
  });

  test("weather tags, compass directions and the fallback webcam tags are read", () => {
    const out = parse(
      elements([
        {
          type: "node",
          id: 1,
          lat: 47.1,
          lon: 11.1,
          tags: {
            "contact:webcam": "https://a.example/cam.JPG?t=1",
            "monitoring:weather": "yes",
            "camera:direction": "NE",
          },
        },
        {
          type: "node",
          id: 2,
          lat: 47.1,
          lon: 11.1,
          tags: {
            webcam: "https://b.example/live",
            "weather:station": "yes",
            "camera:type": "panning",
          },
        },
        {
          type: "node",
          id: 3,
          lat: 47.1,
          lon: 11.1,
          tags: {
            "contact:webcam:1": "https://c.example/c.webp",
            natural: "peak",
            "camera:direction": "-30",
          },
        },
        {
          type: "node",
          id: 4,
          lat: 47.1,
          lon: 11.1,
          tags: {
            man_made: "surveillance",
            "surveillance:type": "webcam",
            highway: "motorway_junction",
          },
        },
        // Neither a webcam address nor a webcam tag: not a webcam.
        { type: "node", id: 5, lat: 47.1, lon: 11.1, tags: { man_made: "surveillance" } },
      ]),
    );
    expect(out.features.map((f) => [f["id"], f["type"]])).toEqual([
      ["oc:feature:osm-cameras:node_1", "weather"],
      ["oc:feature:osm-cameras:node_2", "weather"],
      ["oc:feature:osm-cameras:node_3", "landscape"],
      ["oc:feature:osm-cameras:node_4", "traffic"],
    ]);
    expect(viewDetails(out.features[0])).toEqual([
      [
        "0",
        {
          kind: "camera_view",
          v: 1,
          direction: { value: "unknown", basis: "compass", compass: "NE" },
          imageRedistribution: "unknown",
        },
      ],
    ]);
    expect(value(reading(out, "node_1"))?.["imageUrl"]).toBe("https://a.example/cam.JPG?t=1");
    expect(camera(out, "node_2")?.["details"]).toMatchObject({
      ptz: true,
      detailUrl: "https://b.example/live",
    });
    expect(value(reading(out, "node_3"))?.["imageUrl"]).toBe("https://c.example/c.webp");
    expect(viewDetails(out.features[2])).toEqual([
      ["0", { kind: "camera_view", v: 1, bearingDeg: 330, imageRedistribution: "unknown" }],
    ]);
    expect(value(reading(out, "node_4"))).toEqual({ v: 1, status: "unknown" });
  });

  test("only camera:direction is a view's bearing; a generic direction tag says nothing", () => {
    // `direction` on a node may be a road's, a sign's or a viewpoint's: not the camera's.
    const out = parse(
      elements([
        {
          type: "node",
          id: 9,
          lat: 47.1,
          lon: 11.1,
          tags: { "contact:webcam": "https://a.example/live", direction: "90" },
        },
        {
          type: "node",
          id: 10,
          lat: 47.1,
          lon: 11.1,
          tags: { "contact:webcam": "https://b.example/live", direction: "N" },
        },
      ]),
    );
    expect(viewDetails(camera(out, "node_9"))).toEqual([
      [
        "0",
        {
          kind: "camera_view",
          v: 1,
          detailUrl: "https://a.example/live",
          imageRedistribution: "unknown",
        },
      ],
    ]);
    expect(viewDetails(camera(out, "node_10"))?.[0]?.[1]).not.toHaveProperty("direction");
  });

  test("every camera seals", () => {
    const out = parse(fixture("osm-cameras.json"));
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });
});
