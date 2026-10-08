import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

/** The cell 0.25 degrees wide around Innsbruck: the third webcam lies south of it. */
const INNSBRUCK = { id: "0.25/45/189", west: 11.25, south: 47.25, east: 11.5, north: 47.5 };

const windyFeed = (cameras: Record<string, unknown> = {}) =>
  cameraFeed("global", {
    operator: "windy",
    product: "cameras",
    name: "Windy webcams",
    tier: "aggregator",
    format: "windy",
    endpoints: {
      main: {
        url: "https://api.windy.com/webcams/api/v3/webcams?bbox={north},{east},{south},{west}&limit=50&include=categories,images,location,player,urls&lang=en",
        cadenceSec: 540,
      },
    },
    freshnessWindowSec: 1080,
    accessMode: "on_demand",
    onDemand: { cellDeg: 0.25, maxCellsPerRead: 16, probe: [11.39, 47.27], ttlSec: 540 },
    coverage: { bbox: [-180, -90, 180, 90] },
    license: "NOASSERTION",
    attribution: "Webcams provided by windy.com",
    privacyUrl: "https://www.windy.com/privacy",
    cameras: { imageHosts: ["images-webcams.windy.com"], ...cameras },
  });

const page = () => JSON.parse(fixture("windy-webcams.json").toString("utf8"));
const body = (doc: unknown): Buffer => Buffer.from(JSON.stringify(doc));

const parse = (payloads: FeedPayloads, withCell = false, cameras = {}): ParseOutput =>
  camerasDomain.formats["windy"]!.parse(windyFeed(cameras), payloads, {
    ...parseContext(FETCHED, 540),
    ...(withCell ? { cell: INNSBRUCK } : {}),
  });

const camera = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:windy-cameras:${id}`);
const reading = (out: ParseOutput, id: string) =>
  out.observations.find(
    (o) => (o["subject"] as { featureId: string }).featureId === `oc:feature:windy-cameras:${id}`,
  );
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;

describe("windy", () => {
  test("an active camera reads online with its categories' type, links and images", () => {
    const out = parse({ main: [fixture("windy-webcams.json")] });
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:windy-cameras:1179853135",
      "oc:feature:windy-cameras:1179853136",
      "oc:feature:windy-cameras:1179853137",
    ]);
    expect(camera(out, "1179853135")).toMatchObject({
      type: "traffic",
      name: [{ lang: "und", text: "Innsbruck: Maria-Theresien-Strasse" }],
      location: { geometry: { coordinates: [11.4041, 47.2692] } },
      details: {
        kind: "camera",
        v: 1,
        imageRedistribution: "link_only",
        detailUrl: "https://www.windy.com/webcams/1179853135",
        // The timelapse is preferred to the live player.
        playerEmbedUrl:
          "https://webcams.windy.com/webcams/public//player?webcamId=1179853135&playerType=day",
      },
    });
    // The view carries Windy's page and terms itself: a canonical camera that
    // lists it under another survivor must still link the image to Windy.
    expect(camera(out, "1179853135")?.["components"]).toEqual([
      {
        key: "0",
        kind: "camera_view",
        details: {
          kind: "camera_view",
          v: 1,
          detailUrl: "https://www.windy.com/webcams/1179853135",
          imageRedistribution: "link_only",
        },
      },
    ]);
    expect(value(reading(out, "1179853135"))).toEqual({
      v: 1,
      status: "online",
      imageUrl:
        "https://images-webcams.windy.com/35/1179853135/current/preview/1179853135.jpg?token=sample",
      thumbnailUrl:
        "https://images-webcams.windy.com/35/1179853135/current/thumbnail/1179853135.jpg?token=sample",
      imageAt: "2026-10-08T06:50:00Z",
    });
  });

  test("the type is the first known category; none reads other", () => {
    const out = parse({ main: [fixture("windy-webcams.json")] });
    expect(camera(out, "1179853136")).toMatchObject({ type: "landscape" });
    expect(camera(out, "1179853137")).toMatchObject({ type: "other" });
    const doc = page();
    doc.webcams[0].categories = [
      { id: "unheard-of", name: "?" },
      { id: "beach", name: "Beach" },
    ];
    expect(camera(parse({ main: [body(doc)] }), "1179853135")).toMatchObject({ type: "beach" });
  });

  test("the inactive camera reads offline", () => {
    const out = parse({ main: [fixture("windy-webcams.json")] });
    expect(value(reading(out, "1179853136"))?.["status"]).toBe("offline");
    // Its timelapse still serves: the live player is absent and the day one stands.
    expect(camera(out, "1179853136")).toMatchObject({
      details: {
        playerEmbedUrl:
          "https://webcams.windy.com/webcams/public//player?webcamId=1179853136&playerType=day",
      },
    });
  });

  test("an active camera not updated for a day reads stale; one without a time unknown", () => {
    const doc = page();
    doc.webcams[0].lastUpdatedOn = "2026-10-07T06:59:00.000Z";
    delete doc.webcams[2].lastUpdatedOn;
    const out = parse({ main: [body(doc)] });
    expect(value(reading(out, "1179853135"))?.["status"]).toBe("stale");
    expect(value(reading(out, "1179853137"))?.["status"]).toBe("unknown");
    expect(value(reading(out, "1179853137"))).not.toHaveProperty("imageAt");
  });

  test("a status that is no camera is skipped", () => {
    const doc = page();
    for (const [i, status] of ["unapproved", "rejected", "duplicate"].entries()) {
      doc.webcams[i].status = status;
    }
    const out = parse({ main: [body(doc)] });
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
  });

  test("a camera outside the cell is dropped", () => {
    const out = parse({ main: [fixture("windy-webcams.json")] }, true);
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:windy-cameras:1179853135",
      "oc:feature:windy-cameras:1179853136",
    ]);
    expect(out.observations).toHaveLength(2);
  });

  test("a camera on two pages is read once", () => {
    const out = parse({ main: [fixture("windy-webcams.json"), fixture("windy-webcams.json")] });
    expect(out.features).toHaveLength(3);
    expect(out.observations).toHaveLength(3);
  });

  test("the feed's own licence reading of the images wins", () => {
    const out = parse({ main: [fixture("windy-webcams.json")] }, false, {
      imageRedistribution: "unknown",
    });
    expect(camera(out, "1179853135")).toMatchObject({
      details: { imageRedistribution: "unknown" },
    });
  });

  test("an image off the declared hosts is dropped and counted", () => {
    const doc = page();
    doc.webcams[0].images.current.preview = "https://elsewhere.example/p.jpg";
    const out = parse({ main: [body(doc)] });
    expect(value(reading(out, "1179853135"))).not.toHaveProperty("imageUrl");
    expect(out.rejected).toBe(1);
  });

  test("a camera without a position is rejected", () => {
    const doc = page();
    delete doc.webcams[0].location;
    const out = parse({ main: [body(doc)] });
    expect(out.features).toHaveLength(2);
    expect(out.rejected).toBe(1);
  });

  test("a page that is no webcam list fails the parse", () => {
    expect(() => parse({ main: [body({ message: "Forbidden" })] })).toThrow();
  });

  test("every camera and reading seals", () => {
    const out = parse({ main: [fixture("windy-webcams.json")] });
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });
});
