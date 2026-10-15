import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { weatherDomain } from "../domain.js";
import { DIGITRAFFIC_SENSOR_BY_ID, DIGITRAFFIC_SENSORS } from "../formats/digitraffic-sensors.js";
import { sealFailures, weatherRegistry } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/weather-feed.js";

/** A poll a minute after the data document was published. */
const FETCHED = "2026-10-14T23:25:19Z";

const feed = () => catalogFeed("fi-digitraffic-weather");
const format = weatherDomain.formats["digitraffic-weather"]!;

/** The capture: 8003's details answer stands for one that failed, and the list leaves out 1002. */
const payloads = (): FeedPayloads => ({
  sites: [fixture("fi-digitraffic-weather-stations.json")],
  details: [1001, 1030, 1071, 1174, 7037].map((id) =>
    fixture(`fi-digitraffic-weather-station-${id}.json`),
  ),
  status: [fixture("fi-digitraffic-weather-data.json")],
});

const parse = (p: FeedPayloads = payloads(), fetchedAt = FETCHED): ParseOutput =>
  format.parse(feed(), p, parseContext(fetchedAt));

const featureId = (station: number) => `oc:feature:fi-digitraffic-weather:${station}`;
const station = (out: ParseOutput, id: number) =>
  out.features.find((f) => f["id"] === featureId(id));
const subjectOf = (r: RecordDraft) => r["subject"] as { featureId: string; componentKey?: string };
const readings = (out: { observations: RecordDraft[] }, id: number, property?: string) =>
  out.observations.filter(
    (o) =>
      subjectOf(o).featureId === featureId(id) &&
      (property === undefined || o["property"] === property),
  );

/** The readings of measured values: all but the stations' statuses, which the list states. */
const measured = (rs: readonly RecordDraft[]) =>
  rs.filter((r) => r["property"] !== "device.status");

/** A data document of one station's values, as the API writes them. */
const dataOf = (values: Record<string, unknown>[], id = 1001): Buffer =>
  Buffer.from(
    JSON.stringify({
      dataUpdatedTime: "2026-10-14T23:24:19Z",
      stations: [{ id, dataUpdatedTime: "2026-10-14T23:20:49Z", sensorValues: values }],
    }),
  );

const value = (id: number, v: number, over: Record<string, unknown> = {}) => ({
  id,
  stationId: 1001,
  name: DIGITRAFFIC_SENSOR_BY_ID.get(id)!.name,
  measuredTime: "2026-10-14T23:19:55Z",
  unit: DIGITRAFFIC_SENSOR_BY_ID.get(id)!.unit,
  value: v,
  ...over,
});

