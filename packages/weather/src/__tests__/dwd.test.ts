import { readFileSync } from "node:fs";
import { unzipEntries } from "@openconditions/ingest-framework";
import { expect, test } from "vitest";
import { DWD_ROLES, dwdSites, dwdTime, parseDwd } from "../formats/dwd.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, parseContext } from "./helpers/weather-feed.js";
import { buildZip } from "./helpers/zip.js";

const fixture = (s: string) => readFileSync(new URL(`./fixtures/dwd/${s}`, import.meta.url));
const feed = () => catalogFeed("de-dwd-cdc-weather");
const ctx = () => parseContext("2026-11-07T23:05:00Z");
function payloads(): Record<string, Buffer[]> {
  return Object.fromEntries(
    DWD_ROLES.flatMap((role) => [
      [`${role}_stations`, [fixture(`${role}-stations.txt`)]],
      [role, [fixture(`${role}.zip`)]],
    ]),
  );
}
function altered(role: string, change: (s: string) => string) {
  const p = payloads();
  const e = unzipEntries(p[role]![0]!, { maxEntries: 8, maxBytes: 2_000_000 })[0]!;
  p[role] = [buildZip([{ name: e.name, data: change(e.data.toString("latin1")) }])];
  return p;
}

test("real captures join padded IDs, Latin-1 names and source coordinates; canonical registry seals every output", () => {
  const sites = dwdSites(fixture("tu-stations.txt"));
  expect(sites.get("00044")).toMatchObject({
    name: "Großenkneten",
    point: [8.237, 52.9336],
    free: true,
  });
  const out = parseDwd(feed(), payloads(), ctx());
  expect(out.featuresComplete).toBe(false);
  expect(out.features.map((f) => f.id)).toEqual(
    expect.arrayContaining([
      "oc:feature:de-dwd-cdc-weather:00044",
      "oc:feature:de-dwd-cdc-weather:00011",
    ]),
  );
  expect(out.observations.length).toBeGreaterThan(0);
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  expect(out.observations.every((o) => o.aggregation !== "instantaneous")).toBe(true);
});
test.each([
  "202602300000",
  "202613010000",
  "202611072400",
  "202611072399",
  "20261108",
  "202611090000",
])("strict UTC rejects %s before future clamping", (s: string) =>
  expect(() => dwdTime(s, ctx().fetchedAt)).toThrow(),
);
test("midnight retains minutes and UTC", () =>
  expect(dwdTime("202611070010", ctx().fetchedAt)).toBe("2026-11-07T00:10:00Z"));
test("stale observations and old station intervals cannot be made current by retrieval", () => {
  const out = parseDwd(feed(), payloads(), parseContext("2026-11-08T03:00:00Z"));
  expect(out.observations).toEqual([]);
  expect(out.features).toEqual([]);
});
test.each([
  (s: string) => s.replace("TT_10", "BROKEN"),
  (s: string) => s.replace(/;\s*4\.6;/, ";wat;"),
  (s) => s + "\n" + s.split("\n")[1],
  (s: string) => s.replace("202611070000", "202602300000"),
  (s: string) => s.replace("202611070000", "202711070000"),
])("corrupt rows/required fields and duplicate clocks fail the generation", (change) =>
  expect(() => parseDwd(feed(), altered("tu", change), ctx())).toThrow(),
);
test("missing role or ZIP error fails the generation", () => {
  const p = payloads();
  delete p.ff;
  expect(() => parseDwd(feed(), p, ctx())).toThrow();
  p.ff = [Buffer.from("bad")];
  expect(() => parseDwd(feed(), p, ctx())).toThrow();
});
test("latest usable channel value, QN, sentinel and zero stay independent", () => {
  const p = altered(
    "tu",
    (s: string) =>
      s.split(/\r?\n/)[0] +
      "\n44;202611072200;1;-999;5;-999;90;2;eor\n44;202611072210;unknown;-999;-999;-999;0;3;eor\n",
  );
  const out = parseDwd(feed(), p, parseContext("2026-11-07T22:59:59Z"));
  const obs = out.observations.filter((o) =>
    (o.subject as { featureId: string }).featureId.endsWith(":00044"),
  );
  expect(obs.find((o) => o.property === "weather.air_temperature")).toMatchObject({
    result: { value: 5, unit: "Cel" },
    phenomenonTime: { start: "2026-11-07T21:50:00Z", end: "2026-11-07T22:00:00Z" },
    quality: { supplierCode: "QN:1" },
  });
  expect(obs.find((o) => o.property === "weather.humidity")).toMatchObject({
    result: { value: 0, unit: "%" },
    quality: { supplierCode: "QN:unknown" },
  });
});

