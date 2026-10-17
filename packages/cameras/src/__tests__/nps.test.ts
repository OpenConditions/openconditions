import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

const npsFeed = (cameras: Record<string, unknown> = {}) =>
  cameraFeed("us", {
    operator: "nps",
    product: "cameras",
    name: "National Park Service webcams",
    tier: "authoritative",
    format: "nps",
    endpoints: {
      main: { url: "https://developer.nps.gov/api/v1/webcams?limit=500", cadenceSec: 86400 },
    },
    freshnessWindowSec: 172800,
    license: "LicenseRef-US-Gov-Public-Domain",
    attribution: "National Park Service",
    privacyUrl: "https://www.nps.gov/aboutus/privacy.htm",
    ...(Object.keys(cameras).length === 0 ? {} : { cameras }),
  });

const parse = (payloads: FeedPayloads, cameras = {}): ParseOutput =>
  camerasDomain.formats["nps"]!.parse(npsFeed(cameras), payloads, parseContext(FETCHED, 86400));

const doc = () => JSON.parse(fixture("us-nps-webcams.json").toString("utf8"));
const body = (d: unknown): Buffer => Buffer.from(JSON.stringify(d));

const ID = "oc:feature:us-nps-cameras:";
const camera = (out: ParseOutput, id: string) => out.features.find((f) => f["id"] === ID + id);
const reading = (out: ParseOutput, id: string) =>
  out.observations.filter((o) => (o["subject"] as { featureId: string }).featureId === ID + id);
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;

const AIR = "81B464EA-1DD8-B71B-0B367470E91A4A7F";
const ANACAPA = "A1D747E2-D28F-7E9B-791E4F715D376D01";
const BIG_HOLE = "81B46554-1DD8-B71B-0BF6D4520C2357E9";
const NEWFOUND = "C589EEEF-1DD8-B71B-0B0463C308FF64DD";

