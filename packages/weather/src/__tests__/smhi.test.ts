import { createHash } from "node:crypto";
import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { parseSmhi, parseSmhiStatus, SMHI_PARAMETERS } from "../formats/smhi.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/weather-feed.js";

beforeEach(() => __resetSkips());
const feed = () => catalogFeed("se-smhi-weather");
const ctx = parseContext("2026-11-08T00:30:00Z");
const captures = () =>
  Object.fromEntries(
    ["sites", "status"].map((role) => [
      role,
      SMHI_PARAMETERS.map((p) => fixture(`smhi/${p.key}-${role}.json.raw`)),
    ]),
  );
const synthetic = () => {
  const p = captures();
  for (const role of ["sites", "status"])
    p[role] = p[role]!.map((b) => {
      const d = JSON.parse(b.toString());
      d.station = [
        {
          key: "123",
          name: "Test",
          owner: "Other owner",
          measuringStations: "CORE",
          active: true,
          latitude: 60,
          longitude: 18,
          from: 0,
          to: 1794096000000,
          value: [{ date: 1794096000000, value: "0", quality: "G" }],
        },
      ];
      return Buffer.from(JSON.stringify(d));
    });
  return p;
};
function change(
  p: ReturnType<typeof captures>,
  role: string,
  mutate: (d: {
    station: {
      active: boolean;
      measuringStations: string;
      latitude: number;
      longitude: number;
      value: { date: unknown; value: unknown; quality: string }[];
    }[];
    parameter: { unit: string; key: string };
    period: { key: string };
  }) => void,
  i = 0,
) {
  const d = JSON.parse(p[role]![i]!.toString());
  mutate(d);
  p[role]![i] = Buffer.from(JSON.stringify(d));
}

test("all eight actual envelopes seal; metadata and bulk reorder without changing joins", () => {
  const p = captures();
  const out = parseSmhi(feed(), p, ctx);
  expect(out.features.length).toBeGreaterThan(180);
  expect(out.observations.length).toBeGreaterThan(1000);
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  expect(parseSmhiStatus(feed(), p, ctx, out.statusIndex!).observations).toEqual(out.observations);
  p["sites"]!.reverse();
  p["status"]!.reverse();
  expect(parseSmhi(feed(), p, ctx)).toEqual(out);
  expect(out.features.some((f) => (f["extras"] as { owner: string }).owner !== "SMHI")).toBe(true);
});

test("independent expected mapping, source times, zero rain and quality", () => {
  const p = synthetic();
  change(p, "status", (d) => {
    d.station[0]!.value[0]!.quality = "Y";
  });
  const out = parseSmhi(feed(), p, ctx);
  expect(out.features).toHaveLength(1);
  expect(out.observations).toHaveLength(8);
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  expect(
    out.observations.map((o) => [
      o["property"],
      o["result"],
      o["aggregation"],
      o["phenomenonTime"],
    ]),
  ).toEqual([
    [
      "weather.air_temperature",
      { type: "quantity", value: 0, unit: "Cel" },
      "instantaneous",
      { instant: "2026-11-08T00:00:00Z" },
    ],
    [
      "weather.dew_point",
      { type: "quantity", value: 0, unit: "Cel" },
      "instantaneous",
      { instant: "2026-11-08T00:00:00Z" },
    ],
    [
      "weather.humidity",
      { type: "quantity", value: 0, unit: "%" },
      "instantaneous",
      { instant: "2026-11-08T00:00:00Z" },
    ],
    [
      "weather.visibility",
      { type: "quantity", value: 0, unit: "m" },
      "instantaneous",
      { instant: "2026-11-08T00:00:00Z" },
    ],
    [
      "weather.wind_direction",
      { type: "quantity", value: 0, unit: "deg" },
      "mean",
      { start: "2026-11-07T23:50:00Z", end: "2026-11-08T00:00:00Z" },
    ],
    [
      "weather.wind_speed",
      { type: "quantity", value: 0, unit: "m/s" },
      "mean",
      { start: "2026-11-07T23:50:00Z", end: "2026-11-08T00:00:00Z" },
    ],
    [
      "weather.wind_gust",
      { type: "quantity", value: 0, unit: "m/s" },
      "max",
      { start: "2026-11-07T23:00:00Z", end: "2026-11-08T00:00:00Z" },
    ],
    [
      "weather.precipitation_amount",
      { type: "quantity", value: 0, unit: "mm" },
      "sum",
      { start: "2026-11-07T23:00:00Z", end: "2026-11-08T00:00:00Z" },
    ],
  ]);
  expect(out.observations[0]).toMatchObject({
    quality: { supplierCode: "Y" },
    validUntil: "2026-11-08T01:00:00Z",
    freshness: { expiresAt: "2026-11-08T01:00:00Z" },
  });
  const before = out.observations[0]!;
  change(p, "status", (d) => {
    d.station[0]!.value[0]!.value = "1.5";
  });
  const revised = parseSmhi(feed(), p, ctx).observations[0]!;
  expect(revised["subject"]).toEqual(before["subject"]);
  expect(revised["phenomenonTime"]).toEqual(before["phenomenonTime"]);
});

