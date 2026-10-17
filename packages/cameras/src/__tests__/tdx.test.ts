import {
  __resetSkips,
  drainSkipped,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

/** TDX's freeway and highway CCTV lists, one request each. */
const tdxFeed = () =>
  cameraFeed("tw", {
    operator: "tdx",
    product: "cameras",
    name: "TDX road CCTV",
    tier: "authoritative",
    format: "tdx",
    endpoints: {
      main: {
        urls: [
          "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Freeway?$top=10000&$format=JSON",
          "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Highway?$top=10000&$format=JSON",
        ],
        fanout: "tolerant",
        cadenceSec: 86400,
      },
    },
    credentials: {
      client_id: { title: "Client ID" },
      client_secret: { title: "Client secret" },
    },
    auth: {
      kind: "oauth2-client-credentials",
      tokenUrl: "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token",
      clientId: "client_id",
      clientSecret: "client_secret",
    },
    requestLimits: { perMinute: 5 },
    freshnessWindowSec: 172800,
    license: "OGDL-Taiwan-1.0",
    attribution: "交通部TDX平臺",
    privacyUrl: "https://tdx.transportdata.tw/term",
    cameras: { imageHosts: ["*.thb.gov.tw"] },
  });

function parse(): ParseOutput {
  return camerasDomain.formats["tdx"]!.parse(
    tdxFeed(),
    { main: [fixture("tw-tdx-cctv-freeway.json"), fixture("tw-tdx-cctv-highway.json")] },
    parseContext(FETCHED, 86400),
  );
}

const camera = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:tw-tdx-cameras:${id}`);
const reading = (out: ParseOutput, id: string) =>
  out.observations.find(
    (o) => (o["subject"] as { featureId: string }).featureId === `oc:feature:tw-tdx-cameras:${id}`,
  );
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;
const viewDetails = (draft: RecordDraft | undefined) =>
  ((draft?.["components"] ?? []) as { details: Record<string, unknown> }[])[0]?.details;

describe("tdx", () => {
  beforeEach(() => __resetSkips());

  test("a freeway camera has only its MJPEG stream", () => {
    const out = parse();
    expect(out.features).toHaveLength(5);
    const n1 = camera(out, "CCTV-N1-S-0.000-M");
    expect(n1).toMatchObject({
      type: "traffic",
      // No description: the road and its kilometre mark name it.
      name: [{ lang: "zh-Hant", text: "國道1號 0K+000" }],
      location: {
        geometry: { coordinates: [121.735695, 25.1229931] },
        roads: [
          {
            name: [{ lang: "zh-Hant", text: "國道1號" }],
            class: "motorway",
            from: "基隆端",
            to: "基隆交流道",
            kmFrom: 0,
          },
        ],
        external: [
          { system: "tw:link", code: "0000100000000C" },
          { system: "tw:road", code: "000010" },
        ],
      },
      externalIds: [{ scheme: "provider", id: "CCTV-N1-S-0.000-M", authority: "tw-tdx-cameras" }],
      details: { kind: "camera", v: 1, provider: "NFB-NR", imageRedistribution: "unknown" },
    });
    // Roadside (1) is no mounting the model holds.
    expect(n1?.["details"]).not.toHaveProperty("mounting");
    expect(camera(out, "CCTV-14-0620-009-002")?.["location"]).toMatchObject({
      roads: [{ class: "trunk", kmFrom: 9.02 }],
    });
    expect(viewDetails(n1)).toEqual({
      kind: "camera_view",
      v: 1,
      direction: { value: "unknown", basis: "compass", compass: "S" },
      imageRedistribution: "unknown",
    });
    expect(value(reading(out, "CCTV-N1-S-0.000-M"))).toEqual({
      v: 1,
      status: "unknown",
      streamUrl: "https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000",
      streamType: "mjpeg",
    });
  });

  test("a highway camera has a snapshot on a THB host beside its stream", () => {
    const out = parse();
    const t62 = camera(out, "CCTV-14-0620-009-002");
    expect(t62).toMatchObject({
      name: [{ lang: "zh-Hant", text: "快速公路62號(暖暖交流道到大華系統交流道)(W)" }],
    });
    expect(value(reading(out, "CCTV-14-0620-009-002"))).toEqual({
      v: 1,
      status: "unknown",
      imageUrl: "https://cctv-ss02.thb.gov.tw:443/T62-9K+020/snapshot",
      streamUrl: "https://cctv-ss02.thb.gov.tw:443/T62-9K+020",
      streamType: "mjpeg",
    });
    // "A" (all directions) is no compass direction.
    expect(viewDetails(camera(out, "CCTV-25-0080-080-001"))).toEqual({
      kind: "camera_view",
      v: 1,
      imageRedistribution: "unknown",
    });
    // A freeway-bureau camera on the highway list streams only.
    expect(value(reading(out, "CCTV-T74-E-0.610-M"))).not.toHaveProperty("imageUrl");
    expect(out.rejected ?? 0).toBe(0);
  });

  test("every camera and reading seals", () => {
    const out = parse();
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  test("a road direction other than a compass point or A is an unknown value", () => {
    const doc = JSON.parse(fixture("tw-tdx-cctv-freeway.json").toString("utf8"));
    doc.CCTVs[0].RoadDirection = "X";
    const out = camerasDomain.formats["tdx"]!.parse(
      tdxFeed(),
      { main: [Buffer.from(JSON.stringify(doc))] },
      parseContext(FETCHED, 86400),
    );
    expect(out.features).toHaveLength(doc.CCTVs.length);
    expect(drainSkipped(tdxFeed().id)).toEqual({ unknown_value: 1 });
  });

  test("a gantry, a ramp and the reference pictures are read; undocumented codes are counted", () => {
    // Constructed from TDX's CCTV schema: the captured records carry no
    // gantry, ramp, reference pictures or layout sketch.
    const doc = JSON.parse(fixture("tw-tdx-cctv-freeway.json").toString("utf8"));
    Object.assign(doc.CCTVs[0], {
      LocationType: 4,
      RoadClass: 7,
      LookingViews: [{ Bearing: "S", Image: "https://cctv.thb.gov.tw/ref/10000-S.jpg" }],
      // Off the feed's image hosts: dropped, as a still there would be.
      LayoutMapURL: "https://cctvn.freeway.gov.tw/layout/10000.png",
    });
    Object.assign(doc.CCTVs[1], { LocationType: 9, RoadClass: 8 });
    const out = camerasDomain.formats["tdx"]!.parse(
      tdxFeed(),
      { main: [Buffer.from(JSON.stringify(doc))] },
      parseContext(FETCHED, 86400),
    );
    expect(sealFailures(out.features)).toEqual([]);
    expect(drainSkipped(tdxFeed().id)).toEqual({ unknown_value: 2 });
    const [gantry, other] = out.features;
    expect(gantry).toMatchObject({
      details: { mounting: "gantry" },
      location: { roads: [{ carriageway: "ramp" }] },
      images: [{ url: "https://cctv.thb.gov.tw/ref/10000-S.jpg", category: "other" }],
    });
    expect(gantry?.["images"]).toHaveLength(1);
    expect(gantry?.["location"]).not.toHaveProperty("roads.0.class");
    expect(other?.["details"]).not.toHaveProperty("mounting");
    expect(other?.["location"]).toHaveProperty("roads.0.name");
    expect(other?.["location"]).not.toHaveProperty("roads.0.class");
  });
});