describe("nps", () => {
  beforeEach(() => __resetSkips());

  test("a camera is its NPS page, typed landscape, without any image", () => {
    const out = parse({ main: [fixture("us-nps-webcams.json")] });
    expect(camera(out, ANACAPA)).toMatchObject({
      type: "landscape",
      name: [{ lang: "en", text: "Anacapa Island Webcam" }],
      location: { geometry: { coordinates: [-119.362184, 34.016535] } },
      details: {
        kind: "camera",
        v: 1,
        detailUrl:
          "https://www.nps.gov/media/webcam/view.htm?id=A1D747E2-D28F-7E9B-791E4F715D376D01",
        imageRedistribution: "allowed",
      },
    });
    expect(camera(out, ANACAPA)?.["components"]).toEqual([
      {
        key: "0",
        kind: "camera_view",
        details: {
          kind: "camera_view",
          v: 1,
          detailUrl:
            "https://www.nps.gov/media/webcam/view.htm?id=A1D747E2-D28F-7E9B-791E4F715D376D01",
          imageRedistribution: "allowed",
        },
      },
    ]);
    // The record's photo is a stock picture, not the camera's image: a site image,
    // its doubled host repaired.
    expect(value(reading(out, ANACAPA)[0])).toEqual({ v: 1, status: "unknown" });
    expect(camera(out, ANACAPA)?.["images"]).toEqual([
      {
        url: "https://www.nps.gov/common/uploads/cropped_image/FB433FDB-A01F-8F9F-5D030367A1EF247C.jpg",
        category: "site",
      },
    ]);
    expect(camera(out, ANACAPA)?.["location"]).toMatchObject({
      admin: { country: "US", subdivision: "US-CA" },
    });
  });

  test("a camera of parks in several states is placed in the country alone; a credit is its upstream", () => {
    const d = doc();
    // Constructed: every captured record's credit is empty.
    d.data[1].credit = "Channel Islands National Park Foundation";
    const out = parse({ main: [body(d)] });
    const smokies = out.features.find(
      (f) => f["id"] === `${ID}C589EEEF-1DD8-B71B-0B0463C308FF64DD`,
    );
    expect(smokies?.["location"]).toHaveProperty("admin", { country: "US" });
    expect(camera(out, ANACAPA)?.["provenance"]).toMatchObject({
      upstream: [{ publisher: "Channel Islands National Park Foundation" }],
    });
    expect(reading(out, ANACAPA)[0]?.["provenance"]).toMatchObject({
      upstream: [{ publisher: "Channel Islands National Park Foundation" }],
    });
    expect(camera(out, AIR)?.["provenance"]).not.toHaveProperty("upstream");
  });

  test("the air quality pages are weather cameras", () => {
    const out = parse({ main: [fixture("us-nps-webcams.json")] });
    expect(camera(out, AIR)).toMatchObject({ type: "weather" });
  });

  test("Inactive reads offline, Active unknown", () => {
    const out = parse({ main: [fixture("us-nps-webcams.json")] });
    expect(value(reading(out, BIG_HOLE)[0])?.["status"]).toBe("offline");
    expect(value(reading(out, AIR)[0])?.["status"]).toBe("unknown");
  });

  test("the park's status message rides with the reading; an empty one is none", () => {
    const out = parse({ main: [fixture("us-nps-webcams.json")] });
    expect(value(reading(out, BIG_HOLE)[0])?.["statusText"]).toEqual([
      { lang: "en", text: expect.stringMatching(/^Please excuse our mess!/) },
    ]);
    expect(value(reading(out, AIR)[0])).not.toHaveProperty("statusText");
  });

  test("records without coordinates are skipped and counted", () => {
    const out = parse({ main: [fixture("us-nps-webcams.json")] });
    expect(out.features.map((f) => f["id"])).not.toContain(
      `${ID}9603ED1D-F805-714D-AC4557683B558B00`,
    );
    expect(out.rejected ?? 0).toBe(0);
    expect(drainSkipped(npsFeed().id)).toEqual({ no_geometry: 1 });
    const d = doc();
    d.data[3].latitude = "";
    d.data[3].longitude = "";
    expect(parse({ main: [body(d)] }).features).toHaveLength(4);
  });

  test("a duplicated id collapses to its first record", () => {
    const out = parse({ main: [fixture("us-nps-webcams.json")] });
    expect(out.features.map((f) => f["id"])).toEqual([
      ID + AIR,
      ID + ANACAPA,
      ID + BIG_HOLE,
      ID + NEWFOUND,
    ]);
    expect(reading(out, NEWFOUND)).toHaveLength(1);
    expect(camera(out, NEWFOUND)).toMatchObject({
      type: "landscape",
      details: {
        detailUrl:
          "https://www.nps.gov/media/webcam/view.htm?id=C589EEEF-1DD8-B71B-0B0463C308FF64DD",
      },
    });
  });

  test("a doubled host in the page address is repaired", () => {
    const d = doc();
    d.data[1].url = "https://www.nps.govhttps://www.nps.gov/media/webcam/view.htm?id=X";
    const out = parse({ main: [body(d)] });
    expect(camera(out, ANACAPA)).toMatchObject({
      details: { detailUrl: "https://www.nps.gov/media/webcam/view.htm?id=X" },
    });
  });

  test("no reading ever carries an image address", () => {
    const out = parse({ main: [fixture("us-nps-webcams.json")] });
    for (const o of out.observations) {
      expect(value(o)).not.toHaveProperty("imageUrl");
      expect(value(o)).not.toHaveProperty("thumbnailUrl");
    }
  });

  test("the feed's own licence reading of the images wins", () => {
    const out = parse(
      { main: [fixture("us-nps-webcams.json")] },
      { imageRedistribution: "unknown" },
    );
    expect(camera(out, ANACAPA)).toMatchObject({ details: { imageRedistribution: "unknown" } });
  });

  test("a body that is no webcam list fails the parse", () => {
    expect(() => parse({ main: [body({ error: { code: "API_KEY_INVALID" } })] })).toThrow();
  });

  test("every camera and reading seals", () => {
    const out = parse({ main: [fixture("us-nps-webcams.json")] });
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  test("a record without an id is malformed; a status other than Active or Inactive an unknown value", () => {
    const d = doc();
    delete d.data[0].id;
    d.data[1].status = "Seasonal";
    const out = parse({ main: [body(d)] });
    expect(value(reading(out, ANACAPA)[0])?.["status"]).toBe("unknown");
    expect(drainSkipped(npsFeed().id)).toEqual({ malformed: 1, no_geometry: 1, unknown_value: 1 });
  });
});
