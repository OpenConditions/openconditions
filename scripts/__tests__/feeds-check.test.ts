import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkFeeds, runFeedsCheck } from "../feeds-check.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function feed(
  operator: string,
  url: string,
  extra = "",
  format = "geojson",
  product = "events",
): string {
  return `{
      "operator": "${operator}",
      "product": "${product}",
      "name": "${operator} ${product}",
      "tier": "authoritative",
      "format": "${format}",
      "endpoints": { "main": { "url": "${url}", "cadenceSec": 300 } },${extra}
      "freshnessWindowSec": 900,
      "license": "CC0-1.0",
      "attribution": "${operator}",
      "privacyUrl": "https://example.org/privacy",
    }`;
}

/** A catalogue directory with `roads/lu.jsonc` holding the given feeds. */
function catalogue(feeds: string[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "feeds-check-"));
  dirs.push(dir);
  mkdirSync(join(dir, "roads"));
  const file = join(dir, "roads", "lu.jsonc");
  writeFileSync(
    file,
    `{
  "$schema": "../schema/roads.schema.json",
  "maintainers": [{ "name": "Ada", "github": "ada" }],
  "feeds": [${feeds.join(",")}],
}
`,
  );
  return { dir, file };
}

const GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "1",
      geometry: { type: "Point", coordinates: [6.13, 49.61] },
      properties: { id: "1", headline: "Roadworks" },
    },
  ],
});

/** A well-formed DATEX II situation publication with no situations. */
const EMPTY_DATEX = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" modelBaseVersion="2">
  <exchange><supplierIdentification><country>lu</country><nationalIdentifier>t</nationalIdentifier></supplierIdentification></exchange>
  <payloadPublication lang="en" xsi:type="SituationPublication" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <publicationTime>2026-10-03T12:00:00Z</publicationTime>
    <publicationCreator><country>lu</country><nationalIdentifier>t</nationalIdentifier></publicationCreator>
  </payloadPublication>
