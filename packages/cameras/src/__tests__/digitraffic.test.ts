import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

/** A poll a minute after the data document was published. */
const FETCHED = "2026-10-08T07:16:00Z";

const HEADERS = { "Digitraffic-User": "OpenConditions/1.0", "Accept-Encoding": "gzip" };

/** Fintraffic's weather cameras: the station list, each station's details, and the image times. */
const digitrafficFeed = () =>
  cameraFeed("fi", {
    operator: "digitraffic",
    product: "cameras",
    name: "Digitraffic weather cameras",
    tier: "authoritative",
    format: "digitraffic",
    endpoints: {
      sites: {
        url: "https://tie.digitraffic.fi/api/weathercam/v1/stations",
        headers: HEADERS,
        cadenceSec: 86400,
      },
      details: {
        url: "https://tie.digitraffic.fi/api/weathercam/v1/stations/{item}",
        each: { role: "sites", records: "features", field: "id" },
        fanout: "tolerant",
        headers: HEADERS,
        cadenceSec: 86400,
      },
      status: {
        url: "https://tie.digitraffic.fi/api/weathercam/v1/stations/data",
        headers: HEADERS,
        cadenceSec: 600,
      },
    },
    requestLimits: { perMinute: 60 },
    freshnessWindowSec: 1800,
    license: "CC-BY-4.0",
    attribution: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
    privacyUrl: "https://www.digitraffic.fi/en/terms-of-service/",
    cameras: { imageHosts: ["weathercam.digitraffic.fi"] },
  });

const format = camerasDomain.formats["digitraffic"]!;

const payloads = (): FeedPayloads => ({
  sites: [fixture("fi-digitraffic-stations.json")],
  details: [
    fixture("fi-digitraffic-station-C01503.json"),
    fixture("fi-digitraffic-station-C01632.json"),
  ],
  status: [fixture("fi-digitraffic-data.json")],
});

const parse = (p: FeedPayloads = payloads(), fetchedAt = FETCHED): ParseOutput =>
  format.parse(digitrafficFeed(), p, parseContext(fetchedAt, 600));

