import { describe, expect, it } from "vitest";
import { readInventory } from "../lib/feed-discovery/inventory.js";
import type { Distribution, InventoryFeed } from "../lib/feed-discovery/model.js";
import { baseDistribution } from "../lib/feed-discovery/normalize.js";
import { buildReport } from "../lib/feed-discovery/rank.js";

const now = new Date("2026-11-27T00:00:00Z");
function lead(extra: Partial<Distribution> = {}): Distribution {
  return {
    ...baseDistribution("belgium", "10000000-0000-4000-8000-000000000000"),
    title: "Parking occupancy",
    countries: ["BE"],
    formats: ["APDS"],
    downloadUrls: ["https://example.org/data"],
    licenses: { origin: "distribution", declarations: ["cc0-10"] },
    ...extra,
  };
}
const feed = (extra: Partial<InventoryFeed> = {}): InventoryFeed => ({
  id: "be-example-parking",
  domain: "parking",
  region: "be",
  disabled: false,
  aggregator: false,
  urls: ["https://example.org/data"],
  termsUrls: [],
  countries: [],
  bbox: false,
  ...extra,
});
describe("human-review queue and baked inventory", () => {
  it("ranks a public pull lead as research only and explicitly reports possible national coverage", () => {
    const r = buildReport(
      [lead()],
      [feed({ region: "eu", urls: [], id: "eu-bundle-parking" })],
      now,
    );
    expect(r.candidates[0]).toMatchObject({
      status: "needs_review",
      priority: "research_extension",
    });
    expect(r.candidates[0]?.caveats).toContain("possible_multinational_coverage:eu-bundle-parking");
    expect(buildReport([lead()], [], now).candidates[0]?.priority).toBe("research_gap");
  });
  it.each([
    { communication: ["push"] },
    { protocols: ["mqtt"] },
    { downloadUrls: [] },
    { usageConditions: ["fee-required"] },
    { accessConditions: ["contractual-arrangement"] },
    { licenses: { origin: "distribution" as const, declarations: [] } },
  ])("access and rights obstacles outweigh a country-domain gap %j", (extra) => {
    expect(buildReport([lead(extra)], [], now).candidates[0]?.priority).toBe("review_constraints");
  });
  it.each([
    "GBFS",
    "sharing-and-hiring-services",
    "public-transport-timetables",
    "transport-stops",
  ])("excludes %s without inventing maintenance vehicles", (theme) => {
    const r = buildReport([lead({ title: theme, themes: [theme], formats: [theme] })], [], now);
    expect(r.candidates).toHaveLength(0);
    expect(r.excluded.no_oc_domain).toBe(1);
  });
  it("retains conservative unknowns and maps maintenance fleet explicitly", () => {
    expect(
      buildReport(
        [lead({ title: "Unclassified spatial catalog", formats: [], themes: [] })],
        [],
        now,
      ).candidates[0],
    ).toMatchObject({ domains: [], priority: "review_constraints" });
    expect(
      buildReport(
        [lead({ title: "Road maintenance fleet", formats: ["iowa-avl"] })],
        [],
        now,
      ).candidates[0]?.domains.map((d) => d.domain),
    ).toContain("vehicles");
  });
  it("distinguishes exact endpoints, disabled sources, query variations and sample-only references", () => {
    const r = buildReport([lead()], [feed({ disabled: true })], now);
    expect(r.candidates[0]).toMatchObject({
      priority: "already_configured",
      overlap: [{ feedId: "be-example-parking", disabled: true, reason: "exact_endpoint" }],
    });
    expect(
      buildReport(
        [lead({ downloadUrls: ["https://example.org/data?a=1&b=2"] })],
        [feed({ urls: ["https://example.org/data?b=2&a=1"] })],
        now,
      ).candidates[0]?.overlap[0]?.reason,
    ).toBe("possible_query_overlap");
    expect(
      buildReport(
        [lead({ downloadUrls: [], sampleUrls: ["https://example.org/data"] })],
        [feed()],
        now,
      ).candidates[0]?.overlap,
    ).toEqual([]);
  });
  it("preserves HTTP/MQTT sibling identity, numbers collisions, and excludes timestamps from identity", () => {
    const a = lead({ protocols: ["http"] }),
      b = lead({ protocols: ["mqtt"] });
    const r = buildReport([a, b, a], [], now);
    expect(r.candidates).toHaveLength(3);
    expect(new Set(r.candidates.map((c) => c.id)).size).toBe(3);
    expect(r.collisions).toBe(1);
    expect(buildReport([a, b], [], now).candidates.map((c) => c.id)).toEqual(
      buildReport(
        [
          { ...b, modified: "2026-11-28" },
          { ...a, modified: "2026-11-29" },
        ],
        [],
        now,
      ).candidates.map((c) => c.id),
    );
  });
  it("sanitizes every emitted metadata string while preserving timestamps and typed IDs", () => {
    const r = buildReport(
      [
        lead({
          datasetId: "https://u:p@example.org/d?surprise=secret",
          title: "Roadworks a@b.org",
          themes: ["https://u:p@example.org/t?another=secret"],
          rights: ["secret=secret"],
          modified: "2026-11-27T05:43:15Z",
          description: "Phone +49 123 456789. https://u:p@example.org/x?undocumented=secret",
        }),
      ],
      [],
      now,
    );
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/u:p|=secret|a@b\.org|456789/);
    expect(r.generatedAt).toBe("2026-11-27T00:00:00.000Z");
    expect(r.candidates[0]?.modified).toBe("2026-11-27T05:43:15Z");
  });
  it("finds SEVAS, parken-nrw and P+R in actual baked definitions without loading resolvers", async () => {
    const inventory = await readInventory();
    expect(inventory.length).toBeGreaterThan(100);
    for (const [datasetName, url] of [
      [
        "parken-nrw",
        "https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/parken-nrw.json",
      ],
      [
        "gebndelte-daten-parkride-nrw",
        "https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/gebndelte-daten-parkride-nrw.json",
      ],
      [
        "sevas",
        "https://sevas.nrw.de/osm/sevas?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:restriktionen_segmente",
      ],
    ]) {
      const r = buildReport(
        [
          lead({
            catalog: "mobidrom",
            datasetName,
            title: datasetName === "sevas" ? "Road restrictions" : "Parking",
            downloadUrls: [url],
          }),
        ],
        inventory,
        now,
      );
      expect(
        r.candidates[0]?.overlap.some(
          (m) =>
            m.reason === "exact_endpoint" ||
            m.reason === "already_configured_dataset" ||
            m.reason === "possible_query_overlap",
        ),
      ).toBe(true);
    }
  });
});
it("does not invent road-event coverage from DATEX parking metadata", () => {
  const r = buildReport([lead({ title: "Parking occupancy", formats: ["DATEX II"] })], [], now);
  expect(r.candidates[0]?.domains.map((d) => d.domain)).toEqual(["parking"]);
});
it("does not treat unresolved credential templates as every endpoint's prefix", () => {
  expect(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Deliberate unresolved baked endpoint template.
    buildReport([lead()], [feed({ urls: ["${@overpass.url}"] })], now).candidates[0]?.overlap,
  ).toEqual([]);
});
it("recognizes Latvia 44751 static traffic regulations as a road restriction lead", () => {
  const r = buildReport(
    [
      lead({
        catalog: "latvia",
        title: "Weight and dimensions restrictions",
        formats: ["GEOJSON"],
        themes: [
          "https://w3id.org/mobilitydcat-ap/mobility-theme/static-traffic-signs-and-regulations",
          "https://w3id.org/mobilitydcat-ap/mobility-theme/other-traffic-regulations",
        ],
        communication: ["push"],
        downloadUrls: [],
      }),
    ],
    [],
    now,
  );
  expect(r.candidates[0]).toMatchObject({
    domains: [{ domain: "roads", reason: "theme_or_keyword_hint" }],
    priority: "review_constraints",
  });
});
it("marks same endpoints from different catalogs as related without merging them", () => {
  const r = buildReport([lead({ catalog: "belgium" }), lead({ catalog: "mobidrom" })], [], now);
  expect(r.candidates).toHaveLength(2);
  expect(r.candidates[0]?.relatedCandidates).toEqual([r.candidates[1]?.id]);
});
it("does not call same-named datasets on another catalog already configured", () => {
  const r = buildReport(
    [lead({ datasetName: "parking", metadataUrl: "https://transportdata.be/dataset/id" })],
    [feed({ urls: [], termsUrls: ["https://unrelated.example/dataset/parking"] })],
    now,
  );
  expect(r.candidates[0]?.overlap).toEqual([]);
});
it("does not match an unresolved host template to every HTTPS endpoint", () => {
  const unresolvedHost = "https://" + ["$", "{host}"].join("") + "/data";
  expect(
    buildReport([lead()], [feed({ urls: [unresolvedHost] })], now).candidates[0]?.overlap,
  ).toEqual([]);
});
it("compares original query values before redaction when linking catalogs", () => {
  const r = buildReport(
    [
      lead({ downloadUrls: ["https://example.org/data?token=one"] }),
      lead({ catalog: "mobidrom", downloadUrls: ["https://example.org/data?token=two"] }),
    ],
    [],
    now,
  );
  expect(r.candidates.map((c) => c.relatedCandidates)).toEqual([[], []]);
});