test("actual marked distribution exceptions carry restricted upstream provenance; partners without an exception stay public", async () => {
  const { isPublicRecord } = await import("@openconditions/ingest-framework");
  const p = payloads();
  p.tu_stations = [
    Buffer.from(
      fixture("tu-stations.txt")
        .toString("latin1")
        .replace(/^(00044[^\n]*?)Frei/m, "$1Gesperrt"),
      "latin1",
    ),
  ];
  const out = parseDwd(feed(), p, ctx());
  const restricted = out.features.find((f) => String(f.id).endsWith(":00044"))!;
  expect(isPublicRecord(restricted as never)).toBe(false);
  expect(isPublicRecord(out.features.find((f) => String(f.id).endsWith(":00011")) as never)).toBe(
    true,
  );
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
});

test("ZIP-only identity never invents geometry and metadata-only IDs are counted", () => {
  const p = altered("tu", (s) => s.replace(/\b44;/g, "99999;"));
  const e = unzipEntries(p.tu![0]!, { maxEntries: 8, maxBytes: 2_000_000 })[0]!;
  p.tu = [buildZip([{ name: e.name.replace("00044", "99999"), data: e.data }])];
  const out = parseDwd(feed(), p, ctx());
  expect(JSON.stringify(out.features)).not.toContain(":99999");
  expect(out.rejected).toBeGreaterThan(100);
});

test("captured latest values have independently pinned units, clocks and aggregation", () => {
  const out = parseDwd(feed(), payloads(), ctx());
  expect(Object.fromEntries(out.observations.map((o) => [o.property, o.result]))).toEqual({
    "weather.air_temperature": { type: "quantity", value: 3.8, unit: "Cel" },
    "weather.dew_point": { type: "quantity", value: 2.9, unit: "Cel" },
    "weather.humidity": { type: "quantity", value: 94.1, unit: "%" },
    "weather.wind_speed": { type: "quantity", value: 0.6, unit: "m/s" },
    "weather.wind_direction": { type: "quantity", value: 50, unit: "deg" },
    "weather.wind_gust": { type: "quantity", value: 1, unit: "m/s" },
    "weather.precipitation_amount": { type: "quantity", value: 0, unit: "mm" },
  });
  for (const o of out.observations)
    expect(o.phenomenonTime).toEqual({
      start: "2026-11-07T22:10:00Z",
      end: "2026-11-07T22:20:00Z",
    });
  expect(
    out.observations.find((o) => o.property === "weather.precipitation_amount")?.aggregation,
  ).toBe("sum");
  expect(out.observations.find((o) => o.property === "weather.wind_gust")?.aggregation).toBe("max");
});

test("metadata relocation conflicts fail rather than moving readings silently", () => {
  const p = payloads();
  p.rr_stations = [
    Buffer.from(
      fixture("rr-stations.txt")
        .toString("latin1")
        .replace(/^(00044[^\n]*?)8\.2370/m, "$19.2370"),
      "latin1",
    ),
  ];
  expect(() => parseDwd(feed(), p, ctx())).toThrow(/geography/);
});

test("ended source epochs exclude measurements without inventing a retirement", () => {
  const p = payloads();
  for (const role of ["tu", "rr"])
    p[`${role}_stations`] = [
      Buffer.from(
        fixture(`${role}-stations.txt`)
          .toString("latin1")
          .replace(/^(00044 \d{8} )\d{8}/m, (_match, prefix: string) => `${prefix}20260101`),
        "latin1",
      ),
    ];
  const out = parseDwd(feed(), p, ctx());
  expect(out.features.map((f) => f.id)).not.toContain("oc:feature:de-dwd-cdc-weather:00044");
  expect(out.featuresComplete).toBe(false);
});

