import { describe, expect, test } from "vitest";
import { weatherDomain } from "../domain.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/weather-feed.js";

const at = "2026-11-08T01:10:00Z";
const payloads = () => ({
  sites: [fixture("eccc/stations.json")],
  status: [fixture("eccc/caab.json")],
});
const format = () => weatherDomain.formats["eccc-swob"]!;
const feed = () => catalogFeed("ca-eccc-weather");
function status(change: Record<string, unknown>) {
  const d = JSON.parse(fixture("eccc/caab.json").toString());
  Object.assign(d.features[0].properties, change);
  d.numberMatched = d.numberReturned = 1;
  d.links = [];
  return Buffer.from(JSON.stringify(d));
}
const parse = (body = status({})) =>
  format().parse(feed(), { ...payloads(), status: [body] }, parseContext(at));
describe("MSC/CA SWOB", () => {
  test("station-level readings have exact captured values, source times and canonical units", () => {
    const out = parse();
    expect(out.features).toHaveLength(2);
    expect(out.featuresComplete).toBe(false);
    expect(out.features[0]).not.toHaveProperty("components");
    expect(out.observations.map((r) => r["result"])).toEqual([
      { type: "quantity", value: 1.8, unit: "Cel" },
      { type: "quantity", value: 94, unit: "%" },
      { type: "quantity", value: 16.6 / 3.6, unit: "m/s" },
      { type: "quantity", value: 31, unit: "deg" },
      { type: "quantity", value: 0, unit: "mm" },
    ]);
    expect(out.observations[0]).toHaveProperty("freshness.expiresAt", "2026-11-08T02:00:00Z");
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(
      format().parseStatus!(feed(), { status: [status({})] }, parseContext(at), out.statusIndex!)
        .observations,
    ).toEqual(out.observations);
  });
  test.each([-10, -1, 0, 10, 15, 20, null, "100", [100], {}, undefined])("rejects QA %j", (qa) => {
    expect(parse(status({ "air_temp-qa": qa })).observations).toHaveLength(4);
  });
  test.each([null, "", "MSNG", -9999, [2], {}, "1.8"])(
    "rejects missing or malformed value %j",
    (value) => {
      expect(parse(status({ air_temp: value })).observations).toHaveLength(4);
    },
  );
  test.each([1, 2, 4, 5, "1,5", [1], null])("omits flagged values %j", (flag) => {
    expect(parse(status({ "air_temp-data_flag-value": flag })).observations).toHaveLength(4);
  });
  test("future, stale, unmatched, wrong provider and dataset never publish readings", () => {
    for (const change of [
      { "date_tm-value": "2101-06-16T00:00:00Z" },
      { "date_tm-value": "2026-11-07T23:00:00Z" },
      { "msc_id-value": "unknown" },
      { "msc_id-value": [8400416] },
      { "data_pvdr-value": "DFO" },
      { dataset: "marine" },
    ]) {
      expect(parse(status(change)).observations).toEqual([]);
    }
  });
  test("incomplete counts, duplicates and next links cannot withdraw metadata", () => {
    for (const change of [
      { numberMatched: 3 },
      { numberMatched: "unknown" },
      { crs: "EPSG:3857" },
      { numberReturned: 0 },
      { links: [{ rel: "next", href: "https://example.com" }] },
    ]) {
      const p = payloads();
      const d = JSON.parse(p.sites[0]!.toString());
      Object.assign(d, change);
      p.sites = [Buffer.from(JSON.stringify(d))];
      expect(() => format().parse(feed(), p, parseContext(at))).toThrow();
    }
  });
  test("corrections use processing time, with ambiguous equal ranks refused", () => {
    const d = JSON.parse(status({}).toString());
    const corrected = structuredClone(d.features[0]);
    corrected.id = corrected.properties.id = "corrected.xml";
    corrected.properties.air_temp = 2;
    corrected.properties.processed_date_tm = "2026-11-08T01:05:00Z";
    d.features.push(corrected);
    d.numberMatched = d.numberReturned = 2;
    const forward = parse(Buffer.from(JSON.stringify(d))).observations;
    d.features.reverse();
    expect(parse(Buffer.from(JSON.stringify(d))).observations).toEqual(forward);
    expect(forward[0]).toHaveProperty("result.value", 2);
    corrected.properties.processed_date_tm = "2026-11-08T01:01:12.669Z";
    expect(() => parse(Buffer.from(JSON.stringify(d)))).toThrow(/ambiguous/);
  });
  test("real marine/future, suppressed and unmatched captures stay out", () => {
    const out = parse();
    for (const name of ["marine.json", "rejected.json"]) {
      const doc = JSON.parse(fixture(`eccc/${name}`).toString());
      doc.numberMatched = doc.numberReturned = doc.features.length;
      doc.links = [];
      const result = format().parseStatus!(
        feed(),
        { status: [Buffer.from(JSON.stringify(doc))] },
        parseContext("2026-11-08T02:10:00Z"),
        out.statusIndex!,
      );
      expect(result.observations).toEqual([]);
    }
  });
  test("unknown notices, wrong units and timestamp disagreement fail closed", () => {
    expect(
      parse(status({ "data_attrib_not-value": "Additional originator pending review" }))
        .observations,
    ).toEqual([]);
    expect(parse(status({ "air_temp-uom": "K" })).observations).toHaveLength(4);
    expect(parse(status({ obs_date_tm: "2026-11-08T00:59:00Z" })).observations).toEqual([]);
  });
  test("real QA-10 temperatures remain suppressed after a qualified station join", () => {
    const out = format().parse(
      feed(),
      { sites: [fixture("eccc/edge-stations.json")], status: [fixture("eccc/rejected.json")] },
      parseContext("2026-11-08T02:10:00Z"),
    );
    expect(out.features.length).toBeGreaterThan(0);
    expect(out.observations.some((r) => r["property"] === "weather.air_temperature")).toBe(false);
  });
});

test("suppression is explicit authority while an absent channel is not", () => {
  const d = JSON.parse(status({ "air_temp-qa": -10 }).toString());
  delete d.features[0].properties.rel_hum;
  delete d.features[0].properties["rel_hum-qa"];
  const out = parse(Buffer.from(JSON.stringify(d)));
  expect(
    out.observationRevisions?.find((r) => r.property === "weather.air_temperature")?.suppressed,
  ).toBe(true);
  expect(out.observationRevisions?.some((r) => r.property === "weather.humidity")).toBe(false);
});

test("the catalogue projection retains available wind and precipitation flags only", () => {
  const fields = new URL(feed().endpoints["status"]!.url!).searchParams
    .get("properties")!
    .split(",");
  for (const field of ["avg_wnd_spd_10m_pst10mts", "avg_wnd_dir_10m_pst10mts", "pcpn_amt_pst1hr"]) {
    expect(fields).toContain(`${field}-data_flag-value`);
    const d = JSON.parse(status({ [`${field}-data_flag-value`]: 2 }).toString());
    d.features[0].properties = Object.fromEntries(
      Object.entries(d.features[0].properties).filter(([k]) => fields.includes(k)),
    );
    expect(parse(Buffer.from(JSON.stringify(d))).observations).toHaveLength(4);
  }
  expect(fields).not.toContain("air_temp-data_flag-value");
  expect(fields).not.toContain("rel_hum-data_flag-value");
});
