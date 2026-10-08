import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

/** An IBI 511 system's camera list, read with the system's developer key. */
const ibiFeed = (
  region: string,
  subdivision: string,
  host: string,
  cameras: Record<string, unknown>,
  license = "NOASSERTION",
) =>
  cameraFeed(region, {
    operator: "511",
    subdivision,
    product: "cameras",
    name: `${host} cameras`,
    tier: "authoritative",
    format: "ibi511",
    endpoints: {
      main: { url: `https://${host}/api/v2/get/cameras?format=json`, cadenceSec: 900 },
    },
    credentials: { api_key: { title: "Developer key" } },
    auth: { kind: "query-key", param: "key", credential: "api_key" },
    requestLimits: { perMinute: 10, keyScope: "instance" },
    freshnessWindowSec: 3600,
    license,
    attribution: host,
    privacyUrl: `https://${host}/about/privacy`,
    cameras,
  });

const ontarioFeed = () =>
  ibiFeed(
    "ca",
    "on",
    "511on.ca",
    // No licence is published for the images: Ontario's are neither link-only nor free.
    { imageHosts: ["511on.ca"], imageRedistribution: "unknown" },
    "LicenseRef-OGL-ON",
  );
const georgiaFeed = () => ibiFeed("us", "ga", "511ga.org", { imageHosts: ["511ga.org"] });
const idahoFeed = () => ibiFeed("us", "id", "511.idaho.gov", { imageHosts: ["511.idaho.gov"] });
const louisianaFeed = () => ibiFeed("us", "la", "511la.org", { imageHosts: ["511la.org"] });

const parse = (feed: CamerasCatalogFeed, name: string): ParseOutput =>
  camerasDomain.formats["ibi511"]!.parse(feed, { main: [fixture(name)] }, parseContext(FETCHED));