test("real September ZIP-only sentinel leftovers do not become current", () => {
  const p = payloads();
  p.tu!.push(fixture("tu-02362.zip"));
  p.rr!.push(fixture("rr-02254.zip"));
  const out = parseDwd(feed(), p, ctx());
  expect(JSON.stringify(out)).not.toContain(":02362");
  expect(JSON.stringify(out)).not.toContain(":02254");
  expect(out.observations).toHaveLength(7);
});

test.each([
  ["tu", "TT_10"],
  ["tu", "TD_10"],
  ["tu", "RF_10"],
  ["ff", "FF_10"],
  ["ff", "DD_10"],
  ["fx", "FX_10"],
  ["rr", "RWS_10"],
])("rejects converted overflow in %s/%s before sample selection", (role, field) => {
  const p = altered(role, (text) => {
    const rows = text.trim().split(/\r?\n/);
    const index = rows[0]!
      .split(";")
      .map((s) => s.trim())
      .indexOf(field);
    const cells = rows[1]!.split(";");
    cells[index] = "9".repeat(400);
    rows[1] = cells.join(";");
    return rows.join("\n");
  });
  expect(() => parseDwd(feed(), p, ctx())).toThrow(/non-finite/);
});

test("DWD expiry is source end plus one hour even at the boundary", () => {
  const out = parseDwd(feed(), payloads(), ctx());
  for (const o of out.observations)
    expect(o.freshness).toEqual({
      fetchedAt: "2026-11-07T23:05:00Z",
      expiresAt: "2026-11-07T23:20:00Z",
    });
  expect(parseDwd(feed(), payloads(), parseContext("2026-11-07T23:20:00Z")).observations).toEqual(
    [],
  );
});

test("metadata supports channels when a product archive is absent, including its rights and epoch", async () => {
  const { isPublicRecord } = await import("@openconditions/ingest-framework");
  const p = altered("tu", (s) => s.replace(/\b44;/g, "99999;"));
  const e = unzipEntries(p.tu![0]!, { maxEntries: 8, maxBytes: 2_000_000 })[0]!;
  p.tu = [buildZip([{ name: e.name.replace("00044", "99999"), data: e.data }])];
  const station = () =>
    parseDwd(feed(), p, ctx()).features.find(
      (f) => f.id === "oc:feature:de-dwd-cdc-weather:00044",
    )!;
  expect(station().components).toEqual([
    {
      key: "TT_10",
      kind: "sensor_channel",
      details: { kind: "sensor_channel", v: 1, property: "weather.air_temperature" },
    },
    {
      key: "TD_10",
      kind: "sensor_channel",
      details: { kind: "sensor_channel", v: 1, property: "weather.dew_point" },
    },
    {
      key: "RF_10",
      kind: "sensor_channel",
      details: { kind: "sensor_channel", v: 1, property: "weather.humidity" },
    },
    {
      key: "RWS_10",
      kind: "sensor_channel",
      details: { kind: "sensor_channel", v: 1, property: "weather.precipitation_amount" },
    },
  ]);
  p.tu_stations = [
    Buffer.from(
      p.tu_stations![0]!.toString("latin1").replace(/^(00044[^\n]*?)Frei/m, "$1Gesperrt"),
      "latin1",
    ),
  ];
  expect(isPublicRecord(station() as never)).toBe(false);
  p.tu_stations = [
    Buffer.from(
      p.tu_stations[0]!.toString("latin1").replace(
        /^(00044 \d{8} )\d{8}/m,
        (_m, prefix: string) => `${prefix}20260101`,
      ),
      "latin1",
    ),
  ];
  expect(station().components).toEqual([
    {
      key: "RWS_10",
      kind: "sensor_channel",
      details: { kind: "sensor_channel", v: 1, property: "weather.precipitation_amount" },
    },
  ]);
});
