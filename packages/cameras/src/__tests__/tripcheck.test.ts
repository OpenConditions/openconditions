import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

const tripcheckFeed = (cameras: Record<string, unknown> = {}) =>
  cameraFeed("us", {
    subdivision: "or",
    operator: "tripcheck",
    product: "cameras",
    name: "ODOT TripCheck cameras",
    tier: "authoritative",
    format: "tripcheck",
    endpoints: {
      main: { url: "https://api.odot.state.or.us/tripcheck/Cctv/Inventory", cadenceSec: 3600 },
    },
    freshnessWindowSec: 7200,
    license: "LicenseRef-ODOT-TripCheck",
    attribution: "Oregon Department of Transportation",
    privacyUrl: "https://www.oregon.gov/pages/privacy.aspx",
    cameras: { imageHosts: ["tripcheck.com"], ...cameras },
  });

const parse = (payloads: FeedPayloads, cameras = {}): ParseOutput =>
  camerasDomain.formats["tripcheck"]!.parse(
    tripcheckFeed(cameras),
    payloads,
    parseContext(FETCHED, 3600),
  );

const doc = () => JSON.parse(fixture("us-or-tripcheck-cctv-inventory.json").toString("utf8"));
const body = (d: unknown): Buffer => Buffer.from(JSON.stringify(d));

const ID = "oc:feature:us-or-tripcheck-cameras:";
const camera = (out: ParseOutput, id: string) => out.features.find((f) => f["id"] === ID + id);
const readings = (out: ParseOutput, id: string) =>
  out.observations.filter((o) => (o["subject"] as { featureId: string }).featureId === ID + id);
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;
const views = (out: ParseOutput, id: string) =>
  camera(out, id)?.["components"] as { key: string; kind: string }[];

describe("tripcheck", () => {
  test("a camera is named, described and placed on its route", () => {
    const out = parse({ main: [fixture("us-or-tripcheck-cctv-inventory.json")] });
    expect(camera(out, "2240")).toMatchObject({
      type: "traffic",
      name: [{ lang: "en", text: "US 26 at Sylvan" }],
      location: {
        geometry: { coordinates: [-122.7205, 45.5118] },
        roads: [{ ref: "US26" }],
      },
      details: { kind: "camera", v: 1, imageRedistribution: "allowed" },
    });
    expect(camera(out, "1101")).toMatchObject({
      description: [{ lang: "en", text: "Looking south toward the Columbia Slough" }],
    });
    // An empty description is no description.
    expect(camera(out, "2240")).not.toHaveProperty("description");
  });

  test("a duplicate device-id becomes two views of one camera", () => {
    const out = parse({ main: [fixture("us-or-tripcheck-cctv-inventory.json")] });
    expect(out.features.map((f) => f["id"])).toEqual([`${ID}1101`, `${ID}2240`]);
    expect(views(out, "1101").map((v) => v.key)).toEqual([
      "I5_DeltaPark_pid1101.jpg",
      "I5_DeltaPark_pid1102.jpg",
    ]);
    expect(views(out, "2240").map((v) => v.key)).toEqual(["US26_Sylvan_pid2240.jpg"]);
    const r = readings(out, "1101");
    expect(r.map((o) => (o["subject"] as { componentKey: string }).componentKey)).toEqual([
      "I5_DeltaPark_pid1101.jpg",
      "I5_DeltaPark_pid1102.jpg",
    ]);
    expect(value(r[1])).toEqual({
      v: 1,
      status: "unknown",
      imageUrl: "https://tripcheck.com/RoadCams/cams/I5_DeltaPark_pid1102.jpg",
    });
  });

  test("the organisation is credited as the upstream publisher", () => {
    const out = parse({ main: [fixture("us-or-tripcheck-cctv-inventory.json")] });
    for (const record of [...out.features, ...out.observations]) {
      expect((record["provenance"] as { upstream?: unknown }).upstream).toEqual([
        { publisher: "Oregon Department of Transportation" },
      ]);
    }
  });

  test("the inventory's row time is no image time", () => {
    const out = parse({ main: [fixture("us-or-tripcheck-cctv-inventory.json")] });
    for (const o of out.observations) expect(value(o)).not.toHaveProperty("imageAt");
  });

  test("a row without a position or a device is rejected", () => {
    const d = doc();
    delete d["CCTVInventoryRequest"][2]["latitude"];
    delete d["CCTVInventoryRequest"][1]["device-id"];
    const out = parse({ main: [body(d)] });
    expect(out.features.map((f) => f["id"])).toEqual([`${ID}1101`]);
    expect(out.rejected).toBe(2);
  });

  test("a bad percent escape in one image address does not fail the parse", () => {
    const d = doc();
    d["CCTVInventoryRequest"][2]["cctv-url"] = "https://tripcheck.com/RoadCams/cams/b%E0%A4%A.jpg";
    const out = parse({ main: [body(d)] });
    expect(out.features.map((f) => f["id"])).toEqual([`${ID}1101`, `${ID}2240`]);
    expect(views(out, "2240").map((v) => v.key)).toEqual(["b%E0%A4%A.jpg"]);
    expect(views(out, "1101")).toHaveLength(2);
    expect(out.rejected ?? 0).toBe(0);
  });

  test("two images of a device that map to one view key keep the first and count the second", () => {
    for (const second of [
      "https://tripcheck.com/RoadCams/cams/I5_DeltaPark_pid1101.jpg?v=2",
      "https://tripcheck.com/RoadCams/cams/I5_Delta%23Park_pid1101.jpg",
    ]) {
      const d = doc();
      d["CCTVInventoryRequest"][0]["cctv-url"] = second.includes("%23")
        ? "https://tripcheck.com/RoadCams/cams/I5_Delta_Park_pid1101.jpg"
        : "https://tripcheck.com/RoadCams/cams/I5_DeltaPark_pid1101.jpg";
      d["CCTVInventoryRequest"][1]["cctv-url"] = second;
      const out = parse({ main: [body(d)] });
      expect(views(out, "1101")).toHaveLength(1);
      expect(readings(out, "1101")).toHaveLength(1);
      expect(out.rejected).toBe(1);
    }
  });

  test("an image off the declared hosts is dropped and counted", () => {
    const d = doc();
    d["CCTVInventoryRequest"][2]["cctv-url"] = "https://elsewhere.example/US26.jpg";
    const out = parse({ main: [body(d)] });
    expect(value(readings(out, "2240")[0])).toEqual({ v: 1, status: "unknown" });
    expect(out.rejected).toBe(1);
  });

  test("a body that is no inventory fails the parse", () => {
    expect(() =>
      parse({ main: [body({ message: "Invalid or missing API subscription key" })] }),
    ).toThrow();
  });

  test("every camera and reading seals", () => {
    const out = parse({ main: [fixture("us-or-tripcheck-cctv-inventory.json")] });
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });
});
