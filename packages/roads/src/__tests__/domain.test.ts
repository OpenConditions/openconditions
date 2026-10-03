import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DigestTee,
  materializeCatalogChildren,
  type ParseContext,
  type StreamInput,
} from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { autobahnIndexResolver, wzdxRegistryResolver } from "../catalog/index.js";
import { ROAD_PRODUCTS, ROAD_REFERENCE_DECODERS, roadsDomain } from "../domain.js";
import { parseDatexSiteTable } from "../siteTable.js";
import { parseFintrafficStations } from "../stations-fintraffic.js";
import { roadFeed } from "./helpers/road-feed.js";

const fixture = (path: string) => readFileSync(join(import.meta.dirname, "fixtures", path));

const ctx = (reference: Record<string, unknown> = {}): ParseContext => ({
  fetchedAt: "2026-09-18T10:00:00.000Z",
  cadenceSec: 60,
  reference,
});

test("every roads format serves roads products only", () => {
  for (const f of Object.values(roadsDomain.formats)) {
    for (const p of f.products) expect(ROAD_PRODUCTS).toContain(p);
  }
});

test("no format code means two parsers", () => {
  expect(Object.keys(roadsDomain.formats)).toEqual([...new Set(Object.keys(roadsDomain.formats))]);
  expect(roadsDomain.formats["datex2"]!.kind).toBe("situations");
  expect(roadsDomain.formats["datex2-measured"]!.kind).toBe("measurements");
  expect(roadsDomain.formats["datex2-measured"]!.stream).toBeDefined();
});

test("autobahn children are named by road, service and product", () => {
  expect(autobahnIndexResolver.snapshot[0]!.qualifier).toMatch(/^a\d+-[a-z]+$/);
});

test("the roads module loads no feeds", async () => {
  expect(Object.keys(await import("../index.js"))).not.toContain("FEED_SOURCES");
});

describe("roads formats", () => {
  test("each format is keyed by its own id", () => {
    for (const [code, format] of Object.entries(roadsDomain.formats)) expect(format.id).toBe(code);
  });

  test("situation formats read one required main endpoint into events or conditions", () => {
    const situations = Object.values(roadsDomain.formats).filter((f) => f.kind === "situations");
    expect(situations.map((f) => f.id).sort()).toEqual(
      [
        "autobahn",
        "datex2",
        "digitraffic",
        "flatjson",
        "gddkia",
        "geojson",
        "ibi511",
        "ibi511-conditions",
        "lta",
        "ohgo-events",
        "open511",
        "trafikverket",
        "vic-disruptions",
        "wzdx",
      ].sort(),
    );
    for (const f of situations) {
      expect(f.products).toEqual(["events", "conditions"]);
      expect(f.endpoints).toEqual({ main: { required: true } });
    }
  });

  test("measurement formats serve flow and name only reference decoders for their sites", () => {
    const measurements = Object.values(roadsDomain.formats).filter(
      (f) => f.kind === "measurements",
    );
    expect(measurements).toHaveLength(16);
    for (const f of measurements) {
      expect(f.products).toEqual(["flow"]);
      expect(f.endpoints["main"]).toEqual({ required: true });
      for (const decoder of f.endpoints["sites"]?.decoders ?? []) {
        expect(ROAD_REFERENCE_DECODERS).toContain(decoder);
      }
    }
  });

  test("a site table is required only where the parser cannot place a reading without it", () => {
    const required = Object.values(roadsDomain.formats)
      .filter((f) => f.endpoints["sites"]?.required)
      .map((f) => f.id)
      .sort();
    expect(required).toEqual(["bcn-trams", "fintraffic-tms", "hk-td", "miv", "webtris"]);
    expect(roadsDomain.formats["datex2-measured"]!.endpoints["sites"]).toEqual({
      required: false,
      decoders: ["datex2-sites", "france-comptage-csv"],
    });
    expect(roadsDomain.formats["datex2-elaborated"]!.endpoints["sites"]).toEqual({
      required: false,
      decoders: ["datex2-locations"],
    });
  });

  test("every reference decoder serves some format", () => {
    const named = new Set(
      Object.values(roadsDomain.formats).flatMap((f) => f.endpoints["sites"]?.decoders ?? []),
    );
    expect([...named].sort()).toEqual([...ROAD_REFERENCE_DECODERS].sort());
  });

  test("the old dual and DATEX flow codes are gone", () => {
    for (const code of ["datex-elaborated", "datex-site-table", "datex-predefined-locations"]) {
      expect(roadsDomain.formats[code]).toBeUndefined();
      expect(ROAD_REFERENCE_DECODERS).not.toContain(code);
    }
  });
});

