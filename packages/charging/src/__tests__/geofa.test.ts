import { expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const row = (properties: Record<string, unknown> = {}) => ({
  type: "Feature",
  geometry: { type: "MultiPoint", coordinates: [[12, 55]] },
  properties: {
    objekt_id: "a",
    versions_id: "v1",
    off_kode: 1,
    statuskode: 3,
    ladefacilitet_type_kode: 1,
    tilgaengelighed_type_kode: 1,
    antal_ladepunkter: 2,
    internationalt_id: "DK*SPA*E1",
    internationalt_id1: "DK*SPA*E2",
    stiktype: "Type2",
    anvendelsesgrad_kwh: 150,
    ...properties,
  },
});
const parse = (rows = [row()], at = "2026-11-07T12:00:00Z") =>
  chargingDomain.formats["geofa"]!.parse(
    catalogFeed("dk-geofa-charging"),
    { main: [Buffer.from(JSON.stringify({ type: "FeatureCollection", features: rows }))] },
    parseContext(at),
  );
test("GeoFA emits named static EVSEs, unknown physical state, no invented power or readings", () => {
  const out = parse();
  expect(out.features).toHaveLength(1);
  expect(out.features[0]).toMatchObject({
    lifecycle: "unknown",
    components: expect.arrayContaining([expect.objectContaining({ kind: "evse" })]),
  });
  expect(out.observations).toEqual([]);
  expect(out.offers).toEqual([]);
  expect(JSON.stringify(out.features)).not.toMatch(/maxPowerKw|amperage|measuredAt/);
  expect(sealFailures(out.features)).toEqual([]);
});
test.each([
  { off_kode: 2 },
  { statuskode: 2 },
  { ladefacilitet_type_kode: 2 },
  { tilgaengelighed_type_kode: 5 },
])("excludes outside public car scope %j", (p) => expect(parse([row(p)]).features).toEqual([]));
test("count disagreement keeps evidence and no fabricated components", () => {
  const f = parse([row({ antal_ladepunkter: 8 })]).features[0]!;
  expect(f["components"] ?? []).toEqual([]);
  expect(f["extras"]).toMatchObject({
    internationalt_id: "DK*SPA*E1",
    internationalt_id1: "DK*SPA*E2",
    antal_ladepunkter: 8,
  });
});
test("validity uses Copenhagen dates including DST and inclusive end day", () => {
  expect(parse([row({ gyldig_fra: "2026-03-29" })], "2026-03-28T22:59:59Z").features).toHaveLength(
    0,
  );
  expect(parse([row({ gyldig_fra: "2026-03-29" })], "2026-03-28T23:00:00Z").features).toHaveLength(
    1,
  );
  expect(parse([row({ gyldig_til: "2026-03-29" })], "2026-03-29T21:59:59Z").features).toHaveLength(
    1,
  );
  expect(parse([row({ gyldig_til: "2026-03-29" })], "2026-03-29T22:00:00Z").features).toHaveLength(
    0,
  );
});

test.each([0, -1, 1, 7])("unresolved count %s never multiplies points", (count) =>
  expect(parse([row({ antal_ladepunkter: count })]).features[0]?.["components"] ?? []).toEqual([]),
);
test.each([1, 2, 3, null])("explicit plan status %s overrides default", (plan) =>
  expect(parse([row({ planstatus_kode: plan })]).features[0]?.["lifecycle"]).toBe(
    plan === 1 ? "operational" : plan === 2 ? "planned" : "unknown",
  ),
);
test("page order and source revisions preserve component identity", () => {
  const a = parse().features[0]!;
  const b = parse([
    row({ versions_id: "v2", internationalt_id: "DK*SPA*E2", internationalt_id1: "DK*SPA*E1" }),
  ]).features[0]!;
  expect(a["id"]).toBe(b["id"]);
  expect(a["components"]).toEqual(b["components"]);
});
test("all six nonempty IDs must agree with the declared count", () => {
  const f = parse([
    row({
      antal_ladepunkter: 6,
      internationalt_id2: "DK*SPA*E3",
      internationalt_id3: "DK*SPA*E4",
      internationalt_id4: "DK*SPA*E5",
      internationalt_id5: "DK*SPA*E6",
    }),
  ]).features[0]!;
  expect((f["components"] as unknown[]).length).toBe(6);
  expect(sealFailures([f])).toEqual([]);
});
test.each(["Type2", "Type 2"])("an explicit single-EVSE %s connector has no rating", (stiktype) => {
  const f = parse([row({ antal_ladepunkter: 1, internationalt_id1: "", stiktype })]).features[0]!;
  expect(f["components"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "connector",
        details: { kind: "connector", v: 1, standard: "IEC_62196_T2" },
      }),
    ]),
  );
});
test("ambiguous CCS never invents a connector standard", () =>
  expect(
    (
      parse([row({ antal_ladepunkter: 1, internationalt_id1: "", stiktype: "CCS" })]).features[0]![
        "components"
      ] as unknown[]
    ).length,
  ).toBe(1));
