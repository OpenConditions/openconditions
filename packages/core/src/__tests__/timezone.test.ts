import { describe, expect, it } from "vitest";
import { scheduleTimezoneForGeometry, timeZoneAt } from "../timezone.js";

describe("timeZoneAt", () => {
  it("resolves an IANA zone from a coordinate", () => {
    expect(timeZoneAt(52, 13)).toBe("Europe/Berlin");
    expect(timeZoneAt(49, -123)).toBe("America/Vancouver");
  });
  it("returns null for non-finite input", () => {
    expect(timeZoneAt(Number.NaN, 13)).toBeNull();
  });
});

describe("scheduleTimezoneForGeometry", () => {
  it("resolves from a Point", () => {
    expect(scheduleTimezoneForGeometry({ type: "Point", coordinates: [13, 52] })).toBe(
      "Europe/Berlin"
    );
  });
  it("resolves from a LineString's first vertex", () => {
    expect(
      scheduleTimezoneForGeometry({
        type: "LineString",
        coordinates: [
          [-123, 49],
          [-123.1, 49.1],
        ],
      })
    ).toBe("America/Vancouver");
  });
  it("resolves from a Polygon ring", () => {
    expect(
      scheduleTimezoneForGeometry({
        type: "Polygon",
        coordinates: [
          [
            [13, 52],
            [13.1, 52],
            [13.1, 52.1],
            [13, 52],
          ],
        ],
      })
    ).toBe("Europe/Berlin");
  });
  it("returns null for null/empty geometry", () => {
    expect(scheduleTimezoneForGeometry(null)).toBeNull();
    expect(scheduleTimezoneForGeometry(undefined)).toBeNull();
  });
});
