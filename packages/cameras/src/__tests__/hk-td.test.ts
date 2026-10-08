import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

const BASE = "https://static.data.gov.hk/td/traffic-snapshot-images/code";

/** The Transport Department's snapshot camera list, in English and in Traditional Chinese. */
const hkFeed = () =>
  cameraFeed("hk", {
    operator: "td",
    product: "cameras",
    name: "Transport Department traffic snapshot cameras",
    tier: "authoritative",
    format: "hk-td",
    endpoints: {
      main: { url: `${BASE}/Traffic_Camera_Locations_En.xml`, cadenceSec: 86400 },
      names: { url: `${BASE}/Traffic_Camera_Locations_Tc.xml`, cadenceSec: 86400 },
    },
    freshnessWindowSec: 172800,
    license: "LicenseRef-HK-Gov-Open-Data",
    attribution: "Transport Department, HKSAR",
    privacyUrl: "https://data.gov.hk/en/privacy-policy",
    cameras: { imageHosts: ["tdcctv.data.one.gov.hk"] },
  });

const parse = (payloads: FeedPayloads): ParseOutput =>
  camerasDomain.formats["hk-td"]!.parse(hkFeed(), payloads, parseContext(FETCHED, 86400));

const camera = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:hk-td-cameras:${id}`);
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;

describe("hk-td", () => {
  test("a camera is named in English and Traditional Chinese, with its one still", () => {
    const out = parse({
      main: [fixture("hk-td-cameras-en.xml")],
      names: [fixture("hk-td-cameras-tc.xml")],
    });
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:hk-td-cameras:H429F",
      "oc:feature:hk-td-cameras:H210F",
      "oc:feature:hk-td-cameras:AID01101",
    ]);
    expect(camera(out, "H429F")).toMatchObject({
      type: "traffic",
      // The key the publisher appends to every description is no part of the name.
      name: [
        { lang: "en", text: "Aberdeen Praya Road near Fish Market" },
        { lang: "zh-Hant", text: "香港仔海傍道近魚市場" },
      ],
      location: { geometry: { coordinates: [114.1505, 22.24845] } },
      // The department publishes that each snapshot is renewed every two minutes.
      details: { kind: "camera", v: 1, refreshSec: 120, imageRedistribution: "allowed" },
    });
    expect(camera(out, "H429F")?.["components"]).toEqual([
      {
        key: "0",
        kind: "camera_view",
        details: { kind: "camera_view", v: 1, imageRedistribution: "allowed" },
      },
    ]);
    expect(value(out.observations[0])).toEqual({
      v: 1,
      status: "unknown",
      imageUrl: "https://tdcctv.data.one.gov.hk/H429F.JPG",
    });
    // A camera the Chinese list does not carry keeps its English name.
    expect(camera(out, "H210F")?.["name"]).toEqual([
      { lang: "en", text: "Aberdeen Tunnel - Wan Chai Side" },
    ]);
  });

  test("without the Chinese list the cameras are named in English", () => {
    const out = parse({ main: [fixture("hk-td-cameras-en.xml")] });
    expect(camera(out, "AID01101")?.["name"]).toEqual([
      { lang: "en", text: "Aberdeen Praya Road near Abba House - Eastbound" },
    ]);
  });

  test("every camera and reading seals", () => {
    const out = parse({
      main: [fixture("hk-td-cameras-en.xml")],
      names: [fixture("hk-td-cameras-tc.xml")],
    });
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });
});
