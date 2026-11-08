import { expect, test } from "vitest";
import { weatherDomain } from "../domain.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/weather-feed.js";

const payloads = () => ({
  sites: [fixture("fmi/station-101004.xml"), fixture("fmi/station-100971.xml")],
  status: [fixture("fmi/observations.xml")],
});
const context = parseContext("2026-11-07T01:05:00Z", 600);
const parse = (p = payloads()) =>
  weatherDomain.formats["fmi-weather"]!.parse(catalogFeed("fi-fmi-weather"), p, context);

test("FMI captured coverage joins two meteorological stations by FMISID and representative point", () => {
  const out = parse();
  expect(out.features).toHaveLength(2);
  expect(out.observations).toHaveLength(14);
  expect(out.featuresComplete).toBe(false);
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  expect(out.features.find((f) => String(f.id).endsWith(":101004"))?.location).toMatchObject({
    geometry: { coordinates: [24.96131, 60.20307] },
    external: [{ system: "wmo", code: "02998" }],
  });
  expect(
    out.observations.find(
      (o) =>
        o.property === "weather.air_temperature" &&
        (o.subject as { featureId: string }).featureId.endsWith(":101004"),
    ),
  ).toMatchObject({
    result: { value: 1.4, unit: "Cel" },
    phenomenonTime: { start: "2026-11-07T00:59:00Z", end: "2026-11-07T01:00:00Z" },
    aggregation: "mean",
  });
  expect(
    out.observations.every((o) => o.quality === undefined && o.property !== "device.status"),
  ).toBe(true);
});

test.each(["truncation", "namespace", "cardinality", "exception"])(
  "FMI rejects %s before publication",
  (kind) => {
    const p = payloads();
    const raw = p.status[0]!.toString();
    p.status = [
      Buffer.from(
        kind === "truncation"
          ? raw.slice(0, -50)
          : kind === "namespace"
            ? raw.replace("http://www.opengis.net/wfs/2.0", "https://invalid.example")
            : kind === "cardinality"
              ? raw.replace("2.8 1.2 90.0", "2.8 1.2")
              : '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>',
      ),
    ];
    expect(() => parse(p)).toThrow();
  },
);

test("FMI rolling observations cannot authorize station withdrawal or refresh expired samples", () => {
  const out = weatherDomain.formats["fmi-weather"]!.parse(
    catalogFeed("fi-fmi-weather"),
    payloads(),
    parseContext("2026-11-07T00:55:00Z"),
  );
  expect(out.observations).toHaveLength(14);
  expect(
    out.observations.every(
      (o) => (o.phenomenonTime as { end: string }).end === "2026-11-07T00:50:00Z",
    ),
  ).toBe(true);
  const expired = weatherDomain.formats["fmi-weather"]!.parse(
    catalogFeed("fi-fmi-weather"),
    payloads(),
    parseContext("2026-11-07T05:00:00Z"),
  );
  expect(expired.observations).toEqual([]);
  expect(expired.features).toHaveLength(2);
});

test("FMI maps reordered fields, skips unconfirmed precipitation and selects each property's latest valid sample", () => {
  const p = payloads();
  p.status = [
    Buffer.from(
      p.status[0]!.toString()
        .replace('name="t2m"', 'name="r_1h"')
        .replace('name="td"', 'name="t2m"')
        .replace("1.4 0.7 95.0", "1.4 NaN 95.0"),
    ),
  ];
  const out = parse(p);
  const samples = out.observations.filter((o) =>
    (o.subject as { featureId: string }).featureId.endsWith(":101004"),
  );
  expect(samples.find((o) => o.property === "weather.air_temperature")).toMatchObject({
    result: { value: 0.7 },
    phenomenonTime: { end: "2026-11-07T00:50:00Z" },
  });
  expect(
    samples.some(
      (o) => o.property === "weather.precipitation_amount" || o.property === "weather.dew_point",
    ),
  ).toBe(false);
});

