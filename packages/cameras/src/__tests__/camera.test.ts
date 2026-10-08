import { emptyParseOutput } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { cameraDraft, imageReading, matchesImageHost } from "../camera.js";
import { cameraFeed } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

/** A feed of the generic JSON layout, declaring the hosts its stills live on. */
const caltransLike = (imageHosts?: string[]) =>
  cameraFeed("us", {
    subdivision: "ca",
    operator: "caltrans",
    product: "cameras",
    name: "Caltrans CCTV",
    tier: "authoritative",
    format: "json",
    endpoints: {
      main: { url: "https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json", cadenceSec: 3600 },
    },
    freshnessWindowSec: 86400,
    license: "LicenseRef-Caltrans-Conditions-of-Use",
    attribution: "Caltrans",
    privacyUrl: "https://dot.ca.gov/privacy-policy",
    layout: { records: "data" },
    cameras: {
      ...(imageHosts === undefined ? {} : { imageHosts }),
      id: "id",
      lang: "en",
      type: "traffic",
      imageRedistribution: "allowed",
    },
  });

const context = () => ({ fetchedAt: FETCHED, out: emptyParseOutput() });

describe("matchesImageHost", () => {
  test("matchesImageHost honours exact, wildcard and path-prefix entries", () => {
    expect(
      matchesImageHost("https://weathercam.digitraffic.fi/C0150301.jpg", [
        "weathercam.digitraffic.fi",
      ]),
    ).toBe(true);
    expect(
      matchesImageHost("https://cctv-ss02.thb.gov.tw:443/T62/snapshot", ["*.thb.gov.tw"]),
    ).toBe(true);
    expect(
      matchesImageHost("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.06514.jpg", [
        "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/",
      ]),
    ).toBe(true);
    expect(
      matchesImageHost("https://s3-eu-west-1.amazonaws.com/other-bucket/x.jpg", [
        "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/",
      ]),
    ).toBe(false);
  });

  test("a wildcard names subdomains only, and an exact host no other host", () => {
    expect(matchesImageHost("https://thb.gov.tw/x.jpg", ["*.thb.gov.tw"])).toBe(false);
    expect(matchesImageHost("https://evilthb.gov.tw/x.jpg", ["*.thb.gov.tw"])).toBe(false);
    expect(
      matchesImageHost("https://a.weathercam.digitraffic.fi/x.jpg", ["weathercam.digitraffic.fi"]),
    ).toBe(false);
    expect(
      matchesImageHost("https://weathercam.digitraffic.fi.evil.example/x.jpg", [
        "weathercam.digitraffic.fi",
      ]),
    ).toBe(false);
    // Host names compare without case, as URLs do.
    expect(
      matchesImageHost("https://WeatherCam.Digitraffic.FI/x.jpg", ["weathercam.digitraffic.fi"]),
    ).toBe(true);
  });

  test("a path prefix holds after the URL's dot segments are resolved", () => {
    const tfl = ["s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/"];
    expect(
      matchesImageHost("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/../other/x.jpg", tfl),
    ).toBe(false);
    expect(
      matchesImageHost("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.ukx/x.jpg", tfl),
    ).toBe(false);
  });

  test("refuses an encoded separator or dot below a path prefix", () => {
    // The same cases as OpenMapX's media-hosts test, which the proxy applies.
    const hosts = ["s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/"];
    for (const path of ["%2F..%2Fother/a.jpg", "%2e%2e/other/a.jpg", "..%5Cother/a.jpg"]) {
      expect(
        matchesImageHost(`https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${path}`, hosts),
        path,
      ).toBe(false);
    }
  });

  test("only http(s) URLs without credentials match", () => {
    const hosts = ["cwwp2.dot.ca.gov"];
    expect(matchesImageHost("http://cwwp2.dot.ca.gov/x.jpg", hosts)).toBe(true);
    expect(matchesImageHost("ftp://cwwp2.dot.ca.gov/x.jpg", hosts)).toBe(false);
    expect(matchesImageHost("https://user:pass@cwwp2.dot.ca.gov/x.jpg", hosts)).toBe(false);
    expect(matchesImageHost("not a url", hosts)).toBe(false);
    expect(matchesImageHost("https://cwwp2.dot.ca.gov/x.jpg", [])).toBe(false);
  });

  test("a port other than the scheme's default never matches", () => {
    expect(matchesImageHost("https://cwwp2.dot.ca.gov:8443/x.jpg", ["cwwp2.dot.ca.gov"])).toBe(
      false,
    );
    expect(matchesImageHost("http://cwwp2.dot.ca.gov:443/x.jpg", ["cwwp2.dot.ca.gov"])).toBe(false);
    // The default port written out is no other port.
    expect(
      matchesImageHost("https://cctv-ss02.thb.gov.tw:443/T62/snapshot", ["*.thb.gov.tw"]),
    ).toBe(true);
    expect(matchesImageHost("http://cwwp2.dot.ca.gov:80/x.jpg", ["cwwp2.dot.ca.gov"])).toBe(true);
  });
});

