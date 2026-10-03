import { readFileSync } from "node:fs";
import path from "node:path";
import { type ChildFeed, materializeCatalogChildren } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { roadFeed } from "../../__tests__/helpers/road-feed.js";
import { roadsDomain } from "../../domain.js";
import { wzdxRegistryResolver } from "../wzdx.js";

const REGISTRY = path.resolve(import.meta.dirname, "../../__tests__/fixtures/wzdx/registry.json");

function jsonResponder(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
    })) as unknown as typeof fetch;
}

const urlOf = (child: ChildFeed) => child.endpoints["main"]?.url;

const KANSAS = "https://ks.carsprogram.org/carsapi_v1/api/wzdx";

const REGISTRY_URL = "https://registry.example.test/wzdx.json?$limit=5000";

/** The catalogue parent, naming the registry the resolver reads. */
const PARENT = { endpoints: { main: { url: REGISTRY_URL, cadenceSec: 300 } } };

describe("wzdxRegistryResolver", () => {
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));

  it("reads the registry its parent's main endpoint names", async () => {
    const requested: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(JSON.stringify(registry));
    }) as typeof fetch;
    expect(await wzdxRegistryResolver.resolve(PARENT, fetchFn)).not.toEqual([]);
    expect(requested).toEqual([REGISTRY_URL]);
  });

  it("refuses a parent without a main endpoint URL", async () => {
    const bare = { endpoints: { main: { urls: [REGISTRY_URL], cadenceSec: 300 } } };
    await expect(wzdxRegistryResolver.resolve(bare, jsonResponder(registry))).rejects.toThrow(
      /wzdx-registry.*endpoints\.main\.url/,
    );
  });

  it("has the expected id and a vendored snapshot path", () => {
    expect(wzdxRegistryResolver.id).toBe("wzdx-registry");
    expect(wzdxRegistryResolver.snapshotPath).toMatch(/snapshots[/\\]wzdx-registry\.json$/);
  });

  it("maps active v4.x/v3.1 rows labeled geojson OR json to WZDx children", async () => {
    const children = await wzdxRegistryResolver.resolve(PARENT, jsonResponder(registry));
    expect(children.map(urlOf).sort()).toEqual(
      [
        "https://alpha.example/api/wzdx",
        "https://charlie.example/api/wzdx",
        // Wisconsin and statewide Missouri label an ordinary WZDx
        // FeatureCollection "json" rather than "geojson".
        "https://delta.example/api/json",
        // 3.1 is admitted too — the parser lifts its flat core fields.
        "https://golf.example/api/v3",
        "https://hotel.example/api/wzdx-string",
        "https://india.example/api/wzdx",
      ].sort(),
    );
    for (const child of children) {
      expect(child.qualifier).toMatch(/^[0-9a-f]{16}$/);
      expect(child.license).toBe("NOASSERTION");
      expect(child.terms).toEqual({
        note: "WZDx registry metadata (no dataset grant verified)",
        reviewedAt: "2026-09-11",
      });
      expect(child.selectionState).toBe("discovered");
      expect(child.snapshot).toEqual({ completeness: "complete", recordsPath: "features" });
    }
    expect(new Set(children.map((c) => c.qualifier)).size).toBe(children.length);
  });

  it("admits Kansas under its verified child grant without relabelling other children", async () => {
    const [kansas, washington] = await wzdxRegistryResolver.resolve(
      PARENT,
      jsonResponder([
        {
          feedname: "Kansas DOT",
          state: "kansas",
          issuingorganization: "Kansas DOT",
          active: true,
          format: "geojson",
          version: "4.2",
          url: KANSAS,
        },
        {
          feedname: "Washington DOT",
          state: "washington",
          issuingorganization: "Washington DOT",
          active: true,
          format: "geojson",
          version: "4.2",
          url: "https://example.test/washington",
        },
      ]),
    );

    expect(kansas).toMatchObject({
      qualifier: "fe9b3423ea03546f",
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      selectionState: "approved",
      attribution: "Kansas DOT",
    });
    expect(washington).toMatchObject({ license: "NOASSERTION", selectionState: "discovered" });

    const parent = roadFeed({
      region: "us",
      operator: "wzdx",
      format: "wzdx",
      license: "NOASSERTION",
      terms: { note: "WZDx feed registry" },
      catalog: { resolver: "wzdx-registry", approvedChildren: ["us-wzdx-fe9b3423ea03546f-events"] },
    });
    const { scheduled } = materializeCatalogChildren([parent], [roadsDomain]);
    expect(scheduled.map((f) => f.id)).toEqual(["us-wzdx-fe9b3423ea03546f-events"]);
    expect(scheduled[0]!.rights).toMatchObject({
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      retention: true,
    });
  });

  it("keeps child identity stable across registry order and label changes without transferring grants", async () => {
    const rows = [
      {
        active: true,
        format: "geojson",
        version: "4.2",
        state: "Kansas",
        url: "https://example.test/other-kansas",
      },
      { active: true, format: "geojson", version: "4.2", state: "Kansas", url: KANSAS },
    ];
    const first = await wzdxRegistryResolver.resolve(PARENT, jsonResponder(rows));
    const second = await wzdxRegistryResolver.resolve(
      PARENT,
      jsonResponder(
        [...rows].reverse().map((row) => ({ ...row, state: "KS", feedname: "Renamed" })),
      ),
    );
    expect(Object.fromEntries(first.map((c) => [urlOf(c), c.qualifier]))).toEqual(
      Object.fromEntries(second.map((c) => [urlOf(c), c.qualifier])),
    );
    expect(first[0]).toMatchObject({ license: "NOASSERTION", selectionState: "discovered" });
    expect(first[1]).toMatchObject({ license: "CC0-1.0", selectionState: "approved" });
    expect(second.filter((c) => c.selectionState === "approved").map(urlOf)).toEqual([KANSAS]);
  });

  it("drops inactive / non-v4 / other-format and empty/placeholder-key rows", async () => {
    const urls = (await wzdxRegistryResolver.resolve(PARENT, jsonResponder(registry))).map(urlOf);
    expect(urls).not.toContain("https://echo.example/api/wzdx");
    expect(urls).not.toContain("https://bravo.example/api/wzdx?apiKey=");
    // CWZ 1.0 is a different shape with no adapter, not a different label.
    expect(urls).not.toContain("https://foxtrot.example/api/cwz");
  });

  it("still rejects a format that is neither geojson nor json", async () => {
    const children = await wzdxRegistryResolver.resolve(
      PARENT,
      jsonResponder([
        {
          feedname: "xml-dot",
          state: "XX",
          active: "true",
          format: "xml",
          version: "4.1",
          url: { url: "https://xml.example/api/wzdx" },
        },
      ]),
    );
    expect(children).toEqual([]);
  });

  it("uses a keyed row's concrete URL as published, with no credential of its own", async () => {
    const [child] = await wzdxRegistryResolver.resolve(
      PARENT,
      jsonResponder([
        {
          feedname: "keyed-dot",
          state: "TX",
          issuingorganization: "TxDOT",
          active: "true",
          format: "geojson",
          version: "4.2",
          needapikey: "yes",
          apikeyurl: "https://txdot.example/get-a-key",
          url: "https://keyed.example/wzdx?api_key=abc123",
        },
      ]),
    );
    expect(urlOf(child!)).toBe("https://keyed.example/wzdx?api_key=abc123");
    expect(child).not.toHaveProperty("credentials");
    expect(child).not.toHaveProperty("auth");
  });

  it("throws when the registry responds non-ok", async () => {
    await expect(wzdxRegistryResolver.resolve(PARENT, jsonResponder("", 500))).rejects.toThrow(
      /500/,
    );
  });

  it("returns no children when the payload is not an array", async () => {
    expect(await wzdxRegistryResolver.resolve(PARENT, jsonResponder({}))).toEqual([]);
  });
});
