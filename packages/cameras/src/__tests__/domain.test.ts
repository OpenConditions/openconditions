import {
  type CatalogFile,
  type FeedDefinition,
  feedBaseShape,
  lintCatalog,
  regionFileJsonSchema,
  regionFileSchema,
} from "@openconditions/ingest-framework";
import { buildRegistry, kernelModule } from "@openconditions/model";
import { chargingModule } from "@openconditions/model-charging";
import { roadsModule } from "@openconditions/model-roads";
import { expect, test } from "vitest";
import { CAMERA_TYPES } from "../camera.js";
import { CAMERAS_PRODUCTS, camerasDomain } from "../domain.js";
import { camerasFeedShape } from "../feed-schema.js";
import { camerasCatalogue } from "./helpers/cameras-feed.js";

const NOW = new Date("2026-10-08T12:00:00Z");

const MAPPING = { id: "id", lang: "en", type: "traffic", imageRedistribution: "allowed" };

const feed = (over: Record<string, unknown> = {}): FeedDefinition =>
  ({
    operator: "vegagerdin",
    product: "cameras",
    name: "Vegagerðin web cameras",
    tier: "authoritative",
    format: "json",
    endpoints: {
      main: { url: "https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1", cadenceSec: 86400 },
    },
    freshnessWindowSec: 172800,
    license: "CC-BY-4.0",
    attribution: "Vegagerðin",
    privacyUrl: "https://example.org/privacy",
    layout: { lon: "Lengd", lat: "Breidd" },
    cameras: { imageHosts: ["www.vegagerdin.is"], ...MAPPING },
    ...over,
  }) as FeedDefinition;

const file = (feeds: FeedDefinition[]): CatalogFile => ({
  path: "feeds/cameras/is.jsonc",
  domain: "cameras",
  region: "is",
  maintainers: [],
  $schema: "../schema/cameras.schema.json",
  feeds,
});

const lint = (f: FeedDefinition) =>
  lintCatalog([file([f])], { groups: {} }, [camerasDomain], NOW).map((i) => i.message);

const accepts = (f: FeedDefinition) =>
  regionFileSchema(camerasFeedShape).safeParse({ feeds: [f] }).success;

test("camerasDomain registers its formats, each producing cameras, views and image readings", () => {
  expect(camerasDomain.id).toBe("cameras");
  expect(camerasDomain.products).toEqual(["cameras"]);
  expect(CAMERAS_PRODUCTS).toEqual(["cameras"]);
  expect(camerasDomain.feedShape).toBe(camerasFeedShape);
  expect(camerasDomain.resolvers).toEqual([]);
  const main = { main: { required: true } };
  expect(
    Object.fromEntries(Object.entries(camerasDomain.formats).map(([id, f]) => [id, f.endpoints])),
  ).toEqual({
    geojson: main,
    json: main,
    csv: main,
    overpass: main,
    digitraffic: {
      sites: { required: true },
      details: { required: false },
      status: { required: false, status: true },
    },
    trafikverket: main,
    ibi511: main,
    tdx: main,
    "hk-td": { main: { required: true }, names: { required: false } },
    datex2: main,
    windy: main,
    tfl: main,
    nps: main,
    tripcheck: main,
  });
  // Only Digitraffic reads its live image times alone.
  expect(
    Object.entries(camerasDomain.formats).flatMap(([id, f]) =>
      f.parseStatus === undefined ? [] : [id],
    ),
  ).toEqual(["digitraffic"]);
  for (const [code, format] of Object.entries(camerasDomain.formats)) {
    expect(format.id).toBe(code);
    expect(format.kind).toBe("features");
    expect(format.products).toEqual(["cameras"]);
    expect(format.produces).toEqual({
      kinds: ["camera", "camera_view"],
      properties: ["camera.image"],
    });
  }
});

test("every format is a source format the model knows, and the camera types are the model's", () => {
  const registry = buildRegistry([kernelModule, roadsModule, chargingModule]);
  const formats = registry.vocabulary("source_format")?.values ?? [];
  for (const id of Object.keys(camerasDomain.formats)) expect(formats).toContain(id);
  expect([...CAMERA_TYPES].sort()).toEqual(
    Object.keys(registry.kind("feature", "camera")?.types ?? {}).sort(),
  );
});

