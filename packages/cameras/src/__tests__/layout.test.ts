import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

const base = {
  product: "cameras",
  tier: "authoritative",
  privacyUrl: "https://example.org/privacy",
} as const;

/** Statens vegvesen's keyless WFS layer, one record per view. */
const npraFeed = () =>
  cameraFeed("no", {
    ...base,
    operator: "vegvesen",
    name: "Statens vegvesen web cameras",
    format: "geojson",
    endpoints: {
      main: {
        url: "https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=datex_3_1%3ACctvSimple&outputFormat=application%2Fjson",
        cadenceSec: 600,
      },
    },
    freshnessWindowSec: 1800,
    license: "NLOD-2.0",
    attribution: "Statens vegvesen",
    layout: {},
    cameras: {
      imageHosts: ["kamera.atlas.vegvesen.no"],
      groupBy: { field: "cameraId", pattern: "^([^_]+)_" },
      viewKey: "cameraId",
      name: "description",
      lang: "no",
      viewName: "orientationDescription",
      road: "roadNumber",
      type: "traffic",
      imageUrl: "stillImageUrl",
      streamUrl: "videoUrl",
      streamType: "hls",
      status: {
        field: "status.stillImageAvailability",
        map: {
          videoOrImagesAvailable: "online",
          videoOrImagesUnavailableDueToCameraFault: "offline",
        },
      },
      imageRedistribution: "allowed",
    },
  });

/** Vegagerðin's camera list, one row per view of a weather station. */
const icelandFeed = () =>
  cameraFeed("is", {
    ...base,
    operator: "vegagerdin",
    name: "Vegagerðin web cameras",
    format: "json",
    endpoints: {
      main: { url: "https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1", cadenceSec: 86400 },
    },
    freshnessWindowSec: 172800,
    license: "CC-BY-4.0",
    attribution: "Vegagerðin",
    layout: { lon: "Lengd", lat: "Breidd" },
    cameras: {
      imageHosts: ["www.vegagerdin.is"],
      id: "Maelist_nr",
      viewKey: { field: "Slod", pattern: "/([^/]+)\\.jpg$" },
      name: "Myndavel",
      lang: "is",
      viewName: "Skyring",
      road: "NrVegur",
      type: "weather",
      imageUrl: "Slod",
      imageRedistribution: "allowed",
    },
  });

const COMPASS = { North: "N", South: "S", East: "E", West: "W" } as const;

/** Caltrans' district files, one camera per record. */
const caltransFeed = (imageHosts = ["cwwp2.dot.ca.gov"]) =>
  cameraFeed("us", {
    ...base,
    subdivision: "ca",
    operator: "caltrans",
    name: "Caltrans CCTV",
    format: "json",
    endpoints: {
      main: {
        urls: [
          "https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json",
          "https://cwwp2.dot.ca.gov/data/d9/cctv/cctvStatusD09.json",
        ],
        fanout: "tolerant",
        cadenceSec: 3600,
      },
    },
    freshnessWindowSec: 86400,
    license: "LicenseRef-Caltrans-Conditions-of-Use",
    attribution: "Caltrans",
    layout: { records: "data", lon: "cctv.location.longitude", lat: "cctv.location.latitude" },
    cameras: {
      imageHosts,
      id: ["cctv.location.district", "cctv.index"],
      name: "cctv.location.locationName",
      lang: "en",
      type: "traffic",
      road: "cctv.location.route",
      viewName: "cctv.imageData.imageDescription",
      direction: { field: "cctv.location.direction", map: COMPASS },
      imageUrl: "cctv.imageData.static.currentImageURL",
      streamUrl: "cctv.imageData.streamingVideoURL",
      streamType: "hls",
      status: {
        field: "cctv.inService",
        map: { true: "unknown", false: "offline", "Not Reported": "unknown" },
      },
      refreshSec: { field: "cctv.imageData.static.currentImageUpdateFrequency", unit: "min" },
      imageRedistribution: "allowed",
    },
  });

/**
 * Transport for NSW's cameras: a FeatureCollection whose camera id is the
 * Feature's own `id`, outside `properties`, so the feed reads the collection
 * through the JSON layout.
 */
