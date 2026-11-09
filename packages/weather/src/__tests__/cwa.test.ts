import { expect, test } from "vitest";
import { weatherDomain } from "../domain.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/weather-feed.js";

const sample = () => JSON.parse(fixture("tw-cwa-preview.txt").toString());
const parse = (body = sample(), at = "2026-11-08T06:11:00Z") =>
  weatherDomain.formats["cwa-weather"]!.parse(
    catalogFeed("tw-cwa-weather"),
    { main: [Buffer.from(JSON.stringify(body))] },
    parseContext(at, 600),
  );

test("CWA numeric strings seal with stable station/channel identities and OGDL", () => {
  const out = parse();
  expect(out.features).toHaveLength(1);
  expect(out.observations).toHaveLength(4);
  expect(out.features[0]).toMatchObject({
    id: "oc:feature:tw-cwa-weather:466940",
    lifecycle: "unknown",
    location: { geometry: { coordinates: [121.740475, 25.133314] } },
    provenance: { sourceFormat: "cwa-weather", attribution: { license: "OGDL-Taiwan-1.0" } },
  });
  expect(out.observations.find((r) => r["property"] === "weather.humidity")).toMatchObject({
    result: { value: 62, unit: "%" },
    phenomenonTime: { instant: "2026-11-08T06:10:00Z" },
  });
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  expect(parse()).toEqual(out);
  expect(out).toHaveProperty("featuresComplete", false);
});

test.each(["X", "-99", "-99.0", "990", "", " ", "0x10", "1e2", true, null, [], 20])(
  "CWA rejects non-wire and sentinel temperature %j",
  (value) => {
    const body = sample();
    body.records.Station[0].WeatherElement.AirTemperature = value;
    expect(
      parse(body).observations.filter((r) => r["property"] === "weather.air_temperature"),
    ).toEqual([]);
  },
);

test.each(["-5.2", "0.0", "-0.0"])("CWA preserves valid temperature %s", (value) => {
  const body = sample();
  body.records.Station[0].WeatherElement.AirTemperature = value;
  expect(
    parse(body).observations.find((r) => r["property"] === "weather.air_temperature"),
  ).toMatchObject({ result: { value: Number(value) } });
});

test.each([
  "2026-02-30T08:00:00+08:00",
  "2026-11-08T06:12:00Z",
  "2026-11-08",
  "2026-11-08T06:00:00",
  "2026-11-08T24:00:00+08:00",
])("invalid or future source time %s fails coherently", (time) => {
  const body = sample();
  body.records.Station[0].ObsTime.DateTime = time;
  expect(() => parse(body)).toThrow();
});

test("stale source readings are not renewed by fetching; coordinate order is irrelevant", () => {
  const body = sample();
  body.records.Station[0].GeoInfo.Coordinates.reverse();
  expect(parse(body)).toEqual(parse());
  expect(parse(body, "2026-11-08T08:00:00Z").observations).toEqual([]);
});

test.each(["T", "-98", "0.0", "2.0", "-990.0"])(
  "rain %s withheld across midnight pending reset qualification",
  (value) => {
    for (const time of ["2026-11-07T23:59:00+08:00", "2026-11-08T00:00:00+08:00"]) {
      const body = sample();
      body.records.Station[0].ObsTime.DateTime = time;
      body.records.Station[0].WeatherElement.Now.Precipitation = value;
      expect(
        parse(body).observations.some((r) => r["property"] === "weather.precipitation_amount"),
      ).toBe(false);
    }
  },
);

test("partial envelopes, duplicate stations and inconsistent WGS84 fail coherently", () => {
  for (const change of [
    (b: ReturnType<typeof sample>) => {
      b.success = "false";
    },
    (b: ReturnType<typeof sample>) => {
      b.records.Station.push(b.records.Station[0]);
    },
    (b: ReturnType<typeof sample>) => {
      b.records.Station[0].GeoInfo.Coordinates.push({
        ...b.records.Station[0].GeoInfo.Coordinates[1],
        StationLongitude: "122",
      });
    },
    (b: ReturnType<typeof sample>) => {
      b.records.Station[0].GeoInfo.Coordinates = [];
    },
    (b: ReturnType<typeof sample>) => {
      b.records.Station = {};
    },
    (b: ReturnType<typeof sample>) => {
      b.records.Station[0].WeatherElement = [];
    },
  ]) {
    const body = sample();
    change(body);
    expect(() => parse(body)).toThrow();
  }
});