test("the feed shape is the base shape plus the layout and cameras blocks", () => {
  for (const key of Object.keys(feedBaseShape)) expect(camerasFeedShape).toHaveProperty(key);
  expect(accepts(feed())).toBe(true);
  const cameras = (block: Record<string, unknown>) => accepts(feed({ cameras: block }));
  // Strict, with the closed vocabularies in its maps.
  expect(cameras({ ...MAPPING, colour: "red" })).toBe(false);
  expect(cameras({ ...MAPPING, type: "webcam" })).toBe(false);
  expect(cameras({ ...MAPPING, status: { field: "s", map: { a: "working" } } })).toBe(false);
  // A publisher's flag says whether a view delivers; only an image time says it is stale.
  expect(cameras({ ...MAPPING, status: { field: "s", map: { old: "stale" } } })).toBe(false);
  expect(
    cameras({
      ...MAPPING,
      status: { field: "s", map: { a: "online", b: "offline", c: "unknown" } },
    }),
  ).toBe(true);
  expect(cameras({ ...MAPPING, direction: { field: "d", map: { North: "NNE" } } })).toBe(false);
  expect(cameras({ ...MAPPING, streamType: "flv" })).toBe(false);
  expect(cameras({ ...MAPPING, refreshSec: 0 })).toBe(false);
  expect(cameras({ ...MAPPING, refreshSec: { field: "f", unit: "h" } })).toBe(false);
  expect(cameras({ ...MAPPING, imageAt: { field: "t", format: "local" } })).toBe(false);
  expect(cameras({ ...MAPPING, id: { field: "id", pattern: "(" } })).toBe(false);
  expect(
    cameras({
      ...MAPPING,
      id: ["district", "index"],
      groupBy: "site",
      viewKey: { field: "url", pattern: "/([^/]+)\\.jpg$" },
      type: { field: "kind", map: { road: "traffic" }, default: "other" },
      refreshSec: { field: "f", unit: "min" },
      imageAt: { field: "t", format: "epoch-ms" },
    }),
  ).toBe(true);
});

test("image hosts are exact hosts, subdomain wildcards or hosts with a path prefix", () => {
  const hosts = (imageHosts: unknown) => accepts(feed({ cameras: { ...MAPPING, imageHosts } }));
  expect(
    hosts([
      "weathercam.digitraffic.fi",
      "*.thb.gov.tw",
      "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/",
    ]),
  ).toBe(true);
  expect(hosts([])).toBe(false);
  for (const bad of [
    "https://weathercam.digitraffic.fi",
    "weathercam.digitraffic.fi:443",
    "WeatherCam.digitraffic.fi",
    "localhost",
    "*",
    "*.fi.*",
    "a.*.example.org",
    "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk",
    "s3-eu-west-1.amazonaws.com//",
    "cwwp2.dot.ca.gov/data?x=1/",
    " cwwp2.dot.ca.gov",
  ]) {
    expect(hosts([bad]), bad).toBe(false);
  }
});

test("image hosts follow the image proxy's rules: no shared or private host, no climbing path", () => {
  const hosts = (imageHosts: unknown) => accepts(feed({ cameras: { ...MAPPING, imageHosts } }));
  for (const good of [
    "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/",
    "*.thb.gov.tw",
    "*.example.co.uk",
    "notamazonaws.com",
    "cdn.example.org/a~b/c-d_e.f/",
  ]) {
    expect(hosts([good]), good).toBe(true);
  }
  for (const bad of [
    // A wildcard over a single label, a country's public suffix or a shared hosting domain.
    "*.com",
    "*.co.uk",
    "*.gov.tw",
    "*.amazonaws.com",
    "*.s3.amazonaws.com",
    "*.github.io",
    // A shared hosting host without a path admits every customer's files on it.
    "s3-eu-west-1.amazonaws.com",
    "d1234.cloudfront.net",
    // IP literals and loopback names.
    "127.0.0.1",
    "10.0.0.5",
    "cam.0x7f",
    "cam.localhost",
    "*.localhost",
    // A wildcard with a path, dot segments, encoded separators, other path characters.
    "*.thb.gov.tw/snap/",
    "cdn.example.org/a/../",
    "cdn.example.org/./a/",
    "cdn.example.org/a%2fb/",
    "cdn.example.org/a%2E/",
    "cdn.example.org/a@b/",
    "cdn.example.org/a;b/",
  ]) {
    expect(hosts([bad]), bad).toBe(false);
  }
});