const nswFeed = () =>
  cameraFeed("au", {
    ...base,
    subdivision: "nsw",
    operator: "livetraffic",
    name: "Live Traffic NSW cameras",
    format: "json",
    endpoints: {
      main: { url: "https://api.transport.nsw.gov.au/v1/live/cameras", cadenceSec: 3600 },
    },
    freshnessWindowSec: 7200,
    license: "CC-BY-4.0",
    attribution: "Transport for NSW",
    layout: { records: "features", geometryPath: "geometry" },
    cameras: {
      imageHosts: ["webcams.transport.nsw.gov.au", "data.livetraffic.com"],
      id: "id",
      name: "properties.title",
      description: "properties.view",
      lang: "en",
      type: "traffic",
      direction: {
        field: "properties.direction",
        map: { N: "N", "N-E": "NE", E: "E", "S-E": "SE", S: "S", "S-W": "SW", W: "W", "N-W": "NW" },
      },
      imageUrl: "properties.href",
      imageRedistribution: "allowed",
    },
  });

function parse(feed: CamerasCatalogFeed, ...bodies: Buffer[]): ParseOutput {
  return camerasDomain.formats[feed.format]!.parse(
    feed,
    { main: bodies },
    parseContext(FETCHED, feed.cadenceSec),
  );
}

type View = { key: string; name?: unknown; details: Record<string, unknown> };
const views = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as View[];
const camera = (out: ParseOutput, id: string) => out.features.find((f) => f["id"] === id);
const readingsOf = (out: ParseOutput, featureId: string) =>
  out.observations.filter((o) => (o["subject"] as { featureId: string }).featureId === featureId);
const value = (reading: RecordDraft | undefined) =>
  (reading?.["result"] as { value: Record<string, unknown> } | undefined)?.value;

