import { describe, expect, it } from "vitest";
import { createMeasuredDataParser, parseDatexMeasuredData } from "../measuredData.js";
import { createSiteTableParser, parseDatexSiteTable } from "../siteTable.js";
import { CTX, flowFeed, flows, text } from "./flow-fixtures.js";

const feed = flowFeed("nl-ndw-flow");
const table = text("ndw-flow-v3/sites.xml");
const measurements = text("ndw-flow-v3/measurements.xml");
const source = {
  id: feed.id,
  attribution: feed.attribution,
  license: feed.license,
  country: "NL",
  laneNumbering: "left_first" as const,
};
const GAD = "GAD02_Amstd_31_0";
const RWS = "RWS01_MONIBAS_0010vwa0108ra";
const parse = (xml = measurements, sites = parseDatexSiteTable(table)) =>
  parseDatexMeasuredData(xml, source, sites, CTX);

describe("NDW DATEX II v3 flow migration", () => {
  it("joins captured v3 site ids to geometry and indexed metadata", () => {
    const sites = parseDatexSiteTable(table);
    expect([...sites.keys()]).toEqual([GAD, RWS]);
    expect(sites.get(RWS)).toMatchObject({
      version: "1742",
      geometry: { type: "Point", coordinates: [5.04329, 52.32839] },
      name: "0010vwa0108ra",
      nameLang: "nl",
      equipment: "loop",
      laneCount: 2,
    });
    expect(sites.get(RWS)?.channels?.get("2")).toEqual({
      property: "traffic.speed",
      vehicleClass: "any",
      periodSec: 60,
    });
    expect(sites.get(GAD)?.channels?.size).toBe(24);
  });

  it("preserves measured times, counts and all-vehicle totals without counting length bands twice", () => {
    const out = parse();
    expect(out.failed).toBeUndefined();
    expect(out.readings).toHaveLength(2);
    expect(out.readings[0]).toMatchObject({
      site: GAD,
      at: "2026-10-16T09:55:00Z",
      periodSec: 60,
      speedKph: (56 * 11 + 46 * 8) / 19,
      sampleCount: 19,
      volume: 1140,
    });
    expect(out.readings[1]).toMatchObject({
      site: RWS,
      at: "2026-10-16T09:54:00Z",
      speedKph: 62,
      volume: 540,
    });
    expect(out.readings[0]?.channels?.find((c) => c.key === "8")).toMatchObject({
      property: "traffic.speed",
      value: 56,
      sampleCount: 11,
    });
    expect(out.readings[0]?.channels?.some((c) => c.key === "7")).toBe(false);
    expect(out.readings[0]?.declaredChannels?.find((c) => c.key === "7")).toEqual({
      key: "7",
      property: "traffic.speed",
    });
  });

  it("does not invent lane assignments absent from the v3 table", () => {
    expect(parse().readings).toHaveLength(2);
    for (const r of parse().readings) {
      for (const c of r.channels ?? []) expect(c.lane).toBeUndefined();
    }
  });

  it("reads the v3 structured laneNumber when a publisher supplies it", () => {
    const withLane = table.replace(
      "<roa:specificMeasurementValueType>trafficFlow</roa:specificMeasurementValueType>",
      "<roa:specificLane><roa:laneNumber>lane2</roa:laneNumber></roa:specificLane>" +
        "<roa:specificMeasurementValueType>trafficFlow</roa:specificMeasurementValueType>",
    );
    expect(
      parse(measurements, parseDatexSiteTable(withLane)).readings[0]?.channels?.[0],
    ).toMatchObject({
      key: "1",
      lane: 2,
      value: 0,
    });
  });

  it.each(["9999", ""])(
    "refuses a v3 measurement without matching site version (%s)",
    (version) => {
      const xml = measurements.replace(
        `id="${RWS}" version="1742"`,
        `id="${RWS}"${version ? ` version="${version}"` : ""}`,
      );
      expect(parse(xml).readings.map((r) => r.site)).toEqual([GAD]);
    },
  );

  it("does not admit a v3 station whose table omits its revision", () => {
    const unversioned = table.replace(`id="${RWS}" version="1742"`, `id="${RWS}"`);
    expect(parseDatexSiteTable(unversioned).has(RWS)).toBe(false);
    expect(
      parse(measurements, parseDatexSiteTable(unversioned)).readings.map((r) => r.site),
    ).toEqual([GAD]);
  });

  it("keeps a real zero speed but withholds errors, sentinels and zero-input speeds", () => {
    const base = measurements.replace("<com:speed>62.0</com:speed>", "<com:speed>0</com:speed>");
    expect(parse(base).readings[1]?.channels?.find((c) => c.key === "2")?.value).toBe(0);
    for (const change of [
      "<com:dataError>true</com:dataError><com:speed>62.0</com:speed>",
      "<com:speed>-1</com:speed>",
    ]) {
      const xml = measurements.replace("<com:speed>62.0</com:speed>", change);
      expect(parse(xml).readings[1]?.channels?.some((c) => c.key === "2")).toBe(false);
      expect(parse(xml).readings[1]?.channels?.find((c) => c.key === "4")?.value).toBe(64);
    }
    const noInputs = measurements.replace(
      '<roa:averageVehicleSpeed accuracy="0.0">',
      '<roa:averageVehicleSpeed accuracy="0.0" numberOfInputValuesUsed="0">',
    );
    expect(parse(noInputs).readings[1]?.channels?.some((c) => c.key === "2")).toBe(false);
    const badFlow = measurements.replace(
      "<com:vehicleFlowRate>60</com:vehicleFlowRate>",
      "<com:dataError>true</com:dataError><com:vehicleFlowRate>60</com:vehicleFlowRate>",
    );
    expect(parse(badFlow).readings[1]?.volume).toBe(480);
  });

  it("keeps canonical site and channel identities after the endpoint switch", () => {
    const out = flows(feed, measurements, parseDatexSiteTable(table), {
      now: "2026-10-16T09:58:20Z",
      cadenceSec: 60,
    });
    expect(out.features.map((f) => f["id"])).toEqual([
      `oc:feature:nl-ndw-flow:${GAD}`,
      `oc:feature:nl-ndw-flow:${RWS}`,
    ]);
    expect(out.observations).toContainEqual(
      expect.objectContaining({
        property: "traffic.speed",
        result: { type: "quantity", value: 56, unit: "km/h" },
        subject: { kind: "feature", featureId: `oc:feature:nl-ndw-flow:${GAD}`, componentKey: "8" },
      }),
    );
  });

  it("streams nested physicalQuantity wrappers across arbitrary chunk boundaries", () => {
    const siteParser = createSiteTableParser();
    for (let i = 0; i < table.length; i += 7) siteParser.write(table.slice(i, i + 7));
    expect(siteParser.close()).toEqual(parseDatexSiteTable(table));
    const reader = createMeasuredDataParser(source, siteParser.close());
    for (let i = 0; i < measurements.length; i += 7) reader.write(measurements.slice(i, i + 7));
    expect(reader.close()).toEqual(parse());
  });

  it("marks truncated v3 measurements failed rather than publishing a partial snapshot", () => {
    expect(parse(measurements.slice(0, -300)).failed).toBe(true);
  });
});