describe("cameraDraft", () => {
  test("a camera is a feature with its views as components and seals", () => {
    const feed = caltransLike(["cwwp2.dot.ca.gov"]);
    const draft = cameraDraft(feed, context(), {
      cameraId: "7:1 #a",
      point: [-118.2215, 34.0837],
      names: [{ lang: "en", text: "I-110 : (196) Avenue 26 Off Ramp" }],
      type: "traffic",
      road: { ref: "I-110" },
      refreshSec: 120,
      imageRedistribution: "allowed",
      views: [
        { key: "0#1", direction: { value: "unknown", basis: "compass", compass: "S" } },
        { key: "1", name: [{ lang: "en", text: "Looking South" }], bearingDeg: 180 },
      ],
    });
    expect(draft).toMatchObject({
      // The id keeps the publisher's id, every other character reduced.
      id: "oc:feature:us-ca-caltrans-cameras:7:1__a",
      class: "feature",
      kind: "camera",
      type: "traffic",
      lifecycle: "operational",
      name: [{ lang: "en", text: "I-110 : (196) Avenue 26 Off Ramp" }],
      location: { geometry: { coordinates: [-118.2215, 34.0837] }, roads: [{ ref: "I-110" }] },
      externalIds: [{ scheme: "provider", id: "7:1 #a", authority: "us-ca-caltrans-cameras" }],
      provenance: { sourceId: "us-ca-caltrans-cameras", sourceFormat: "json", recordId: "7:1 #a" },
      components: [
        {
          key: "0_1",
          kind: "camera_view",
          details: {
            kind: "camera_view",
            v: 1,
            direction: { value: "unknown", basis: "compass", compass: "S" },
          },
        },
        {
          key: "1",
          kind: "camera_view",
          name: [{ lang: "en", text: "Looking South" }],
          details: { kind: "camera_view", v: 1, bearingDeg: 180 },
        },
      ],
      details: { kind: "camera", v: 1, refreshSec: 120, imageRedistribution: "allowed" },
    });
    expect(sealFailures([draft])).toEqual([]);
  });

  test("a camera without views has the one view `0`; one without a provider id carries none", () => {
    const draft = cameraDraft(caltransLike(), context(), {
      cameraId: "node/1",
      providerId: false,
      externalIds: [{ scheme: "osm:node", id: "1" }],
      point: [11.4, 47.27],
      names: [],
      type: "other",
      imageRedistribution: "unknown",
      views: [],
    });
    expect(draft["id"]).toBe("oc:feature:us-ca-caltrans-cameras:node_1");
    expect(draft["externalIds"]).toEqual([{ scheme: "osm:node", id: "1" }]);
    expect(draft["name"]).toBeUndefined();
    expect(draft["components"]).toEqual([
      {
        key: "0",
        kind: "camera_view",
        details: { kind: "camera_view", v: 1, imageRedistribution: "unknown" },
      },
    ]);
    expect(sealFailures([draft])).toEqual([]);
  });
});