describe("layout", () => {
  test("NPRA views group into one camera per site", () => {
    const out = parse(npraFeed(), fixture("no-vegvesen-cctvsimple.json"));
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:no-vegvesen-cameras:3000063",
      "oc:feature:no-vegvesen-cameras:1429014",
      "oc:feature:no-vegvesen-cameras:3000061",
      "oc:feature:no-vegvesen-cameras:1429011",
    ]);
    const site = camera(out, "oc:feature:no-vegvesen-cameras:1429014");
    expect(views(site).map((v) => v.key)).toEqual(["1429014_1", "1429014_2"]);
    expect(views(site).map((v) => v.name)).toEqual([
      [{ lang: "no", text: "Florø" }],
      [{ lang: "no", text: "Svelgen" }],
    ]);
    expect(site).toMatchObject({
      type: "traffic",
      name: [{ lang: "no", text: "Grytadalen" }],
      location: { geometry: { coordinates: [5.194947, 61.66738] }, roads: [{ ref: "F614" }] },
      externalIds: [{ scheme: "provider", id: "1429014", authority: "no-vegvesen-cameras" }],
      details: { kind: "camera", v: 1, imageRedistribution: "allowed" },
    });
    // A camera fault is offline, and the camera is still emitted.
    const readings = readingsOf(out, "oc:feature:no-vegvesen-cameras:1429014");
    expect(readings.map((r) => (r["subject"] as { componentKey: string }).componentKey)).toEqual([
      "1429014_1",
      "1429014_2",
    ]);
    expect(readings.map((r) => value(r)?.["status"])).toEqual(["offline", "offline"]);
    expect(value(readings[0])).toMatchObject({
      imageUrl: "https://kamera.atlas.vegvesen.no/api/images/1429014_1",
    });
    expect(views(camera(out, "oc:feature:no-vegvesen-cameras:1429011"))).toHaveLength(3);
    // A view with video carries its stream; one without has no stream type either.
    const [video] = readingsOf(out, "oc:feature:no-vegvesen-cameras:3000061");
    expect(value(video)).toEqual({
      v: 1,
      status: "online",
      imageUrl: "https://kamera.atlas.vegvesen.no/api/images/3000061_1",
      streamUrl: "https://kamera.vegvesen.no/public/3000061_1/manifest.m3u8",
      streamType: "hls",
    });
    const [still] = readingsOf(out, "oc:feature:no-vegvesen-cameras:3000063");
    expect(value(still)).toEqual({
      v: 1,
      status: "online",
      imageUrl: "https://kamera.atlas.vegvesen.no/api/images/3000063_1",
    });
    expect(out.observations).toHaveLength(7);
    expect(out.rejected ?? 0).toBe(0);
  });

  test("Vegagerðin rows of one station are its views", () => {
    const out = parse(icelandFeed(), fixture("is-vegagerdin.json"));
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:is-vegagerdin-cameras:7001",
      "oc:feature:is-vegagerdin-cameras:7040",
    ]);
    const station = camera(out, "oc:feature:is-vegagerdin-cameras:7001");
    expect(views(station).map((v) => v.key)).toEqual([
      "hellisheidi_1",
      "hellisheidi_2",
      "hellisheidi_3",
    ]);
    expect(views(station)[0]?.name).toEqual([{ lang: "is", text: "Hellisheiði séð til vesturs" }]);
    expect(station).toMatchObject({
      type: "weather",
      name: [{ lang: "is", text: "Hellisheiði" }],
      location: { geometry: { coordinates: [-21.342636, 64.018296] }, roads: [{ ref: "1" }] },
    });
    // No status and no image time upstream: unknown, as of the fetch.
    const readings = readingsOf(out, "oc:feature:is-vegagerdin-cameras:7001");
    expect(readings.map((r) => value(r))).toEqual(
      [1, 2, 3].map((n) => ({
        v: 1,
        status: "unknown",
        imageUrl: `https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_${n}.jpg`,
      })),
    );
    expect(readings.map((r) => r["phenomenonTime"])).toEqual(
      readings.map(() => ({ instant: FETCHED })),
    );
  });

  test("Caltrans reads every district file, refresh in minutes, road direction as a compass", () => {
    const out = parse(
      caltransFeed(),
      fixture("us-ca-caltrans-d7.json"),
      fixture("us-ca-caltrans-d9.json"),
    );
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:us-ca-caltrans-cameras:7:1",
      "oc:feature:us-ca-caltrans-cameras:7:7",
      "oc:feature:us-ca-caltrans-cameras:7:1041",
      "oc:feature:us-ca-caltrans-cameras:7:349",
      "oc:feature:us-ca-caltrans-cameras:9:22",
      "oc:feature:us-ca-caltrans-cameras:9:42",
      "oc:feature:us-ca-caltrans-cameras:9:50",
      "oc:feature:us-ca-caltrans-cameras:9:33",
    ]);
    const first = camera(out, "oc:feature:us-ca-caltrans-cameras:7:1");
    expect(first).toMatchObject({
      type: "traffic",
      name: [{ lang: "en", text: "I-110 : (196) Avenue 26 Off Ramp" }],
      location: { geometry: { coordinates: [-118.2215, 34.0837] }, roads: [{ ref: "I-110" }] },
      details: { kind: "camera", v: 1, refreshSec: 120, imageRedistribution: "allowed" },
    });
    // The county the record names ("Alameda", in Los Angeles) is not read.
    expect(JSON.stringify(first)).not.toContain("Alameda");
    expect(views(first)).toEqual([
      {
        key: "0",
        kind: "camera_view",
        details: {
          kind: "camera_view",
          v: 1,
          direction: { value: "unknown", basis: "compass", compass: "S" },
          imageRedistribution: "allowed",
        },
      },
    ]);
    const [reading] = readingsOf(out, "oc:feature:us-ca-caltrans-cameras:7:1");
    expect(value(reading)).toEqual({
      v: 1,
      status: "unknown",
      imageUrl:
        "https://cwwp2.dot.ca.gov/data/d7/cctv/image/i110196avenue26offramp/i110196avenue26offramp.jpg",
      streamUrl: "https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8",
      streamType: "hls",
    });
    // The record's timestamp says when the record changed, not when the image was taken.
    expect(reading?.["phenomenonTime"]).toEqual({ instant: FETCHED });
    // Out of service is offline, and the camera is still emitted.
    const [offline] = readingsOf(out, "oc:feature:us-ca-caltrans-cameras:7:7");
    expect(value(offline)?.["status"]).toBe("offline");
    // An hour's refresh; no direction for an empty one; the image's caption names the view.
    expect(camera(out, "oc:feature:us-ca-caltrans-cameras:7:349")?.["details"]).toMatchObject({
      refreshSec: 3600,
    });
    expect(views(camera(out, "oc:feature:us-ca-caltrans-cameras:7:1041"))[0]?.details).toEqual({
      kind: "camera_view",
      v: 1,
      imageRedistribution: "allowed",
    });
    expect(views(camera(out, "oc:feature:us-ca-caltrans-cameras:9:22"))[0]).toMatchObject({
      name: [{ lang: "en", text: "Looking South" }],
      details: { direction: { value: "unknown", basis: "compass", compass: "W" } },
    });
    // No stream: neither URL nor type.
    expect(value(readingsOf(out, "oc:feature:us-ca-caltrans-cameras:9:22")[0])).not.toHaveProperty(
      "streamType",
    );
  });

  test("a refresh the publisher does not report is left out", () => {
    // As district 3 publishes it for its index 238.
    const d9 = JSON.parse(fixture("us-ca-caltrans-d9.json").toString("utf8"));
    d9.data[0].cctv.imageData.static.currentImageUpdateFrequency = "Not Reported";
    const out = parse(caltransFeed(), Buffer.from(JSON.stringify(d9)));
    expect(camera(out, "oc:feature:us-ca-caltrans-cameras:9:22")?.["details"]).toEqual({
      kind: "camera",
      v: 1,
      imageRedistribution: "allowed",
    });
  });

  test("an image URL off the feed's declared hosts is dropped", () => {
    const out = parse(caltransFeed(["evil.example"]), fixture("us-ca-caltrans-d9.json"));
    expect(out.observations).toHaveLength(4);
    for (const reading of out.observations) expect(value(reading)).not.toHaveProperty("imageUrl");
    expect(out.rejected).toBe(4);
  });

  test("NSW cameras look the way their direction says, the view text describes them", () => {
    const out = parse(nswFeed(), fixture("au-nsw-cameras.geojson"));
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:au-nsw-livetraffic-cameras:023651ee-389c-4677-978e-d39b6c24c1e7",
      "oc:feature:au-nsw-livetraffic-cameras:95054500-072d-4c07-8509-1025b1160131",
      "oc:feature:au-nsw-livetraffic-cameras:deed2090-7deb-429d-8cf7-0b247c17f653",
    ]);
    const [miranda, westLink] = out.features;
    expect(miranda).toMatchObject({
      name: [{ lang: "en", text: "5 Ways (Miranda)" }],
      description: [
        { lang: "en", text: "5 Ways at The Boulevarde looking west towards Sutherland." },
      ],
      location: { geometry: { coordinates: [151.10533, -34.02977] } },
    });
    expect(views(westLink)[0]?.details).toEqual({
      kind: "camera_view",
      v: 1,
      direction: { value: "unknown", basis: "compass", compass: "NE" },
      imageRedistribution: "allowed",
    });
    // Both declared hosts serve stills.
    expect(out.observations.map((r) => value(r)?.["imageUrl"])).toEqual([
      "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg",
      "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/city_west_link.jpeg",
      "https://data.livetraffic.com/cameras/victoriapass_4.jpg",
    ]);
  });

  test("an image time is read as ISO with its offset or as epoch seconds or milliseconds", () => {
    const feed = (imageAt: Record<string, unknown>) =>
      cameraFeed("is", {
        ...base,
        operator: "test",
        name: "Image times",
        format: "json",
        endpoints: { main: { url: "https://example.org/cams.json", cadenceSec: 600 } },
        freshnessWindowSec: 1800,
        license: "CC-BY-4.0",
        attribution: "Test",
        layout: { lon: "lon", lat: "lat" },
        cameras: { id: "id", lang: "en", type: "other", imageAt, imageRedistribution: "unknown" },
      });
    const row = (taken: unknown) =>
      Buffer.from(JSON.stringify([{ id: 1, lon: -21, lat: 64, taken }]));
    const at = (format: string, taken: unknown) => {
      const out = parse(feed({ field: "taken", format }), row(taken));
      return [value(out.observations[0])?.["imageAt"], out.observations[0]?.["phenomenonTime"]];
    };
    expect(at("iso", "2026-10-08T08:46:02+0200")).toEqual([
      "2026-10-08T06:46:02Z",
      { instant: "2026-10-08T06:46:02Z" },
    ]);
    expect(at("epoch-s", "1791441962")).toEqual([
      "2026-10-08T06:46:02Z",
      { instant: "2026-10-08T06:46:02Z" },
    ]);
    expect(at("epoch-ms", 1791441962000)).toEqual([
      "2026-10-08T06:46:02Z",
      { instant: "2026-10-08T06:46:02Z" },
    ]);
    // A time without its zone names no instant.
    expect(at("iso", "2026-10-08T08:46:02")).toEqual([undefined, { instant: FETCHED }]);
  });

  test("a type map names the camera's type, its default the rest", () => {
    const feed = cameraFeed("is", {
      ...base,
      operator: "test",
      name: "Types",
      format: "csv",
      endpoints: { main: { url: "https://example.org/cams.csv", cadenceSec: 600 } },
      freshnessWindowSec: 1800,
      license: "CC-BY-4.0",
      attribution: "Test",
      layout: { lon: "lon", lat: "lat" },
      cameras: {
        id: "id",
        lang: "en",
        type: { field: "kind", map: { road: "traffic", peak: "landscape" }, default: "weather" },
        bearing: "facing",
        imageRedistribution: "unknown",
      },
    });
    const csv = "id,lon,lat,kind,facing\n1,-21,64,road,370\n2,-21,64,peak,\n3,-21,64,shore,x\n";
    const out = parse(feed, Buffer.from(csv));
    expect(out.features.map((f) => f["type"])).toEqual(["traffic", "landscape", "weather"]);
    expect(views(out.features[0])[0]?.details).toEqual({
      kind: "camera_view",
      v: 1,
      bearingDeg: 10,
      imageRedistribution: "unknown",
    });
    expect(views(out.features[2])[0]?.details).toEqual({
      kind: "camera_view",
      v: 1,
      imageRedistribution: "unknown",
    });
  });

  test("a record without an id or a place is rejected", () => {
    const rows = [
      { Maelist_nr: 1, Breidd: 64, Lengd: -21, Slod: "https://www.vegagerdin.is/a_1.jpg" },
      { Breidd: 64, Lengd: -21, Slod: "https://www.vegagerdin.is/b_1.jpg" },
      { Maelist_nr: 2, Slod: "https://www.vegagerdin.is/c_1.jpg" },
    ];
    const out = parse(icelandFeed(), Buffer.from(JSON.stringify(rows)));
    expect(out.features.map((f) => f["id"])).toEqual(["oc:feature:is-vegagerdin-cameras:1"]);
    expect(out.rejected).toBe(2);
  });

  test("a view key a camera already has is read once", () => {
    const row = {
      Maelist_nr: 1,
      Breidd: 64,
      Lengd: -21,
      Slod: "https://www.vegagerdin.is/a_1.jpg",
    };
    const out = parse(icelandFeed(), Buffer.from(JSON.stringify([row, row])));
    expect(views(out.features[0])).toHaveLength(1);
    expect(out.observations).toHaveLength(1);
    expect(out.rejected).toBe(1);
  });

  test("view keys are compared as the components carry them", () => {
    const row = (slod: string) => ({ Maelist_nr: 1, Breidd: 64, Lengd: -21, Slod: slod });
    const out = parse(
      icelandFeed(),
      Buffer.from(
        JSON.stringify([
          row("https://www.vegagerdin.is/a#1.jpg"),
          row("https://www.vegagerdin.is/a_1.jpg"),
        ]),
      ),
    );
    expect(views(out.features[0]).map((v) => v.key)).toEqual(["a_1"]);
    expect(out.observations).toHaveLength(1);
    expect(out.rejected).toBe(1);
  });

  test("a camera grouped from its view records is the same whatever the row order", () => {
    const collection = JSON.parse(fixture("no-vegvesen-cctvsimple.json").toString("utf8"));
    const reversed = Buffer.from(
      JSON.stringify({ ...collection, features: [...collection.features].reverse() }),
    );
    const forward = parse(npraFeed(), fixture("no-vegvesen-cctvsimple.json"));
    const backward = parse(npraFeed(), reversed);
    const site = "oc:feature:no-vegvesen-cameras:1429011";
    // The camera id is the group value, not the id of whichever row came first.
    expect(backward.features.map((f) => f["id"]).sort()).toEqual(
      forward.features.map((f) => f["id"]).sort(),
    );
    expect(views(camera(backward, site)).map((v) => v.key)).toEqual([
      "1429011_1",
      "1429011_2",
      "1429011_3",
    ]);
    expect(camera(backward, site)).toEqual(camera(forward, site));
    expect(readingsOf(backward, site)).toEqual(readingsOf(forward, site));
  });

  test("every camera seals", () => {
    const outs = [
      parse(npraFeed(), fixture("no-vegvesen-cctvsimple.json")),
      parse(icelandFeed(), fixture("is-vegagerdin.json")),
      parse(caltransFeed(), fixture("us-ca-caltrans-d7.json"), fixture("us-ca-caltrans-d9.json")),
      parse(nswFeed(), fixture("au-nsw-cameras.geojson")),
    ];
    for (const out of outs) {
      expect(out.features.length).toBeGreaterThan(0);
      expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    }
  });
});
