import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
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
        roads: [{ name: [{ lang: "zh-Hant", text: "國道1號" }] }],
      },
      externalIds: [{ scheme: "provider", id: "CCTV-N1-S-0.000-M", authority: "tw-tdx-cameras" }],
      details: { kind: "camera", v: 1, imageRedistribution: "unknown" },
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
});