describe("imageReading", () => {
  test("a reading names its view, keeps the image time and states no validity", () => {
    const feed = caltransLike(["cwwp2.dot.ca.gov"]);
    const ctx = context();
    const reading = imageReading(feed, ctx, {
      cameraId: "7:1",
      viewKey: "0",
      status: "online",
      imageUrl: "https://cwwp2.dot.ca.gov/data/d7/cctv/image/a/a.jpg",
      streamUrl: "https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8",
      streamType: "hls",
      imageAt: "2026-10-08T06:58:00Z",
      point: [-118.2215, 34.0837],
    });
    expect(reading).toMatchObject({
      class: "observation",
      property: "camera.image",
      subject: {
        kind: "feature",
        featureId: "oc:feature:us-ca-caltrans-cameras:7:1",
        componentKey: "0",
      },
      result: {
        type: "structured",
        schema: "camera_image",
        v: 1,
        value: {
          v: 1,
          status: "online",
          imageUrl: "https://cwwp2.dot.ca.gov/data/d7/cctv/image/a/a.jpg",
          imageAt: "2026-10-08T06:58:00Z",
          streamUrl: "https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8",
          streamType: "hls",
        },
      },
      phenomenonTime: { instant: "2026-10-08T06:58:00Z" },
    });
    expect(reading).not.toHaveProperty("validUntil");
    expect(String(reading["id"])).toMatch(/^oc:observation:us-ca-caltrans-cameras:/);
    expect(ctx.out.rejected ?? 0).toBe(0);
    expect(sealFailures([reading])).toEqual([]);
  });

  test("an image time after the fetch is held to the fetch; without one the fetch dates the reading", () => {
    const feed = caltransLike(["cwwp2.dot.ca.gov"]);
    const later = imageReading(feed, context(), {
      cameraId: "1",
      viewKey: "0",
      status: "unknown",
      imageAt: "2026-10-08T09:00:00Z",
    });
    expect(later["phenomenonTime"]).toEqual({ instant: FETCHED });
    expect((later["result"] as { value: Record<string, unknown> }).value["imageAt"]).toBe(FETCHED);
    const undated = imageReading(feed, context(), {
      cameraId: "1",
      viewKey: "0",
      status: "unknown",
    });
    expect(undated["phenomenonTime"]).toEqual({ instant: FETCHED });
    expect((undated["result"] as { value: object }).value).toEqual({ v: 1, status: "unknown" });
    expect(undated["location"]).toMatchObject({ geometry: null, extent: "none" });
  });

  test("an image URL off the feed's declared hosts is dropped", () => {
    const ctx = context();
    const reading = imageReading(caltransLike(["cwwp2.dot.ca.gov"]), ctx, {
      cameraId: "7:1",
      viewKey: "0",
      status: "unknown",
      imageUrl: "https://evil.example/cam.jpg",
      thumbnailUrl: "https://evil.example/cam-small.jpg",
    });
    const value = (reading["result"] as { value: Record<string, unknown> }).value;
    expect(value).not.toHaveProperty("imageUrl");
    expect(value).not.toHaveProperty("thumbnailUrl");
    expect(ctx.out.rejected).toBe(2);
    expect(sealFailures([reading])).toEqual([]);
  });

  test("a feed that declares no image hosts keeps its URLs; a URL that is no web URL is dropped", () => {
    const ctx = context();
    const kept = imageReading(caltransLike(), ctx, {
      cameraId: "1",
      viewKey: "0",
      status: "unknown",
      imageUrl: "https://anywhere.example/cam.jpg",
    });
    expect((kept["result"] as { value: Record<string, unknown> }).value).toMatchObject({
      imageUrl: "https://anywhere.example/cam.jpg",
    });
    const bad = imageReading(caltransLike(), ctx, {
      cameraId: "1",
      viewKey: "0",
      status: "unknown",
      imageUrl: "javascript:alert(1)",
      streamUrl: "rtsp://camera.example/live",
      streamType: "rtsp",
    });
    expect((bad["result"] as { value: Record<string, unknown> }).value).toEqual({
      v: 1,
      status: "unknown",
      streamUrl: "rtsp://camera.example/live",
      streamType: "rtsp",
    });
    expect(ctx.out.rejected).toBe(1);
  });
});