</d2LogicalModel>`;

/**
 * Serves each URL by its host: `down` answers 500, `bad` a body that is
 * neither JSON nor XML, `empty` an empty FeatureCollection, `emptydatex` an
 * empty DATEX publication, anything else GeoJSON with one feature.
 */
const stubFetch = (async (input: string | URL | Request) => {
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
  if (host === "down.example.org") return new Response("unavailable", { status: 500 });
  if (host === "bad.example.org") return new Response("<<< not json >>>");
  if (host === "empty.example.org") {
    return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }));
  }
  if (host === "emptydatex.example.org") return new Response(EMPTY_DATEX);
  return new Response(GEOJSON);
}) as typeof fetch;

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

describe("feeds:check", () => {
  it("fails on a parse error and warns on a network error", async () => {
    quiet();
    const { dir, file } = catalogue([
      feed("down", "https://down.example.org/feed"),
      feed("bad", "https://bad.example.org/feed"),
    ]);

    const results = await checkFeeds({ feedsDir: dir, files: [file], fetch: stubFetch, env: {} });
    expect(results.map((r) => [r.feedId, r.level])).toEqual([
      ["lu-down-events", "warning"],
      ["lu-bad-events", "error"],
    ]);
    expect(results[0]?.message).toMatch(/HTTP 500/);
    expect(results[1]?.message).toMatch(/payload does not decode/);

    const code = await runFeedsCheck([file], { feedsDir: dir, fetch: stubFetch, env: {} });
    expect(code).toBe(1);
  });

  it("warns, without failing, on a well-formed payload with no records", async () => {
    quiet();
    const { dir, file } = catalogue([
      feed("empty", "https://empty.example.org/feed"),
      feed("emptydatex", "https://emptydatex.example.org/feed", "", "datex2"),
    ]);

    const results = await checkFeeds({ feedsDir: dir, files: [file], fetch: stubFetch, env: {} });
    expect(results.map((r) => [r.feedId, r.level, r.records])).toEqual([
      ["lu-empty-events", "warning", 0],
      ["lu-emptydatex-events", "warning", 0],
    ]);
    expect(await runFeedsCheck([file], { feedsDir: dir, fetch: stubFetch, env: {} })).toBe(0);
  });

  it("streams a streaming format: a body that will not open warns, one that will not read fails", async () => {
    quiet();
    const { dir, file } = catalogue([
      feed("down", "https://down.example.org/flow", "", "datex2-measured", "flow"),
      // A situation publication is not the measured-data publication the format reads.
      feed("emptydatex", "https://emptydatex.example.org/flow", "", "datex2-measured", "flow"),
    ]);
    const results = await checkFeeds({ feedsDir: dir, files: [file], fetch: stubFetch, env: {} });
    expect(results.map((r) => [r.feedId, r.level])).toEqual([
      ["lu-down-flow", "warning"],
      ["lu-emptydatex-flow", "error"],
    ]);
    expect(results[0]?.message).toMatch(/HTTP 500/);
    expect(results[1]?.message).toMatch(/streaming parse failed/);
  });

  it("fails on a payload that is neither JSON nor XML", async () => {
    quiet();
    const plain = (async () => new Response("Service temporarily moved")) as typeof fetch;
    const { dir, file } = catalogue([feed("plain", "https://plain.example.org/feed")]);
    const [result] = await checkFeeds({ feedsDir: dir, files: [file], fetch: plain, env: {} });
    expect(result).toMatchObject({ level: "error" });
    expect(result?.message).toMatch(/neither JSON nor XML/);
  });

  it("passes when every feed parses, and skips a feed whose credentials are not set", async () => {
    quiet();
    const keyed = `
      "credentials": { "api_key": { "title": "Key" } },
      "auth": { "kind": "query-key", "param": "key", "credential": "api_key" },`;
    const { dir, file } = catalogue([
      feed("good", "https://good.example.org/feed"),
      feed("keyed", "https://good.example.org/keyed", keyed),
    ]);

    const results = await checkFeeds({ feedsDir: dir, files: [file], fetch: stubFetch, env: {} });
    expect(results.map((r) => [r.feedId, r.level])).toEqual([
      ["lu-good-events", "ok"],
      ["lu-keyed-events", "skipped"],
    ]);
    expect(results[0]?.records).toBe(1);
    expect(results[1]?.message).toBe("missing configuration: LU_KEYED_EVENTS_API_KEY");
    expect(await runFeedsCheck([file], { feedsDir: dir, fetch: stubFetch, env: {} })).toBe(0);
  });

  it("checks an on-demand feed by fetching the cell of its probe", async () => {
    quiet();
    const dir = mkdtempSync(join(tmpdir(), "feeds-check-"));
    dirs.push(dir);
    mkdirSync(join(dir, "fuel"));
    const file = join(dir, "fuel", "lu.jsonc");
    writeFileSync(
      file,
      `{
  "$schema": "../schema/fuel.schema.json",
  "feeds": [{
    "operator": "osm",
    "product": "fuel",
    "name": "OSM fuel",
    "tier": "authoritative",
    "format": "overpass",
    "endpoints": { "main": { "url": "https://cells.example.org/?bbox={west},{south},{east},{north}", "cadenceSec": 3600 } },
    "freshnessWindowSec": 86400,
    "accessMode": "on_demand",
    "onDemand": { "cellDeg": 0.1, "ttlSec": 3600, "maxCellsPerRead": 4, "probe": [6.13, 49.61] },
    "coverage": { "bbox": [5.7, 49.4, 6.6, 50.2] },
    "license": "ODbL-1.0",
    "attribution": "© OpenStreetMap contributors",
    "privacyUrl": "https://example.org/privacy",
  }],
}
`,
    );
    const asked: string[] = [];
    const cellFetch = (async (input: string | URL | Request) => {
      asked.push(input instanceof Request ? input.url : String(input));
      const station = { type: "node", id: 1, lat: 49.61, lon: 6.13, tags: { amenity: "fuel" } };
      return new Response(JSON.stringify({ elements: [station] }));
    }) as typeof fetch;

    const results = await checkFeeds({ feedsDir: dir, files: [file], fetch: cellFetch, env: {} });
    expect(results.map((r) => [r.feedId, r.level, r.records])).toEqual([["lu-osm-fuel", "ok", 1]]);
    // The 0.1° cell holding the probe, its placeholders filled.
    expect(asked).toEqual(["https://cells.example.org/?bbox=6.1,49.6,6.2,49.7"]);
  });

  it("parses an on-demand answer for its cell, so what lies outside is not counted", async () => {
    quiet();
    const dir = mkdtempSync(join(tmpdir(), "feeds-check-"));
    dirs.push(dir);
    mkdirSync(join(dir, "charging"));
    const file = join(dir, "charging", "lu.jsonc");
    writeFileSync(
      file,
      `{
  "$schema": "../schema/charging.schema.json",
  "feeds": [{
    "operator": "ocm",
    "product": "charging",
    "name": "OCM charging",
    "tier": "community",
    "format": "ocm",
    "endpoints": { "main": { "url": "https://ocm.example.org/poi?boundingbox=({south},{west}),({north},{east})", "cadenceSec": 3600 } },
    "freshnessWindowSec": 86400,
    "accessMode": "on_demand",
    "onDemand": { "cellDeg": 0.1, "ttlSec": 3600, "maxCellsPerRead": 4, "probe": [6.13, 49.61] },
    "coverage": { "bbox": [5.7, 49.4, 6.6, 50.2] },
    "license": "CC-BY-4.0",
    "attribution": "Open Charge Map",
    "privacyUrl": "https://example.org/privacy",
  }],
}
`,
    );
    // OCM answers a radius around the box, so it reaches past the cell.
    const poi = (id: number, lat: number) => ({
      ID: id,
      AddressInfo: { Title: `Site ${id}`, Latitude: lat, Longitude: 6.13 },
      Connections: [],
    });
    const ocm = (async () =>
      new Response(JSON.stringify([poi(1, 49.61), poi(2, 49.75)]))) as unknown as typeof fetch;
    const results = await checkFeeds({ feedsDir: dir, files: [file], fetch: ocm, env: {} });
    expect(results.map((r) => [r.feedId, r.level, r.records])).toEqual([
      ["lu-ocm-charging", "ok", 1],
    ]);
  });

  it("fails on a catalogue the schema rejects", async () => {
    quiet();
    const { dir, file } = catalogue([feed("good", "https://good.example.org/feed")]);
    writeFileSync(file, readFileSync(file, "utf8").replace('"tier": "authoritative"', '"tier": 1'));
    expect(await runFeedsCheck([file], { feedsDir: dir, fetch: stubFetch, env: {} })).toBe(1);
  });

  it("fails naming a file argument that is no region file of the catalogue", async () => {
    quiet();
    const { dir, file } = catalogue([feed("good", "https://good.example.org/feed")]);
    const typo = join(dir, "roads", "lx.jsonc");
    const shared = join(dir, "credentials.jsonc");
    writeFileSync(shared, `{ "credentials": {} }`);
    expect(
      await runFeedsCheck([file, typo, shared], { feedsDir: dir, fetch: stubFetch, env: {} }),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(typo));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(shared));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("lu-good-events"));
  });

  it("is a usage error to give --report without a path", async () => {
    quiet();
    const { dir, file } = catalogue([feed("good", "https://good.example.org/feed")]);
    const deps = { feedsDir: dir, fetch: stubFetch, env: {} };
    expect(await runFeedsCheck(["--report"], deps)).toBe(2);
    expect(await runFeedsCheck(["--report", join(dir, "out.md"), file], deps)).toBe(0);
    expect(await runFeedsCheck([file, "--report"], deps)).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/usage: feeds:check/));
  });

  it("checks only the feeds of the files it is given", async () => {
    quiet();
    const { dir } = catalogue([feed("down", "https://down.example.org/feed")]);
    expect(await checkFeeds({ feedsDir: dir, files: [], fetch: stubFetch, env: {} })).toEqual([]);
  });

  it("checks every file when given none, and writes the liveness report of the failing feeds", async () => {
    quiet();
    const { dir } = catalogue([
      feed("down", "https://down.example.org/feed"),
      feed("good", "https://good.example.org/feed"),
    ]);
    const report = join(dir, "out", "liveness.md");
    const code = await runFeedsCheck(["--report", report], {
      feedsDir: dir,
      fetch: stubFetch,
      env: {},
    });
    expect(code).toBe(0);
    const md = readFileSync(report, "utf8");
    expect(md).toContain("`lu-down-events`");
    expect(md).toContain("@ada");
    expect(md).not.toContain("lu-good-events");
  });
});
