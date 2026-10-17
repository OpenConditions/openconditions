import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
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
  beforeEach(() => __resetSkips());

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
        linear: { system: "provider", ref: "I-90", from: 75.12460010451436, authority: "cars" },
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

  test("every still is a view; link direction, presets and range are read", () => {
    // Constructed from the schema (CCTV.xsd, FEU-g.xsd): the captured items carry
    // one still each and no direction, presets or range.
    const item = (id: string, extra: string, direction?: string) =>
      `<inventory-item><device-id>${id}</device-id><device-name>Cam ${id}</device-name><still-images><still-image><name>Cam ${id}</name><url>https://public.carsprogram.org/cameras/NYSDOT/${id}_a.png</url></still-image><still-image><name>Looking north</name><url>https://public.carsprogram.org/cameras/NYSDOT/${id}_b.png</url></still-image></still-images><location><geo-location><latitude>42940992</latitude><longitude>-78766229</longitude></geo-location><route-designator>I-90</route-designator>${direction === undefined ? "" : `<link-direction>${direction}</link-direction>`}</location>${extra}</inventory-item>`;
    const xml = Buffer.from(
      `<cctvInventories><cctvInventory><owner><organization-name>NYSDOT</organization-name></owner><inventory>${[
        item("1", "<presets><preset><preset-id>1</preset-id></preset></presets>", "ne"),
        item("2", "<range><zoom-limit>10</zoom-limit></range>", "positive direction"),
        item("3", "", "11"),
        item("4", "", "not directional"),
        item("5", "", "upstream"),
      ].join("")}</inventory></cctvInventory></cctvInventories>`,
    );
    const out = camerasDomain.formats["cars-cctv"]!.parse(
      nyFeed(),
      { main: [xml] },
      parseContext(FETCHED),
    );
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(drainSkipped(nyFeed().id)).toEqual({ unknown_value: 1 });
    const [first, second, third, fourth, fifth] = out.features;
    expect(first?.["components"]).toEqual([
      { key: "0", kind: "camera_view", details: expect.any(Object) },
      {
        key: "1",
        kind: "camera_view",
        name: [{ lang: "en", text: "Looking north" }],
        details: expect.any(Object),
      },
    ]);
    expect(out.observations).toHaveLength(10);
    expect(
      out.observations
        .map((o) => (o["result"] as { value: { imageUrl: string } }).value.imageUrl)
        .slice(0, 2),
    ).toEqual([
      "https://public.carsprogram.org/cameras/NYSDOT/1_a.png",
      "https://public.carsprogram.org/cameras/NYSDOT/1_b.png",
    ]);
    const direction = (f: typeof first) =>
      (f?.["location"] as Record<string, unknown> | undefined)?.["direction"];
    expect(direction(first)).toEqual({ value: "unknown", basis: "compass", compass: "NE" });
    expect(direction(second)).toEqual({ value: "positive", basis: "road_reference" });
    expect(direction(third)).toEqual({ value: "negative", basis: "road_reference" });
    expect(direction(fourth)).toBeUndefined();
    expect(direction(fifth)).toBeUndefined();
    expect(first?.["details"]).toMatchObject({ ptz: true });
    expect(second?.["details"]).toMatchObject({ ptz: true });
    expect(third?.["details"]).not.toHaveProperty("ptz");
  });

  test("names no road where the agency repeats the camera's name in its place", () => {
    const local = parse().features[1]!;
    expect((local["location"] as Record<string, unknown>)["roads"]).toBeUndefined();
  });

  test("leaves out a camera whose still is off the image hosts and which streams nothing", () => {
    expect(parse().rejected).toBe(1);
  });

  test("an item without a device id is malformed, one without a position has no geometry", () => {
    const xml = Buffer.from(
      "<cctvInventories><cctvInventory><inventory><inventory-item><device-name>No id</device-name></inventory-item><inventory-item><device-id>7</device-id><video-url>https://example.org/7.m3u8</video-url></inventory-item></inventory></cctvInventory></cctvInventories>",
    );
    const out = camerasDomain.formats["cars-cctv"]!.parse(
      nyFeed(),
      { main: [xml] },
      parseContext(FETCHED),
    );
    expect(out.features).toEqual([]);
    expect(out.rejected ?? 0).toBe(0);
    expect(drainSkipped(nyFeed().id)).toEqual({ malformed: 1, no_geometry: 1 });
  });
});
