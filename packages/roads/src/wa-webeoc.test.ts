import { readFileSync } from "node:fs";
import { buildRegistry, kernelModule } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { expect, it } from "vitest";
import { roadFeed } from "./__tests__/helpers/road-feed.js";
import { parseEvents } from "./parse.js";
import { reconcileRoadSnapshots } from "./snapshot.js";
import { parseWaWebeoc, parseWaWebeocSnapshot } from "./wa-webeoc.js";

const src = {
  id: "au-wa-mainroads-closures-events",
  attribution: "Main Roads WA",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
};
const live = JSON.parse(
  readFileSync(new URL("./__tests__/fixtures/wa-webeoc/live.geojson", import.meta.url), "utf8"),
);
const feature = (props: object = {}, geometry: unknown = live.features[0].geometry) => ({
  ...live.features[0],
  geometry,
  properties: { ...live.features[0].properties, ...props },
});
const body = (...features: unknown[]) => JSON.stringify({ type: "FeatureCollection", features });

it("reads the real caution sample without inventing times, closure, or permission", () => {
  const events = parseWaWebeoc(JSON.stringify(live), src);
  expect(events).toHaveLength(5);
  expect(events).toContainEqual(
    expect.objectContaining({
      id: `${src.id}:${live.features[0].properties.GlobalID.toLowerCase()}`,
      sourceFormat: "wa-webeoc",
    }),
  );
  for (const e of events) {
    expect(e.roadState).toBeUndefined();
    expect(e.situation?.sourceUpdatedAt).toBeUndefined();
    expect(e.validFrom).toBeUndefined();
  }
  expect(events.some((e) => e.description?.includes("lane"))).toBe(true);
});
it.each([
  ["Road closed", "closure"],
  ["Road open with caution", null],
  ["Road open with specified conditions", "unsupported"],
  ["Detour", "detour"],
  ["unrecognized", "unsupported"],
])("keeps %s separate from flooding", (ClosureTyp, effect) => {
  const feed = roadFeed({ ...src, format: "wa-webeoc", snapshot: { completeness: "complete" } });
  const out = parseEvents(
    feed,
    [Buffer.from(body(feature({ ClosureTyp, IncidentTy: "Flooding" })))],
    { fetchedAt: "2026-11-07T01:00:00Z" },
  );
  const s = out.situations[0]!;
  const checked = buildRegistry([kernelModule, roadsModule]).validateDraft(s);
  expect(checked.ok ? [] : checked.issues).toEqual([]);
  expect(s).toMatchObject({ kind: "road_hazard", type: "hazard", subtype: "flooding" });
  const effects = s["effects"] as Array<{ kind: string }>;
  expect(effects.map((e) => e.kind)).toEqual(effect ? [effect] : []);
  expect(JSON.stringify(s)).not.toContain('"sourceUpdatedAt"');
  if (effect === "unsupported")
    expect(JSON.stringify(s)).toContain('"normalization":"unsupported"');
});
it("accounts for unpublished, unlocatable and duplicate records", () => {
  const report = parseWaWebeocSnapshot(
    body(
      feature(),
      feature(),
      feature({ GlobalID: "a".repeat(8) + "-1111-1111-1111-111111111111", publishExt: "No" }),
      feature({ GlobalID: "b".repeat(8) + "-1111-1111-1111-111111111111" }, null),
    ),
    src,
  );
  expect(reconcileRoadSnapshots([report])).toMatchObject({
    inputCount: 4,
    duplicates: 1,
    acceptedIds: [expect.any(String)],
    terminalIds: [expect.any(String)],
    unlocatableIds: [expect.any(String)],
  });
});
it("refuses ambiguous duplicate parts instead of silently losing a geometry", () => {
  expect(() =>
    parseWaWebeoc(
      body(
        feature(),
        feature(
          {},
          {
            type: "LineString",
            coordinates: [
              [115, -30],
              [116, -31],
            ],
          },
        ),
      ),
      src,
    ),
  ).toThrow(/conflict/);
});
it.each([
  "{}",
  "{",
  '{"error":{"code":500}}',
  '{"type":"FeatureCollection","features":[],"exceededTransferLimit":true}',
])("rejects incomplete or error envelopes %s", (input) => {
  expect(() => parseWaWebeoc(input, src)).toThrow();
});
it("supports empty results, fallback identity and multipart geometry without fabricated text", () => {
  expect(parseWaWebeoc(body(), src)).toEqual([]);
  const [e] = parseWaWebeoc(
    body(
      feature(
        {
          GlobalID: null,
          Id: 123,
          Location: null,
          TrafficImp: "",
          Road: null,
          Region: null,
          Suburb: null,
        },
        {
          type: "MultiLineString",
          coordinates: [
            [
              [115, -30],
              [116, -31],
            ],
            [
              [117, -30],
              [118, -31],
            ],
          ],
        },
      ),
    ),
    src,
  );
  expect(e?.id).toBe(`${src.id}:id-123`);
  expect(e?.description).toBeUndefined();
  expect(e?.geometry.type).toBe("MultiLineString");
});

it.each([
  ["Flooding", "road_hazard", "flooding"],
  ["Bushfire", "road_hazard", "wildfire_near_road"],
  ["Animal / Livestock", "incident", "animal"],
  ["Reduced Visibility (fog, smoke, dust over road)", "road_hazard", "low_visibility"],
  ["Pothole / Road Surface Damage", "road_condition", undefined],
  ["unknown incident", "other", undefined],
  ["constructor", "other", undefined],
])("classifies only the exact incident token %s", (IncidentTy, kind, subtype) => {
  const [event] = parseWaWebeoc(body(feature({ IncidentTy })), src);
  expect(event?.situation?.classification).toMatchObject({ kind });
  expect(event?.situation?.classification?.subtype).toBe(subtype);
  expect(event?.situation?.comments?.[0]?.text[0]?.text).toBe(IncidentTy);
});

it("rejects unidentified records and invalid publication flags without treating them as withdrawal", () => {
  for (const props of [{ GlobalID: null, Id: null, FID: null }, { publishExt: null }]) {
    expect(() => parseWaWebeoc(body(feature(props)), src)).toThrow();
  }
  const feed = roadFeed({ ...src, format: "wa-webeoc" });
  const out = parseEvents(feed, [Buffer.from(body(feature({}, null)))]);
  expect(out.records?.unlocatableSituations).toEqual([
    `oc:situation:${src.id}:${live.features[0].properties.GlobalID.toLowerCase()}`,
  ]);
  expect(out.situations).toEqual([]);
});

it("reconciles across pages before publication and preserves geometry-less predecessors", () => {
  const feed = roadFeed({ ...src, format: "wa-webeoc" });
  const one = Buffer.from(body(feature()));
  const duplicate = parseEvents(feed, [one, one]);
  expect(duplicate.records).toMatchObject({ inputCount: 2, uniqueCount: 1, duplicates: 1 });
  expect(duplicate.situations).toHaveLength(1);
  expect(() =>
    parseEvents(feed, [one, Buffer.from(body(feature({ TrafficImp: "changed" })))]),
  ).toThrow(/conflict/);
  const invalid = parseEvents(feed, [
    Buffer.from(
      body(
        feature(
          {},
          {
            type: "LineString",
            coordinates: [
              [1000, -30],
              [116, -31],
            ],
          },
        ),
      ),
    ),
  ]);
  expect(invalid.records?.unlocatable).toBe(1);
});