describe("synthetic edge mutations of captured envelopes", () => {
  test.each([null, []])("missing %j never closes metadata or invents zero", (value) => {
    const p = synthetic();
    change(p, "status", (d) => {
      d.station[0]!.value = value as never;
    });
    const out = parseSmhi(feed(), p, ctx);
    expect(out.features).toHaveLength(1);
    expect(out.observations).toHaveLength(7);
    expect(out.features[0]!["components"] as unknown[]).toHaveLength(8);
  });
  test.each(["", "NaN", "1e999", "12oops", "Infinity", "0x10", " "])(
    "rejects numeric %s",
    (value) => {
      const p = synthetic();
      change(p, "status", (d) => {
        d.station[0]!.value[0]!.value = value;
      });
      const out = parseSmhi(feed(), p, ctx);
      expect(out.observations).toHaveLength(7);
      expect(out.rejected).toBe(0);
      expect(drainSkipped(feed().id)).toEqual({ unknown_value: 1 });
    },
  );
  test.each(["R", "X"])("rejects and counts QC %s", (quality) => {
    const p = synthetic();
    change(p, "status", (d) => {
      d.station[0]!.value[0]!.quality = quality;
    });
    expect(parseSmhi(feed(), p, ctx)).toMatchObject({ rejected: 0 });
    expect(drainSkipped(feed().id)).toEqual({ unknown_value: 1 });
  });
  test.each([1794096000, 1794096000000.5, "2026-02-30", 1794099600000, 1e100])(
    "rejects invalid/stale/future time %s",
    (date) => {
      const p = synthetic();
      change(p, "status", (d) => {
        d.station[0]!.value[0]!.date = date;
      });
      expect(parseSmhi(feed(), p, ctx).observations).toHaveLength(7);
    },
  );
  test("inactive/additional membership excludes only that channel", () => {
    const p = synthetic();
    change(p, "sites", (d) => {
      d.station[0]!.active = false;
    });
    change(
      p,
      "sites",
      (d) => {
        d.station[0]!.measuringStations = "ADDITIONAL";
      },
      1,
    );
    const out = parseSmhi(feed(), p, ctx);
    expect(out.features).toHaveLength(1);
    expect(out.observations).toHaveLength(6);
  });
  test.each(["unit", "parameter", "period", "duplicate", "partial", "geometry", "moved"])(
    "fails incoherent %s atomically",
    (fault) => {
      const p = synthetic();
      if (fault === "unit")
        change(p, "status", (d) => {
          d.parameter.unit = "K";
        });
      if (fault === "parameter")
        change(p, "status", (d) => {
          d.parameter.key = "999";
        });
      if (fault === "period")
        change(p, "status", (d) => {
          d.period.key = "latest-day";
        });
      if (fault === "duplicate") p["status"]![1] = p["status"]![0]!;
      if (fault === "partial") p["status"]!.pop();
      if (fault === "geometry")
        change(p, "sites", (d) => {
          d.station[0]!.latitude = 999;
        });
      if (fault === "moved")
        change(p, "status", (d) => {
          d.station[0]!.longitude = 19;
        });
      expect(() => parseSmhi(feed(), p, ctx)).toThrow();
    },
  );
  test("duplicate values coalesce; conflicting duplicates fail", () => {
    const p = synthetic();
    change(p, "status", (d) => {
      d.station[0]!.value.push({ ...d.station[0]!.value[0]! });
    });
    expect(parseSmhi(feed(), p, ctx).observations).toHaveLength(8);
    change(p, "status", (d) => {
      d.station[0]!.value[1]!.value = "7";
    });
    expect(() => parseSmhi(feed(), p, ctx)).toThrow(/duplicates/);
  });
});

test("captured bytes match their provenance receipt", () => {
  const rows = JSON.parse(fixture("smhi/provenance.json").toString()) as {
    file: string;
    sha256: string;
    url: string;
    retrievedAt: string;
  }[];
  expect(rows).toHaveLength(24);
  for (const row of rows) {
    expect(
      createHash("sha256")
        .update(fixture(`smhi/${row.file}`))
        .digest("hex"),
    ).toBe(row.sha256);
    expect(row.retrievedAt).toMatch(/^2026-11-08/);
  }
});