test.each([
  "foreign",
  "other network",
  "restricted",
  "bad axes",
  "invalid epoch",
  "nonfinite epoch",
  "missing namespace",
])("FMI handles synthetic %s metadata or samples conservatively", (kind) => {
  const p = payloads();
  if (kind === "foreign" || kind === "other network") {
    p.sites = p.sites.map((b) =>
      Buffer.from(
        b
          .toString()
          .replaceAll(
            kind === "foreign" ? "Finland" : "networkid=121",
            kind === "foreign" ? "Norway" : "networkid=129",
          ),
      ),
    );
    expect(parse(p).features).toEqual([]);
    expect(parse(p).observations).toEqual([]);
    return;
  }
  if (kind === "restricted")
    p.sites = [
      Buffer.from(
        p.sites[0]!.toString().replace(
          "<ef:mobile>",
          "<ef:accessConstraints>restricted</ef:accessConstraints><ef:mobile>",
        ),
      ),
    ];
  if (kind === "bad axes")
    p.sites = [
      Buffer.from(p.sites[0]!.toString().replace('axisLabels="Lat Long"', 'axisLabels="Long Lat"')),
    ];
  if (kind === "invalid epoch" || kind === "nonfinite epoch")
    p.status = [
      Buffer.from(
        p.status[0]!.toString().replace(
          "1794009600",
          kind === "invalid epoch" ? "1794009600000" : "Infinity",
        ),
      ),
    ];
  if (kind === "missing namespace")
    p.status = [
      Buffer.from(
        p.status[0]!.toString().replace('xmlns:swe="http://www.opengis.net/swe/2.0"', ""),
      ),
    ];
  expect(() => parse(p)).toThrow(/FMI/);
});

test("FMI empty coverage and missing readings retain metadata lifecycle and stable correction identities", () => {
  const p = payloads();
  const out = parse(p);
  const revised = parse({
    ...p,
    status: [Buffer.from(p.status[0]!.toString().replace("1.4 0.7 95.0", "1.8 0.7 95.0"))],
  });
  expect(revised.observations.map((o) => o.id)).toEqual(out.observations.map((o) => o.id));
  const empty = Buffer.from(
    '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0" numberReturned="0"/>',
  );
  const without = parse({ ...p, status: [empty] });
  expect(without.observations).toEqual([]);
  expect(without.features).toHaveLength(2);
  expect(without.features.every((f) => f.lifecycle === "operational")).toBe(true);
  const single = parse({ sites: [p.sites[0]!], status: p.status });
  expect(single.features).toHaveLength(1);
  expect(single.observations).toHaveLength(7);
  const changed = parse({
    sites: p.sites.map((b) => Buffer.from(b.toString().replace("Helsinki Kumpula", "Renamed"))),
    status: p.status,
  });
  expect(changed.features.map((f) => f.id)).toEqual(out.features.map((f) => f.id));
});

test("FMI excludes Antarctic metadata even when upstream country is Finland", () => {
  const p = payloads();
  p.sites = [
    Buffer.from(p.sites[0]!.toString().replace("60.203071 24.961305", "-73.050000 -13.383330")),
  ];
  expect(parse(p).features).toEqual([]);
  expect(parse(p).observations).toEqual([]);
});

test("FMI accepts millisecond worker clocks while retaining strict source UTC and withholding unknown QC", () => {
  const out = weatherDomain.formats["fmi-weather"]!.parse(
    catalogFeed("fi-fmi-weather"),
    payloads(),
    parseContext("2026-11-07T01:05:00.123Z"),
  );
  expect(out.observations).toHaveLength(14);
  const p = payloads();
  p.status = [Buffer.from(p.status[0]!.toString().replace('name="t2m"', 'name="t2m_quality"'))];
  expect(() => parse(p)).toThrow(/unknown field/);
});