test("every catalogue feed in a layout passes the domain's lint", () => {
  for (const f of camerasCatalogue().values()) {
    expect(camerasDomain.lintFeed?.(f as unknown as FeedDefinition), f.id).toEqual([]);
  }
});

test("a layout feed with its cameras mapping and layout block is clean", () => {
  expect(lint(feed())).toEqual([]);
});

test("a layout feed needs a layout block and a whole cameras mapping", () => {
  expect(lint(feed({ layout: undefined }))).toEqual([
    expect.stringMatching(/format json needs a layout block/),
  ]);
  expect(lint(feed({ cameras: undefined }))).toEqual([
    expect.stringMatching(/format json needs a cameras mapping/),
  ]);
  expect(lint(feed({ cameras: { imageHosts: ["www.vegagerdin.is"], id: "id" } }))).toEqual([
    expect.stringMatching(/cameras mapping: lang/),
    expect.stringMatching(/cameras mapping: type/),
    expect.stringMatching(/cameras mapping: imageRedistribution/),
  ]);
});

test("a layout feed names its camera by id or by groupBy, exactly one", () => {
  const { id: _, ...unnamed } = MAPPING;
  const hosts = { imageHosts: ["www.vegagerdin.is"] };
  expect(lint(feed({ cameras: { ...hosts, ...unnamed, groupBy: "Maelist_nr" } }))).toEqual([]);
  expect(lint(feed({ cameras: { ...hosts, ...MAPPING, groupBy: "Maelist_nr" } }))).toEqual([
    "cameras mapping: id and groupBy both name the camera; write one",
  ]);
  expect(lint(feed({ cameras: { ...hosts, ...unnamed } }))).toEqual([
    "cameras mapping: id or groupBy is required",
  ]);
});

test("a layout feed that reads stills declares the hosts they come from", () => {
  const stills = { ...MAPPING, imageUrl: "Slod", thumbnailUrl: "Smamynd" };
  expect(lint(feed({ cameras: { imageHosts: ["www.vegagerdin.is"], ...stills } }))).toEqual([]);
  expect(lint(feed({ cameras: stills }))).toEqual([
    "cameras mapping: imageUrl needs the feed's imageHosts",
    "cameras mapping: thumbnailUrl needs the feed's imageHosts",
  ]);
});

test("a format with its own parser reads no mapping, only the image hosts", () => {
  const overpass = (cameras: Record<string, unknown> | undefined) =>
    lint(
      feed({
        format: "overpass",
        layout: undefined,
        ...(cameras === undefined ? { cameras: undefined } : { cameras }),
      }),
    );
  expect(overpass(undefined)).toEqual([]);
  expect(overpass({ imageHosts: ["a.example.org"] })).toEqual([]);
  expect(overpass({ imageHosts: ["a.example.org"], id: "id", lang: "en" })).toEqual([
    expect.stringMatching(/format overpass reads no cameras mapping: id, lang/),
  ]);
  // What the images' licence allows is the feed's to say, whatever its format.
  expect(overpass({ imageRedistribution: "link_only" })).toEqual([]);
  expect(lint(feed({ format: "overpass" }))).toEqual(
    expect.arrayContaining([expect.stringMatching(/format overpass reads no layout block/)]),
  );
});

test("the domain renders its catalogue JSON Schema", () => {
  const schema = JSON.stringify(regionFileJsonSchema(camerasDomain));
  expect(schema).toContain("imageHosts");
  expect(schema).toContain("imageRedistribution");
});

test("a format without a payload parses to nothing", () => {
  const ctx = { fetchedAt: "2026-10-08T06:00:00Z", cadenceSec: 600, reference: {} };
  for (const format of Object.values(camerasDomain.formats)) {
    const out = format.parse({} as never, {}, ctx);
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
  }
});