test.each(["2026-02-30", "2026-01-01T12:00:00", "nonsense"])(
  "invalid administrative date %s refuses the snapshot",
  (gyldig_fra) => expect(() => parse([row({ gyldig_fra })])).toThrow(/validity/),
);
test("duplicate facility identities fail the entire snapshot", () =>
  expect(() => parse([row(), row()])).toThrow(/duplicate/));

test("bounded real GeoFA captures seal in both CRSs and respect exclusions", () => {
  for (const name of ["unsorted4326", "unsorted25832", "twoids", "planned", "bicycles"]) {
    const body = fixture(`geofa/${name}.json`);
    const out = chargingDomain.formats["geofa"]!.parse(
      catalogFeed("dk-geofa-charging"),
      { main: [body] },
      parseContext("2026-11-07T12:00:00Z"),
    );
    expect(sealFailures(out.features), name).toEqual([]);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
    expect(out.features.length, name).toBe(name === "bicycles" ? 0 : 2);
  }
});

test("captured count eight remains unresolved and preserves the named ID", () => {
  const out = chargingDomain.formats["geofa"]!.parse(
    catalogFeed("dk-geofa-charging"),
    { main: [fixture("geofa/count8.json")] },
    parseContext("2026-11-07T12:00:00Z"),
  );
  // The other captured count-eight facility is a bicycle facility outside this scope.
  expect(out.features).toHaveLength(1);
  for (const f of out.features) expect(f["components"] ?? []).toEqual([]);
  expect(JSON.stringify(out.features)).toContain("DK*CLE*E191091");
});
test.each(
  [
    [],
    [
      [12, 55],
      [13, 56],
    ],
    [[null, 55]],
    [[12, 100]],
  ].map((coordinates) => ({ coordinates })),
)("invalid source geometry %j refuses the snapshot", ({ coordinates }) => {
  const r = row();
  r.geometry.coordinates = coordinates as unknown as number[][];
  expect(() => parse([r])).toThrow(/point/);
});
test("projection and CRS84 captures agree on placement", () => {
  const result = (name: string) =>
    chargingDomain.formats["geofa"]!.parse(
      catalogFeed("dk-geofa-charging"),
      { main: [fixture(`geofa/${name}.json`)] },
      parseContext("2026-11-07T12:00:00Z"),
    );
  const a = result("unsorted4326").features[0]!;
  const b = result("unsorted25832").features[0]!;
  expect(a["id"]).toBe(b["id"]);
  expect(a["location"]).toEqual(b["location"]);
});

test("unsafe source attributes and external links never enter inventory records", () => {
  const f = parse([
    row({
      bruger_id: "PRIVATE-UPLOADER",
      kontak_ved: "PRIVATE-CONTACT",
      sagsnr: "PRIVATE-CASE",
      foto_link: "https://example.org/private-photo",
      link: "https://example.org/tariffs",
    }),
  ]).features[0]!;
  expect(JSON.stringify(f)).not.toMatch(/PRIVATE|private-photo|tariffs/);
});

test("reordering pages preserves canonical facility and component drafts", () => {
  const feed = catalogFeed("dk-geofa-charging");
  const bodies = [
    row(),
    row({ objekt_id: "b", internationalt_id: "DK*SPA*E3", internationalt_id1: "DK*SPA*E4" }),
  ].map((feature) =>
    Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [feature] })),
  );
  const one = chargingDomain.formats["geofa"]!.parse(
    feed,
    { main: bodies },
    parseContext("2026-11-07T12:00:00Z"),
  );
  const two = chargingDomain.formats["geofa"]!.parse(
    feed,
    { main: [...bodies].reverse() },
    parseContext("2026-11-07T12:00:00Z"),
  );
  expect(one.features).toEqual(two.features);
  expect(sealFailures(two.features)).toEqual([]);
});

test("rejects distinct EVSE IDs that collapse to one component key", () => {
  expect(() =>
    parse([
      row({
        internationalt_id: "DK*SPA*EA/B",
        internationalt_id1: "DK*SPA*EA#B",
      }),
    ]),
  ).toThrow(/conflicting EVSE component key/);
});