const attacks: Record<string, (s: string) => string> = {
  "duplicate station": (s) =>
    s
      .replace(">100971</gml:identifier>", ">101004</gml:identifier>")
      .replaceAll("1.4 0.7 95.0", "NaN 0.7 95.0"),
  "duplicate identifier": (s) =>
    s.replace(
      "</gml:identifier>",
      '</gml:identifier><gml:identifier codeSpace="http://xml.fmi.fi/namespace/stationcode/fmisid">999999</gml:identifier>',
    ),
  "duplicate point": (s) =>
    s.replace("</gml:Point>", '</gml:Point><gml:Point gml:id="point-100971"/>'),
  "nested namespace": (s) =>
    s.replace("<swe:DataRecord>", "<swe:DataRecord xmlns:swe='urn:wrong'>"),
  "out of scope namespace": (s) =>
    s
      .replace('xmlns:swe="http://www.opengis.net/swe/2.0"', "")
      .replace("<swe:field ", '<swe:field xmlns:swe="http://www.opengis.net/swe/2.0" '),
  "hex epoch": (s) => s.replace("1794009600", "0x6aee6800"),
  "exponent epoch": (s) => s.replace("1794009600", "1.7940096e9"),
  "hex coordinate": (s) => s.replaceAll("60.17523", "0x3c"),
  "coverage axes": (s) =>
    s.replace("<gmlcov:SimpleMultiPoint ", '<gmlcov:SimpleMultiPoint axisLabels="time Lat Long" '),
};
test.each(Object.entries(attacks))("FMI refuses %s", (_name, change) => {
  const p = payloads();
  p.status = [Buffer.from(change(p.status[0]!.toString()))];
  expect(() => parse(p)).toThrow(/FMI/);
});
test("FMI accepts single quotes and namespace aliases", () => {
  const p = payloads();
  p.status = [
    Buffer.from(
      p.status[0]!.toString()
        .replaceAll("swe:", "sensor:")
        .replaceAll("xmlns:swe=", "xmlns:sensor=")
        .replace(/="([^"]*)"/g, "='$1'"),
    ),
  ];
  expect(parse(p).observations).toHaveLength(14);
});
test("FMI rejects conflicting identity across bodies and conflicting same-time tuples in either order", () => {
  const p = payloads();
  const raw = p.status[0]!.toString();
  for (const changed of [
    raw.replaceAll("24.96131", "24.96231"),
    raw.replace("1.4 0.7 95.0", "1.9 0.7 95.0"),
  ]) {
    for (const status of [
      [raw, changed],
      [changed, raw],
    ])
      expect(() => parse({ ...p, status: status.map((s) => Buffer.from(s)) })).toThrow(/FMI/);
  }
});

test("FMI metadata identity conflicts and observation cross-joins refuse in either body order", () => {
  const p = payloads();
  const changed = Buffer.from(
    p.sites[0]!.toString().replace("60.203071 24.961305", "60.303071 24.961305"),
  );
  for (const sites of [
    [...p.sites, changed],
    [changed, ...p.sites],
  ])
    expect(() => parse({ ...p, sites })).toThrow(/conflicting metadata/);
  expect(() => parse({ ...p, sites: [changed] })).toThrow(/position conflict/);
  expect(parse({ ...p, status: [...p.status, ...p.status] }).observations).toEqual(
    parse(p).observations,
  );
});
test.each([
  (s: string) => s.replace('xmlns:swe="http://www.opengis.net/swe/2.0"', ""),
  (s: string) => s.replace("<swe:DataRecord>", '<swe:DataRecord xmlns:swe="">'),
  (s: string) =>
    s.replace(
      "<swe:DataRecord>",
      '<swe:DataRecord><a-b:useLimitation xmlns:a-b="urn:rights">restricted</a-b:useLimitation>',
    ),
  (s: string) => s.replace("<swe:DataRecord>", '<swe:DataRecord xmlns:xml="urn:wrong">'),
])("FMI rejects invalid namespace scope and aliased rights statements", (change) => {
  const p = payloads();
  expect(() => parse({ ...p, status: [Buffer.from(change(p.status[0]!.toString()))] })).toThrow(
    /FMI/,
  );
});
test("FMI accepts decimal exponent coordinate wire forms", () => {
  const p = payloads();
  p.status = [
    Buffer.from(
      p.status[0]!.toString()
        .replaceAll("60.20307", "+6.020307e1")
        .replaceAll("24.96131", "2.496131E1"),
    ),
  ];
  expect(parse(p).observations).toHaveLength(14);
});

test("FMI refuses whitespace-altered namespace URIs", () => {
  const p = payloads();
  p.status = [
    Buffer.from(
      p.status[0]!.toString().replace(
        'xmlns:swe="http://www.opengis.net/swe/2.0"',
        'xmlns:swe=" http://www.opengis.net/swe/2.0 "',
      ),
    ),
  ];
  expect(() => parse(p)).toThrow(/namespace/);
});