const camera = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:fi-digitraffic-cameras:${id}`);
const reading = (out: { observations: RecordDraft[] }, preset: string) =>
  out.observations.find((o) => (o["subject"] as { componentKey: string }).componentKey === preset);
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;

describe("digitraffic", () => {
  test("a station is one weather camera with a view per preset, named from its details", () => {
    const out = parse();
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:fi-digitraffic-cameras:C01503",
      "oc:feature:fi-digitraffic-cameras:C01539",
      "oc:feature:fi-digitraffic-cameras:C01632",
    ]);
    const inkoo = camera(out, "C01503");
    expect(inkoo).toMatchObject({
      kind: "camera",
      type: "weather",
      name: [
        { lang: "fi", text: "Tie 51 Inkoo" },
        { lang: "sv", text: "Väg 51 Ingå" },
        { lang: "en", text: "Road 51 Inkoo" },
      ],
      location: {
        geometry: { type: "Point", coordinates: [23.99616, 60.05374] },
        roads: [{ ref: "51" }],
      },
      externalIds: [{ scheme: "provider", id: "C01503", authority: "fi-digitraffic-cameras" }],
      details: { kind: "camera", v: 1, refreshSec: 600, imageRedistribution: "allowed" },
    });
    expect(inkoo?.["components"]).toEqual([
      {
        key: "C0150301",
        kind: "camera_view",
        name: [{ lang: "fi", text: "Inkooseen" }],
        details: {
          kind: "camera_view",
          v: 1,
          direction: { value: "positive", basis: "road_reference" },
          imageRedistribution: "allowed",
        },
      },
      {
        key: "C0150302",
        kind: "camera_view",
        name: [{ lang: "fi", text: "Hankoon" }],
        details: {
          kind: "camera_view",
          v: 1,
          direction: { value: "negative", basis: "road_reference" },
          imageRedistribution: "allowed",
        },
      },
      // A special direction (the road surface) has no axis on the road.
      {
        key: "C0150309",
        kind: "camera_view",
        name: [{ lang: "fi", text: "Tienpinta" }],
        details: { kind: "camera_view", v: 1, imageRedistribution: "allowed" },
      },
    ]);

    expect(value(reading(out, "C0150301"))).toEqual({
      v: 1,
      status: "online",
      imageUrl: "https://weathercam.digitraffic.fi/C0150301.jpg",
      imageAt: "2026-10-08T07:13:44Z",
      thumbnailUrl: "https://weathercam.digitraffic.fi/C0150301.jpg?thumbnail=true",
    });
    expect(reading(out, "C0150301")).toMatchObject({
      property: "camera.image",
      phenomenonTime: { instant: "2026-10-08T07:13:44Z" },
      subject: { featureId: "oc:feature:fi-digitraffic-cameras:C01503", componentKey: "C0150301" },
    });
    expect(out.observations).toHaveLength(7);
    for (const o of out.observations) expect(o).not.toHaveProperty("validUntil");
  });

  test("presets out of collection and removed stations are offline; old images are stale", () => {
    const out = parse();
    // Out of collection, though its last image is from 2016.
    expect(value(reading(out, "C0163201"))?.["status"]).toBe("offline");
    expect(value(reading(out, "C0163202"))?.["status"]).toBe("online");
    expect(value(reading(out, "C0163209"))?.["status"]).toBe("offline");
    // Removed for now: offline, though no details were fetched for it.
    expect(value(reading(out, "C0153900"))?.["status"]).toBe("offline");
    // A station without details keeps its list name, in no stated language.
    expect(camera(out, "C01539")).toMatchObject({ name: [{ lang: "und", text: "VUO_SAT" }] });
    expect(camera(out, "C01539")?.["details"]).not.toHaveProperty("refreshSec");

    // Three collection intervals after the last image, it is stale.
    const later = parse(payloads(), "2026-10-08T07:44:00Z");
    expect(value(reading(later, "C0150302"))?.["status"]).toBe("online");
    expect(value(reading(later, "C0150301"))?.["status"]).toBe("stale");
  });

  test("only a GATHERING station reads online; a missing or other collection status is unknown", () => {
    const feed = digitrafficFeed();
    const ctx = parseContext(FETCHED, 600);
    for (const collectionStatus of [undefined, "SOMETHING_NEW"]) {
      const sites = JSON.parse(fixture("fi-digitraffic-stations.json").toString("utf8"));
      if (collectionStatus === undefined) delete sites.features[0].properties.collectionStatus;
      else sites.features[0].properties.collectionStatus = collectionStatus;
      const full = format.parse(
        feed,
        { ...payloads(), sites: [Buffer.from(JSON.stringify(sites))] },
        ctx,
      );
      const status = format.parseStatus!(
        feed,
        { status: [fixture("fi-digitraffic-data.json")] },
        ctx,
        full.statusIndex!,
      );
      for (const out of [full, status]) {
        // Its last image is current, but the station does not say it is collecting.
        expect(value(reading(out, "C0150301"))?.["status"], collectionStatus).toBe("unknown");
        // Another station, still GATHERING, is unaffected.
        expect(value(reading(out, "C0163202"))?.["status"], collectionStatus).toBe("online");
      }
    }
  });

  test("the camera type is the purpose the station's details state", () => {
    const out = parse();
    // `keli` (road weather) and `liikenne` (traffic).
    expect(camera(out, "C01503")?.["type"]).toBe("weather");
    expect(camera(out, "C01632")?.["type"]).toBe("traffic");
    // No details: a weather camera, as the service is one.
    expect(camera(out, "C01539")?.["type"]).toBe("weather");
  });

  test("a fault or a repair under way makes every view offline", () => {
    const sites = JSON.parse(fixture("fi-digitraffic-stations.json").toString("utf8"));
    sites.features[0].properties.state = "FAULT_CONFIRMED";
    const out = parse({ ...payloads(), sites: [Buffer.from(JSON.stringify(sites))] });
    for (const preset of ["C0150301", "C0150302", "C0150309"]) {
      expect(value(reading(out, preset))?.["status"]).toBe("offline");
    }
  });

  test("the status-only parse gives the full parse's readings; an unknown preset is rejected", () => {
    const feed = digitrafficFeed();
    const ctx = parseContext(FETCHED, 600);
    const full = format.parse(feed, payloads(), ctx);
    expect(full.statusIndex).toBeDefined();
    const status = format.parseStatus!(
      feed,
      { status: [fixture("fi-digitraffic-data.json")] },
      ctx,
      full.statusIndex!,
    );
    expect(status.observations).toEqual(full.observations);
    expect(status.rejected).toBe(0);

    const data = JSON.parse(fixture("fi-digitraffic-data.json").toString("utf8"));
    data.stations[0].presets.push({ id: "C9999901", measuredTime: "2026-10-08T07:10:00Z" });
    const unknown = format.parseStatus!(
      feed,
      { status: [Buffer.from(JSON.stringify(data))] },
      ctx,
      full.statusIndex!,
    );
    expect(unknown.rejected).toBe(1);
    expect(unknown.observations).toEqual(full.observations);
  });

  test("a malformed data document is rejected without failing the daily full parse", () => {
    const whole = parse();
    for (const body of ["{}", "not json", '{"stations": 3}']) {
      const out = parse({ ...payloads(), status: [Buffer.from(body)] });
      expect(out.rejected, body).toBe(1);
      expect(
        out.features.map((f) => f["id"]),
        body,
      ).toEqual(whole.features.map((f) => f["id"]));
      expect(out.observations, body).toHaveLength(whole.observations.length);
      // Without image times every preset is read as of the fetch, its state unknown
      // unless the station says it is offline.
      const inkoo = reading(out, "C0150301");
      expect(value(inkoo), body).toEqual({
        v: 1,
        status: "unknown",
        imageUrl: "https://weathercam.digitraffic.fi/C0150301.jpg",
        thumbnailUrl: "https://weathercam.digitraffic.fi/C0150301.jpg?thumbnail=true",
      });
      expect(inkoo, body).toMatchObject({ phenomenonTime: { instant: FETCHED } });
    }
    // The status-only parse has nothing else to read: there a malformed document fails.
    expect(() =>
      format.parseStatus!(
        digitrafficFeed(),
        { status: [Buffer.from("{}")] },
        parseContext(FETCHED, 600),
        whole.statusIndex!,
      ),
    ).toThrow(/carries no stations/);
  });

  test("every camera and reading seals", () => {
    const out = parse();
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });
});
