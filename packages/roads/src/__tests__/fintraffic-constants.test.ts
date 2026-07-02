import { describe, expect, it } from "vitest";
import { parseFintrafficSensorConstants } from "../fintraffic-constants.js";

const constants = JSON.stringify({
  id: 23001,
  sensorConstantValues: [
    { name: "VVAPAAS1", value: 100, validFrom: "01-01", validTo: "05-31" },
    { name: "VVAPAAS1", value: 120, validFrom: "06-01", validTo: "09-30" },
    { name: "VVAPAAS2", value: 110, validFrom: "01-01", validTo: "12-31" },
    { name: "MITTAUSVALI_1", value: 300, validFrom: "01-01", validTo: "12-31" },
  ],
});

describe("parseFintrafficSensorConstants", () => {
  it("selects the VVAPAAS constant whose season contains the date", () => {
    const rows = parseFintrafficSensorConstants(constants, {
      stationId: "23001",
      on: new Date("2026-07-15T00:00:00Z"),
    });
    const byKey = new Map(rows.map((r) => [r.sensorKey, r.freeFlowKph]));
    expect(byKey.get("23001-1")).toBe(120); // summer window
    expect(byKey.get("23001-2")).toBe(110);
  });

  it("selects the winter window for a January date", () => {
    const rows = parseFintrafficSensorConstants(constants, {
      stationId: "23001",
      on: new Date("2026-02-01T00:00:00Z"),
    });
    expect(rows.find((r) => r.sensorKey === "23001-1")!.freeFlowKph).toBe(100);
  });

  it("ignores composite percent-of-free-flow sensors, only bare VVAPAAS1/2", () => {
    const withComposite = JSON.stringify({
      id: 23001,
      sensorConstantValues: [
        { name: "VVAPAAS1", value: 100, validFrom: "01-01", validTo: "12-31" },
        { name: "OHITUKSET_VVAPAAS1", value: 85, validFrom: "01-01", validTo: "12-31" },
      ],
    });
    const rows = parseFintrafficSensorConstants(withComposite, {
      stationId: "23001",
      on: new Date("2026-07-15T00:00:00Z"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ sensorKey: "23001-1", freeFlowKph: 100 });
  });

  it("handles a wrap-around seasonal window (e.g. Nov–Mar)", () => {
    const wrap = JSON.stringify({
      id: 23001,
      sensorConstantValues: [
        { name: "VVAPAAS1", value: 90, validFrom: "11-01", validTo: "03-31" },
        { name: "VVAPAAS1", value: 110, validFrom: "04-01", validTo: "10-31" },
      ],
    });
    const winter = parseFintrafficSensorConstants(wrap, {
      stationId: "23001",
      on: new Date("2026-01-15T00:00:00Z"),
    });
    expect(winter.find((r) => r.sensorKey === "23001-1")!.freeFlowKph).toBe(90);

    const summer = parseFintrafficSensorConstants(wrap, {
      stationId: "23001",
      on: new Date("2026-07-15T00:00:00Z"),
    });
    expect(summer.find((r) => r.sensorKey === "23001-1")!.freeFlowKph).toBe(110);
  });

  it("returns empty on malformed input", () => {
    expect(parseFintrafficSensorConstants("x", { stationId: "1", on: new Date() })).toEqual([]);
  });

  it("returns empty when sensorConstantValues is missing", () => {
    expect(
      parseFintrafficSensorConstants(JSON.stringify({ id: 1 }), {
        stationId: "1",
        on: new Date(),
      })
    ).toEqual([]);
  });

  it("skips non-positive or non-numeric values", () => {
    const bad = JSON.stringify({
      sensorConstantValues: [
        { name: "VVAPAAS1", value: 0, validFrom: "01-01", validTo: "12-31" },
        { name: "VVAPAAS2", value: "not-a-number", validFrom: "01-01", validTo: "12-31" },
      ],
    });
    expect(
      parseFintrafficSensorConstants(bad, { stationId: "1", on: new Date("2026-01-15") })
    ).toEqual([]);
  });
});