describe("parsing through a format", () => {
  test("a situation format drafts the situations of the main payloads", () => {
    const feed = roadFeed({ id: "nl-ndw-events", region: "nl", format: "datex2" });
    const out = roadsDomain.formats["datex2"]!.parse(
      feed,
      { main: [fixture("ndw/restrictions-v3.xml")] },
      ctx(),
    );
    expect(out.situations.length).toBeGreaterThan(0);
    expect(out.offers).toEqual([]);
    expect(
      out.situations.every((s) => String(s["id"]).startsWith("oc:situation:nl-ndw-events:")),
    ).toBe(true);
  });

  test("a measurement format reads its sites from the decoded reference", () => {
    const feed = roadFeed({
      id: "fi-fintraffic-flow",
      region: "fi",
      product: "flow",
      format: "fintraffic-tms",
    });
    const format = roadsDomain.formats["fintraffic-tms"]!;
    const payloads = { main: [fixture("flow/fintraffic-tms.json")] };
    const sites = parseFintrafficStations(fixture("flow/fintraffic-stations.json"));
    const out = format.parse(feed, payloads, ctx({ sites }));
    expect(out.features.length).toBeGreaterThan(0);
    expect(out.observations.length).toBeGreaterThan(0);
    expect(out.offers).toEqual([]);
    expect(format.parse(feed, payloads, ctx()).observations).toEqual([]);
  });

  test("streaming a DATEX measured-data document drafts what the buffered parse does", async () => {
    const feed = roadFeed({
      id: "nl-ndw-flow",
      region: "nl",
      product: "flow",
      format: "datex2-measured",
      laneNumbering: "left_first",
    });
    const doc = fixture("ndw-flow/trafficspeed.xml");
    const sites = parseDatexSiteTable(fixture("ndw-flow/measurement_site_table.xml"));
    const format = roadsDomain.formats["datex2-measured"]!;
    const finished: boolean[] = [];
    const input: StreamInput = {
      url: "https://example.test/trafficspeed.xml",
      open: async () => Readable.from([doc.subarray(0, 1000), doc.subarray(1000)]),
      tee: async () => ({
        tee: new DigestTee("https://example.test/trafficspeed.xml"),
        finish: async (ok) => {
          finished.push(ok);
        },
      }),
    };
    const { output, payload } = await format.stream!.read(feed, input, ctx({ sites }));
    expect(output).toEqual(format.parse(feed, { main: [doc] }, ctx({ sites })));
    expect(payload).toEqual({
      url: "https://example.test/trafficspeed.xml",
      sha256: createHash("sha256").update(doc).digest("hex"),
      bytes: doc.length,
    });
    expect(finished).toEqual([true]);
  });

  test("a truncated streamed document throws instead of reading as fewer readings", async () => {
    const feed = roadFeed({ region: "nl", product: "flow", format: "datex2-measured" });
    const doc = fixture("ndw-flow/trafficspeed.xml");
    const input: StreamInput = {
      url: "https://example.test/trafficspeed.xml",
      open: async () => Readable.from([doc.subarray(0, Math.floor(doc.length / 2)), "<<<"]),
      tee: async () => ({
        tee: new DigestTee("https://example.test/trafficspeed.xml"),
        finish: async () => {},
      }),
    };
    await expect(
      roadsDomain.formats["datex2-measured"]!.stream!.read(feed, input, ctx()),
    ).rejects.toThrow(/truncated/);
  });
});

describe("roads catalogue resolvers", () => {
  test("the domain carries the Autobahn and WZDx resolvers", () => {
    expect(roadsDomain.resolvers.map((r) => r.id).sort()).toEqual([
      "autobahn-index",
      "wzdx-registry",
    ]);
  });

  test("every Autobahn snapshot child resolves under its parent with its own licence", () => {
    const parent = roadFeed({
      region: "de",
      operator: "autobahn",
      format: "autobahn",
      license: "DL-DE-BY-2.0",
      catalog: { resolver: "autobahn-index", approvedChildren: [] },
    });
    const { discovered, issues } = materializeCatalogChildren([parent], [roadsDomain]);
    expect(issues).toEqual([]);
    expect(discovered).toHaveLength(autobahnIndexResolver.snapshot.length);
    expect(discovered.map((c) => c.id)).toContain("de-autobahn-a1-warning-events");
    for (const child of autobahnIndexResolver.snapshot) {
      expect(child.license).toBe("DL-DE-BY-2.0");
    }
  });

  test("every WZDx snapshot child resolves, unverified ones as NOASSERTION with the registry note", () => {
    const parent = roadFeed({
      region: "us",
      operator: "wzdx",
      format: "wzdx",
      license: "NOASSERTION",
      terms: { note: "WZDx feed registry" },
      catalog: { resolver: "wzdx-registry", approvedChildren: [] },
    });
    const { discovered, issues } = materializeCatalogChildren([parent], [roadsDomain]);
    expect(issues).toEqual([]);
    expect(discovered).toHaveLength(wzdxRegistryResolver.snapshot.length);
    for (const child of wzdxRegistryResolver.snapshot) {
      expect(child.qualifier).toMatch(/^[0-9a-f]{16}$/);
      if (child.license === "NOASSERTION") {
        expect(child.terms).toEqual({
          note: "WZDx registry metadata (no dataset grant verified)",
          reviewedAt: "2026-09-11",
        });
      }
    }
  });
});
