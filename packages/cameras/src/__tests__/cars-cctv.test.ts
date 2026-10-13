import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-14T07:00:00Z";

const nyFeed = () =>
  cameraFeed("us", {
    operator: "511",
    subdivision: "ny",
    product: "cameras",
    name: "511NY cameras (New York)",
    tier: "authoritative",
    format: "cars-cctv",
    endpoints: {
      main: { url: "https://nysdot.carsprogram.org/hub/data/cctv.xml", cadenceSec: 900 },
    },
    credentials: { user: { title: "Username" }, password: { title: "Password" } },
    auth: { kind: "basic", user: "user", password: "password" },
    freshnessWindowSec: 3600,
    license: "LicenseRef-511NY-DAA",
    attribution: "511NY / New York State DOT",
    privacyUrl: "https://511ny.org/privacy",
    cameras: { imageHosts: ["public.carsprogram.org/cameras/NYSDOT/"] },
  });

const parse = () =>
  camerasDomain.formats["cars-cctv"]!.parse(
    nyFeed(),
    { main: [fixture("us-ny-511-cctv.xml")] },
    parseContext(FETCHED),
  );

describe("cars-cctv", () => {
  test("reads each camera with its one view, still and HLS stream", () => {
    const out = parse();
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:us-ny-511-cameras:90001",
      "oc:feature:us-ny-511-cameras:90002",
    ]);
    const [highway] = out.features;
    expect(highway).toMatchObject({
      kind: "camera",
      type: "traffic",
      name: [{ lang: "en", text: "I-90 MP 100.00 WB at Sample Interchange" }],
      operator: { role: "operator", name: [{ lang: "en", text: "NYSDOT" }] },
      location: {
        geometry: { type: "Point", coordinates: [-78.766229, 42.940992] },
        roads: [{ name: [{ lang: "en", text: "I-90" }] }],
      },
      details: { imageRedistribution: "link_only" },
    });
    expect(out.observations[0]!["result"]).toMatchObject({
      value: {
        status: "unknown",
        imageUrl: "https://public.carsprogram.org/cameras/NYSDOT/TEST_001.flv.png",
        streamUrl: "https://s51.nysdot.skyvdn.com/rtplive/TEST_001/playlist.m3u8",
        streamType: "hls",
      },
    });
  });

  test("names no road where the agency repeats the camera's name in its place", () => {
    const local = parse().features[1]!;
    expect((local["location"] as Record<string, unknown>)["roads"]).toBeUndefined();
  });

  test("leaves out a camera whose still is off the image hosts and which streams nothing", () => {
    expect(parse().rejected).toBe(1);
  });
});