const camera = (out: ParseOutput, feedId: string, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:${feedId}:${id}`);
const readings = (out: ParseOutput, feedId: string, id: string) =>
  out.observations.filter(
    (o) => (o["subject"] as { featureId: string }).featureId === `oc:feature:${feedId}:${id}`,
  );
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;
const componentKey = (r: RecordDraft) => (r["subject"] as { componentKey: string }).componentKey;
const viewDetails = (draft: RecordDraft | undefined) =>
  ((draft?.["components"] ?? []) as { details: Record<string, unknown> }[])[0]?.details;

describe("ibi511", () => {
  test("an Ontario camera keeps its three views, each with its own reading", () => {
    const out = parse(ontarioFeed(), "ca-on-511-cameras.json");
    expect(out.features).toHaveLength(3);
    const qew = camera(out, "ca-on-511-cameras", "1");
    expect(qew).toMatchObject({
      type: "traffic",
      name: [{ lang: "en", text: "QEW West of Thompson Road" }],
      location: {
        geometry: { coordinates: [-78.9580061508579, 42.9142736713825] },
        roads: [{ name: [{ lang: "en", text: "QEW" }] }],
      },
      externalIds: [
        { scheme: "provider", id: "1", authority: "ca-on-511-cameras" },
        { scheme: "provider", id: "CR-1", authority: "ca-on-511-cameras/RWIS (MTO)" },
      ],
      details: { kind: "camera", v: 1, provider: "RWIS (MTO)", imageRedistribution: "unknown" },
    });
    expect(qew?.["components"]).toEqual([
      {
        key: "1",
        kind: "camera_view",
        name: [{ lang: "en", text: "Toronto Bound" }],
        details: { kind: "camera_view", v: 1, imageRedistribution: "unknown" },
      },
      {
        key: "2",
        kind: "camera_view",
        name: [{ lang: "en", text: "Looking Down" }],
        details: { kind: "camera_view", v: 1, imageRedistribution: "unknown" },
      },
      {
        key: "3",
        kind: "camera_view",
        name: [{ lang: "en", text: "Fort Erie Bound" }],
        details: { kind: "camera_view", v: 1, imageRedistribution: "unknown" },
      },
    ]);
    const views = readings(out, "ca-on-511-cameras", "1");
    expect(views.map(componentKey)).toEqual(["1", "2", "3"]);
    // "Enabled" says the view is configured, not that its image is current.
    expect(value(views[0])).toEqual({
      v: 1,
      status: "unknown",
      imageUrl: "https://511on.ca/map/Cctv/1",
    });
    // A camera whose id is text keeps it, reduced for the feature id.
    expect(camera(out, "ca-on-511-cameras", "782")?.["externalIds"]).toContainEqual({
      scheme: "provider",
      id: "Camera 9201",
      authority: "ca-on-511-cameras/City of Toronto",
    });
  });

  test("views are ordered by SortId, and a lone view takes the camera's direction", () => {
    const body = Buffer.from(
      JSON.stringify([
        {
          Id: 5,
          Source: "SKYLINE",
          SourceId: "9",
          Roadway: "I-75",
          Direction: "Northbound",
          Latitude: 33.7,
          Longitude: -84.4,
          Location: "I-75 at Exit 1",
          Views: [
            { Id: 52, Url: "https://511ga.org/map/Cctv/52", Status: "Enabled", SortId: 2 },
            { Id: 51, Url: "https://511ga.org/map/Cctv/51", Status: "Enabled", SortId: 1 },
          ],
        },
      ]),
    );
    const out = camerasDomain.formats["ibi511"]!.parse(
      georgiaFeed(),
      { main: [body] },
      parseContext(FETCHED),
    );
    const components = out.features[0]?.["components"] as { key: string; details: object }[];
    expect(components.map((c) => c.key)).toEqual(["51", "52"]);
    // Two views: which of them faces north is not said.
    for (const c of components) expect(c.details).not.toHaveProperty("direction");
    expect(out.observations.map(componentKey)).toEqual(["51", "52"]);

    const georgia = parse(georgiaFeed(), "us-ga-511-cameras.json");
    const sr154 = camera(georgia, "us-ga-511-cameras", "186");
    expect(sr154).toMatchObject({
      name: [{ lang: "en", text: "GDOT-CCTV-0054" }],
      description: [{ lang: "en", text: "GDOT-0054: SR154 W at StantonRd MM 25.7 (Fulton)" }],
      details: { provider: "SKYLINE", imageRedistribution: "link_only" },
    });
    expect(viewDetails(sr154)).toEqual({
      kind: "camera_view",
      v: 1,
      direction: { value: "unknown", basis: "compass", compass: "W" },
      imageRedistribution: "link_only",
    });
    expect(sr154?.["location"]).toMatchObject({
      roads: [{ name: [{ lang: "en", text: "SR154" }] }],
    });
  });

  test("Idaho's disabled view reads offline while its camera stays", () => {
    const out = parse(idahoFeed(), "us-id-511-cameras.json");
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:us-id-511-cameras:946",
      "oc:feature:us-id-511-cameras:947",
    ]);
    const [view] = readings(out, "us-id-511-cameras", "946");
    expect(componentKey(view!)).toBe("2403");
    expect(value(view)).toEqual({
      v: 1,
      status: "offline",
      imageUrl: "https://511.idaho.gov/map/Cctv/2403",
    });
    // "West" is a compass word.
    expect(viewDetails(camera(out, "us-id-511-cameras", "946"))).toMatchObject({
      direction: { value: "unknown", basis: "compass", compass: "W" },
    });
  });

  test("Louisiana's VideoUrl is the view's HLS stream; a still off the declared host is dropped", () => {
    const out = parse(louisianaFeed(), "us-la-511-cameras.json");
    const [view] = readings(out, "us-la-511-cameras", "1");
    // The documented sample points its still at a staging host the feed does not declare.
    expect(value(view)).toEqual({
      v: 1,
      status: "unknown",
      streamUrl: "https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-030.streams/playlist.m3u8",
      streamType: "hls",
    });
    expect(out.rejected).toBe(2);
    // "Unknown" is no direction.
    expect(viewDetails(camera(out, "us-la-511-cameras", "1"))).not.toHaveProperty("direction");
  });

  test("a camera without a position is rejected", () => {
    const body = Buffer.from(
      JSON.stringify([{ Id: 9, Location: "Nowhere", Views: [] }, { Location: "No id" }]),
    );
    const out = camerasDomain.formats["ibi511"]!.parse(
      georgiaFeed(),
      { main: [body] },
      parseContext(FETCHED),
    );
    expect(out.features).toEqual([]);
    expect(out.rejected).toBe(2);
  });

  test("every camera and reading seals", () => {
    for (const [feed, name] of [
      [ontarioFeed(), "ca-on-511-cameras.json"],
      [georgiaFeed(), "us-ga-511-cameras.json"],
      [idahoFeed(), "us-id-511-cameras.json"],
      [louisianaFeed(), "us-la-511-cameras.json"],
    ] as const) {
      const out = parse(feed, name);
      expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    }
  });
});
