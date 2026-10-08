import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { matchesImageHost } from "../camera.js";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

const S3_HOST = "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/";

const tflFeed = (cameras: Record<string, unknown> = {}) =>
  cameraFeed("gb", {
    subdivision: "eng",
    operator: "tfl",
    product: "cameras",
    name: "TfL JamCams",
    tier: "authoritative",
    format: "tfl",
    endpoints: { main: { url: "https://api.tfl.gov.uk/Place/Type/JamCam", cadenceSec: 3600 } },
    freshnessWindowSec: 86400,
    license: "LicenseRef-TfL-Transport-Data-Service",
    attribution: "Powered by TfL Open Data",
    privacyUrl: "https://tfl.gov.uk/corporate/privacy-and-cookies/",
    cameras: { imageHosts: [S3_HOST], ...cameras },
  });

const parse = (payloads: FeedPayloads, cameras = {}): ParseOutput =>
  camerasDomain.formats["tfl"]!.parse(tflFeed(cameras), payloads, parseContext(FETCHED, 3600));

const list = () => JSON.parse(fixture("gb-eng-tfl-jamcams.json").toString("utf8"));
const body = (doc: unknown): Buffer => Buffer.from(JSON.stringify(doc));

type Place = { additionalProperties: { key: string; value: string; modified?: string }[] };
/** A place's additional property of `key`, which a case mutates. */
const property = (place: Place, key: string) =>
  place.additionalProperties.find((p) => p.key === key) ?? expect.unreachable(`no ${key}`);

const ID = "oc:feature:gb-eng-tfl-cameras:JamCams_";
const camera = (out: ParseOutput, id: string) => out.features.find((f) => f["id"] === ID + id);
const reading = (out: ParseOutput, id: string) =>
  out.observations.find((o) => (o["subject"] as { featureId: string }).featureId === ID + id);
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;
const view = (out: ParseOutput, id: string) =>
  (
    camera(out, id)?.["components"] as
      | { name?: unknown; details: Record<string, unknown> }[]
      | undefined
  )?.[0] ?? expect.unreachable(`no camera ${id}`);

describe("tfl", () => {
  test("a camera reads its properties by key, with the clip as an mp4 stream", () => {
    const out = parse({ main: [fixture("gb-eng-tfl-jamcams.json")] });
    expect(out.features.map((f) => f["id"])).toEqual([
      `${ID}00002.00876`,
      `${ID}00001.07929`,
      `${ID}00001.02255`,
    ]);
    expect(camera(out, "00002.00876")).toMatchObject({
      type: "traffic",
      name: [{ lang: "en", text: "Fore St West Ramp" }],
      location: { geometry: { coordinates: [-0.0733, 51.61461] } },
      details: { kind: "camera", v: 1, refreshSec: 180, imageRedistribution: "allowed" },
    });
    expect(value(reading(out, "00002.00876"))).toEqual({
      v: 1,
      status: "unknown",
      imageUrl: "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00876.jpg",
      streamUrl: "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00876.mp4",
      streamType: "mp4",
    });
  });

  test("available=false reads offline", () => {
    const out = parse({ main: [fixture("gb-eng-tfl-jamcams.json")] });
    expect(value(reading(out, "00001.07929"))?.["status"]).toBe("offline");
    expect(value(reading(out, "00001.02255"))?.["status"]).toBe("unknown");
  });

  test("the S3 path URL passes the declared host and another bucket does not", () => {
    const hosts = [S3_HOST];
    expect(
      matchesImageHost(
        "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00876.jpg",
        hosts,
      ),
    ).toBe(true);
    expect(matchesImageHost("https://s3-eu-west-1.amazonaws.com/other-bucket/x.jpg", hosts)).toBe(
      false,
    );
    const doc = list();
    property(doc[0], "imageUrl").value = "https://s3-eu-west-1.amazonaws.com/other-bucket/x.jpg";
    const out = parse({ main: [body(doc)] });
    expect(value(reading(out, "00002.00876"))).not.toHaveProperty("imageUrl");
    expect(out.rejected).toBe(1);
  });

  test("the view's name is its text; a compass direction only for a single compass word", () => {
    const out = parse({ main: [fixture("gb-eng-tfl-jamcams.json")] });
    expect(view(out, "00002.00876")).toMatchObject({
      key: "0",
      name: [{ lang: "en", text: "East Facing (Home)" }],
      details: { direction: { value: "unknown", basis: "compass", compass: "E" } },
    });
    // A road, a junction and a direction together say nothing certain of where it looks.
    expect(view(out, "00001.02255").details["direction"]).toEqual({
      value: "unknown",
      basis: "text",
      text: "WEST-A13 Commercial Rd twds Whitechapel",
    });
    for (const [text, compass] of [
      ["North", "N"],
      ["west facing", "W"],
      ["South East", "SE"],
    ] as const) {
      const doc = list();
      property(doc[0], "view").value = text;
      expect(view(parse({ main: [body(doc)] }), "00002.00876").details["direction"]).toEqual({
        value: "unknown",
        basis: "compass",
        compass,
      });
    }
  });

  test("no camera claims ptz: the view text is not a statement of it", () => {
    const out = parse({ main: [fixture("gb-eng-tfl-jamcams.json")] });
    for (const f of out.features) expect(f["details"]).not.toHaveProperty("ptz");
  });

  test("a property's modified is the record's edit time, never the image time", () => {
    // Live on 2026-10-08 the still of JamCams_00001.03609 was minutes old
    // while every one of its properties said modified 2026-10-08T03:29Z, and
    // about 300 cameras still said 2026-09-24 or 2026-09-30.
    const doc = list();
    property(doc[2], "imageUrl").modified = "2026-10-08T06:59:00Z";
    const out = parse({ main: [body(doc)] });
    for (const r of out.observations) {
      expect(value(r)).not.toHaveProperty("imageAt");
      // The reading is as of the fetch, not of the record's edit.
      expect(r["phenomenonTime"]).toEqual({ instant: FETCHED });
    }
  });

  test("a record without a position is rejected", () => {
    const doc = list();
    delete doc[1].lat;
    const out = parse({ main: [body(doc)] });
    expect(out.features).toHaveLength(2);
    expect(out.rejected).toBe(1);
  });

  test("a body that is no place list fails the parse", () => {
    expect(() => parse({ main: [body({ message: "Not found" })] })).toThrow();
  });

  test("every camera and reading seals", () => {
    const out = parse({ main: [fixture("gb-eng-tfl-jamcams.json")] });
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });
});