describe("digitraffic-weather", () => {
  test("a station is a weather station named and placed from its details", () => {
    const out = parse();
    expect(out.features.map((f) => f["id"])).toEqual(
      [1001, 1030, 1071, 1174, 7037, 8003].map(featureId),
    );
    expect(station(out, 1001)).toMatchObject({
      kind: "weather_station",
      lifecycle: "operational",
      name: [
        { lang: "fi", text: "Tie 1 Espoo, Nupuri" },
        { lang: "sv", text: "Väg 1 Esbo, Nuburböle" },
        { lang: "en", text: "Road 1 Espoo, Nupuri" },
      ],
      location: {
        geometry: { type: "Point", coordinates: [24.596399, 60.228227] },
        roads: [{ ref: "1" }],
        admin: { country: "FI", municipality: "Espoo" },
      },
      externalIds: [{ scheme: "provider", id: "1001", authority: "fi-digitraffic-weather" }],
      details: { kind: "weather_station", v: 1, equipment: ["RWS_200"] },
    });
  });

  test("each road-surface value is a channel keyed by the sensor id; air values are the station's own", () => {
    const nupuri = station(parse(), 1001)!;
    const components = nupuri["components"] as {
      key: string;
      details: { property: string; index?: number };
    }[];
    expect(components.find((c) => c.key === "3")?.details).toEqual({
      kind: "sensor_channel",
      v: 1,
      index: 1,
      property: "road.surface_temperature",
    });
    expect(components.find((c) => c.key === "176")?.details).toMatchObject({
      index: 1,
      property: "road.friction",
    });
    // Every channel is a road-surface value; no air value is one.
    for (const c of components) expect(c.details.property).toMatch(/^road\./);
    const details = nupuri["details"] as { measuredProperties: string[] };
    expect(details.measuredProperties).toEqual(
      expect.arrayContaining(["weather.air_temperature", "road.surface_state", "road.friction"]),
    );
  });

  test("a station's sensors are those it reports; without values, those its details list", () => {
    const out = parse();
    // 1001's details list third and fourth surface temperatures it reports none of.
    const keys = (id: number) =>
      ((station(out, id)!["components"] as { key: string }[] | undefined) ?? []).map((c) => c.key);
    expect(keys(1001)).not.toContain("101");
    // Nor does it have them: KELI_3 and KELI_4 at 0 there are no sensor, not a fault.
    expect(keys(1001)).not.toContain("105");
    expect(keys(1001)).not.toContain("115");
    expect(station(out, 1001)!["details"]).toMatchObject({ surfaceSensorCount: 4 });
    // 1071 collects nothing now: its details stand in, and its lifecycle and status say so.
    expect(station(out, 1071)).toMatchObject({ lifecycle: "temporarily_closed" });
    expect(keys(1071)).toContain("101");
    expect(readings(out, 1071).map((r) => r["property"])).toEqual(["device.status"]);
    // 1174 has optical sensors only: channels, and no air values.
    expect(keys(1174)).toEqual(["176", "177", "178", "179", "186", "187", "188", "189"]);
    expect(
      (station(out, 1174)!["details"] as { measuredProperties: string[] }).measuredProperties,
    ).toEqual(["road.friction", "road.water_film", "road.snow_depth", "road.ice_thickness"]);
  });

  test("a station without details keeps the list's technical name and no road", () => {
    const lapinlahti = station(parse(), 8003)!;
    expect(lapinlahti["name"]).toEqual([{ lang: "und", text: "vt5_Lapinlahti_Mäntylahti" }]);
    expect(lapinlahti["location"]).toEqual({
      geometry: { type: "Point", coordinates: [27.450941, 63.303119] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      admin: { country: "FI" },
    });
    expect(lapinlahti["details"]).not.toHaveProperty("equipment");
  });

  test("values become readings in the model's units, dated by the publisher's measurement", () => {
    const out = parse();
    const [air] = readings(out, 1001, "weather.air_temperature");
    expect(air).toMatchObject({
      temporality: "live",
      subject: { kind: "feature", featureId: featureId(1001) },
      result: { type: "quantity", value: 9.7, unit: "Cel" },
      phenomenonTime: { instant: "2026-10-14T23:19:55Z" },
      aggregation: "instantaneous",
      freshness: { fetchedAt: FETCHED },
      provenance: { sourceFormat: "digitraffic-weather", recordId: "1001" },
    });
    expect(subjectOf(air!)).not.toHaveProperty("componentKey");
    // Wind is the mean and maximum of the last ten minutes.
    expect(readings(out, 1001, "weather.wind_speed")[0]).toMatchObject({
      result: { type: "quantity", value: 0.4, unit: "m/s" },
      phenomenonTime: { start: "2026-10-14T23:09:55Z", end: "2026-10-14T23:19:55Z" },
      aggregation: "mean",
    });
    expect(readings(out, 1001, "weather.wind_gust")[0]).toMatchObject({
      result: { value: 1.5 },
      aggregation: "max",
    });
    expect(readings(out, 1001, "weather.wind_direction")[0]).toMatchObject({
      result: { type: "quantity", value: 180, unit: "deg" },
    });
    expect(readings(out, 1001, "weather.precipitation_type")[0]).toMatchObject({
      result: { type: "category", value: "none", vocabulary: "precipitation_type" },
    });
    // g/l is kg/m³.
    expect(
      readings(out, 8003, "road.salt_concentration").find(
        (r) => subjectOf(r).componentKey === "54",
      ),
    ).toMatchObject({ result: { type: "quantity", value: 7.3, unit: "kg/m3" } });
  });

  test("a surface state is read through the KELI table; the 0 of a sensor the station lacks is none", () => {
    const out = parse();
    const state = (id: number, key: string) =>
      readings(out, id, "road.surface_state").find((r) => subjectOf(r).componentKey === key)?.[
        "result"
      ];
    expect(state(1001, "27")).toEqual({
      type: "category",
      value: "dry",
      vocabulary: "surface_state",
    });
    expect(state(8003, "27")).toEqual({
      type: "category",
      value: "chemically_wet",
      vocabulary: "surface_state",
    });
    // 1030 reports nothing of a first sensor but its KELI_1 of 0.
    expect(state(1030, "27")).toBeUndefined();
    expect(
      (station(out, 1030)!["components"] as { key: string }[]).map((c) => c.key),
    ).not.toContain("27");
    expect(state(1030, "28")).toMatchObject({ value: "wet" });
  });

  test("salt concentration and freezing point are read only where the sensor measures a water film", () => {
    const out = parse();
    const keys = (id: number, property: string) =>
      readings(out, id, property).map((r) => subjectOf(r).componentKey);
    // 1001's sensors measure no water: their 0 g/l and 0 °C are of no solution.
    expect(keys(1001, "road.water_film")).toEqual(["50", "51", "177", "187"]);
    expect(keys(1001, "road.salt_concentration")).toEqual([]);
    expect(keys(1001, "road.freezing_point")).toEqual([]);
    // 8003's are wet and salty.
    expect(keys(8003, "road.salt_concentration")).toEqual(["54", "55"]);
    expect(keys(8003, "road.freezing_point")).toEqual(["10", "11"]);
  });

  test("a station's maintenance state is its device status, dated by the list's change of it", () => {
    const out = parse();
    const status = (id: number) => readings(out, id, "device.status");
    expect(status(1001)).toEqual([
      expect.objectContaining({
        subject: { kind: "feature", featureId: featureId(1001) },
        result: { type: "category", value: "ok", vocabulary: "device_status" },
        phenomenonTime: { instant: "2025-10-30T07:36:31Z" },
        aggregation: "instantaneous",
      }),
    ]);
    const value = (id: number) => (status(id)[0]?.["result"] as { value?: string })?.value;
    expect(value(1174)).toBe("ok");
    // A repair begun and interrupted names no fault; the station reports as usual.
    expect(value(7037)).toBe("ok");
    // Collection removed for now.
    expect(value(1071)).toBe("offline");
    // No state stated: no status.
    expect(status(1030)).toEqual([]);
    expect(status(8003)).toEqual([]);
  });

  test("every maintenance state maps to a device status", () => {
    const states = [
      ["OK", "ok"],
      ["OK_FAULT_DOUBT_CANCELLED", "ok"],
      ["REPAIR_MAINTENANCE_DONE", "ok"],
      ["REPAIR_INTERRUPTED", "ok"],
      ["FAULT_DOUBT", "warning"],
      ["FAULT_CONFIRMED", "error"],
      ["FAULT_CONFIRMED_NOT_FIXED_IN_NEAR_FUTURE", "error"],
      ["REPAIR_REQUEST_POSTED", "error"],
    ] as const;
    const list = JSON.parse(fixture("fi-digitraffic-weather-stations.json").toString("utf8")) as {
      features: { properties: Record<string, unknown> }[];
    };
    const nupuri = list.features.find((f) => f.properties["id"] === 1001)!;
    for (const [state, expected] of states) {
      nupuri.properties["state"] = state;
      const out = parse({ ...payloads(), sites: [Buffer.from(JSON.stringify(list))] });
      expect(readings(out, 1001, "device.status")[0]?.["result"], state).toMatchObject({
        value: expected,
      });
    }
    nupuri.properties["state"] = "SOMETHING_NEW";
    const out = parse({ ...payloads(), sites: [Buffer.from(JSON.stringify(list))] });
    expect(readings(out, 1001, "device.status")).toEqual([]);
  });

  test("numbered surface sensors stay separate series", () => {
    const surface = readings(parse(), 1001, "road.surface_temperature");
    expect(surface.map((r) => subjectOf(r).componentKey)).toEqual(["3", "5"]);
    expect(new Set(surface.map((r) => r["id"])).size).toBe(2);
  });

  test("values older than their property's freshness window are not read", () => {
    const out = parse();
    // Kousa's values are eight hours old: its station stands, with its status alone.
    expect(station(out, 7037)).toBeDefined();
    expect(measured(readings(out, 7037))).toEqual([]);
    // An hour later the whole capture is stale.
    expect(measured(parse(payloads(), "2026-10-15T00:25:00Z").observations)).toEqual([]);
  });

  test("a station the list does not name is counted as rejected", () => {
    const out = parse();
    expect(readings(out, 1002)).toEqual([]);
    expect(out.rejected).toBe(1);
  });

  test("every draft seals against the weather model", () => {
    const out = parse();
    expect(out.observations.length).toBeGreaterThan(50);
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  test("the status-only parse writes the full parse's readings through its index", () => {
    const full = parse();
    expect(full.statusIndex?.get("1001")).toEqual([
      expect.objectContaining({ stationId: "1001", point: [24.596399, 60.228227] }),
    ]);
    const status = format.parseStatus!(
      feed(),
      { status: [fixture("fi-digitraffic-weather-data.json")] },
      parseContext(FETCHED),
      full.statusIndex!,
    );
    expect(status.observations).toEqual(measured(full.observations));
    expect(status.rejected).toBe(1);
  });

  test("a malformed data document fails a status-only parse but not a full one", () => {
    const index = parse().statusIndex!;
    const broken = { status: [Buffer.from("{ not json")] };
    expect(() => format.parseStatus!(feed(), broken, parseContext(FETCHED), index)).toThrow(
      /not JSON/,
    );
    const out = parse({ ...payloads(), ...broken });
    // 8003 has neither details nor values, so nothing says what it measures.
    expect(out.features.map((f) => f["id"])).toEqual([1001, 1030, 1071, 1174, 7037].map(featureId));
    expect(measured(out.observations)).toEqual([]);
    expect(out.rejected).toBe(2);
  });

  describe("one value", () => {
    const index = () => parse().statusIndex!;
    const read = (values: Record<string, unknown>[]) =>
      format.parseStatus!(feed(), { status: [dataOf(values)] }, parseContext(FETCHED), index());

    test("a faulty value is not read; a doubted one carries the publisher's code", () => {
      const out = read([
        value(1, 9.7, { reliability: "FAULTY" }),
        value(9, 8.8, { reliability: "SUSPICIOUS" }),
        value(21, 95, { reliability: "OK" }),
      ]);
      expect(out.observations.map((o) => o["property"])).toEqual([
        "weather.dew_point",
        "weather.humidity",
      ]);
      expect(out.observations[0]).toMatchObject({ quality: { supplierCode: "SUSPICIOUS" } });
      expect(out.observations[1]).not.toHaveProperty("quality");
      expect(out.rejected).toBe(0);
    });

    test("a value in another unit, under another name or with an unknown code is rejected", () => {
      const out = read([
        value(1, 49.5, { unit: "°F" }),
        value(9, 8.8, { name: "KUURAPISTE" }),
        value(27, 42),
        { ...value(1, 0.1), id: 2, name: "ILMA_DERIVAATTA", unit: "°C/h" },
      ]);
      expect(out.observations).toEqual([]);
      // The derivative is a sensor not read, which is no rejection.
      expect(out.rejected).toBe(3);
    });

    test("a publisher's fixed window is the reading's window; a later time is held to the fetch", () => {
      const out = read([
        value(23, 0.3, {
          timeWindowStart: "2026-10-14T23:00:00Z",
          timeWindowEnd: "2026-10-14T23:20:00Z",
        }),
        value(1, 9.9, { measuredTime: "2026-10-14T23:30:00Z" }),
      ]);
      expect(out.observations[0]).toMatchObject({
        phenomenonTime: { start: "2026-10-14T23:00:00Z", end: "2026-10-14T23:20:00Z" },
        aggregation: "mean",
      });
      expect(out.observations[1]).toMatchObject({ phenomenonTime: { instant: FETCHED } });
    });

    test("a precipitation form is read through the present-weather table", () => {
      const forms = [9, 10, 11, 12, 14, 15, 17, 18, 19].map((code) => {
        const [r] = read([value(25, code)]).observations;
        return (r!["result"] as { value: string }).value;
      });
      expect(forms).toEqual([
        "drizzle",
        "rain",
        "snow",
        "sleet",
        "hail",
        "snow",
        "hail",
        "freezing_rain",
        "freezing_rain",
      ]);
      // Very light rain whose form the sensor cannot tell.
      expect(read([value(25, 8)]).observations[0]!["result"]).toEqual({ type: "unknown" });
    });

    test("a KELI of 0 is a fault where the sensor reports other values, and nothing where it reports none", () => {
      const faulty = read([value(3, 1.2), value(27, 0)]).observations;
      expect(faulty.map((o) => o["result"])).toEqual([
        { type: "quantity", value: 1.2, unit: "Cel" },
        { type: "unknown" },
      ]);
      expect(read([value(27, 0), value(5, 1.1)]).observations.map((o) => o["property"])).toEqual([
        "road.surface_temperature",
      ]);
    });

    test("a wet sensor's salt and freezing point are read; a dry one's are not", () => {
      const wet = read([value(50, 0.12), value(54, 30.5), value(10, -1.9)]).observations;
      expect(wet.map((o) => o["property"])).toEqual([
        "road.water_film",
        "road.salt_concentration",
        "road.freezing_point",
      ]);
      const dry = read([value(50, 0), value(54, 359.8), value(10, 0), value(55, 12)]).observations;
      // Only the first sensor is dry: the second states no water film, so its salt stands.
      expect(dry.map((o) => [o["property"], subjectOf(o).componentKey])).toEqual([
        ["road.water_film", "50"],
        ["road.salt_concentration", "55"],
      ]);
    });

    test("a channel the station's feature lacks is not read", () => {
      // 1001 reports no third surface sensor, so its feature has no channel 101.
      expect(read([value(101, 9.1)])).toEqual({ observations: [], rejected: 0 });
    });
  });
});

describe("the sensor table", () => {
  const published = JSON.parse(fixture("fi-digitraffic-weather-sensors.json").toString("utf8")) as {
    sensors: {
      id: number;
      name: string;
      unit: string;
      sensorValueDescriptions: { sensorValue: number; descriptionEn: string }[];
    }[];
  };
  const byId = new Map(published.sensors.map((s) => [s.id, s]));

  test("names every sensor by the publisher's id, name and unit", () => {
    for (const sensor of DIGITRAFFIC_SENSORS) {
      const own = byId.get(sensor.id);
      expect(own?.name, String(sensor.id)).toBe(sensor.name);
      expect(own?.unit, sensor.name).toBe(sensor.unit);
    }
    expect(DIGITRAFFIC_SENSORS).toHaveLength(published.sensors.length);
  });

  test("maps every code the publisher describes, onto the model's vocabularies", () => {
    const registry = weatherRegistry();
    for (const sensor of DIGITRAFFIC_SENSORS) {
      const property = registry.property(sensor.property);
      expect(property, sensor.property).toBeDefined();
      const result = property!.result;
      if (sensor.codes === undefined) {
        expect(result).toEqual({ type: "quantity", unit: sensor.modelUnit });
        continue;
      }
      expect(result).toEqual({ type: "category", vocabulary: sensor.vocabulary });
      const described = byId.get(sensor.id)!.sensorValueDescriptions.map((d) => d.sensorValue);
      // KELI_3 and KELI_4 carry no descriptions of their own; they share KELI_1's.
      const codes =
        described.length > 0
          ? described
          : byId.get(27)!.sensorValueDescriptions.map((d) => d.sensorValue);
      expect(
        Object.keys(sensor.codes)
          .map(Number)
          .sort((a, b) => a - b),
        sensor.name,
      ).toEqual([...codes].sort((a, b) => a - b));
      const values = registry.vocabulary(sensor.vocabulary!)!.values;
      for (const v of Object.values(sensor.codes)) if (v !== null) expect(values).toContain(v);
    }
  });
});
