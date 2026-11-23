import { describe, expect, it } from "vitest";
import { scheduleTimezoneForGeometry, timeZoneAt } from "../timezone.js";

describe("timeZoneAt", () => {
  it.each([
    ["Ciudad Juárez", 31.6904, -106.4245, "America/Ciudad_Juarez", "2026-11-21T12:00:00Z", "05"],
    ["Coyhaique", -45.5752, -72.0662, "America/Coyhaique", "2026-07-15T12:00:00Z", "09"],
  ] as const)(
    "uses the current zone and local time for %s",
    (_city, lat, lng, expected, at, hour) => {
      const zone = timeZoneAt(lat, lng);
      expect(zone).toBe(expected);
      expect(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: zone!,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(new Date(at)),
      ).toBe(hour);
    },
  );

  it("resolves an IANA zone from a coordinate", () => {
    expect(timeZoneAt(52, 13)).toBe("Europe/Berlin");
    expect(timeZoneAt(49, -123)).toBe("America/Vancouver");
  });
  it("keeps Nuuk's renamed zone equivalent to its legacy alias", () => {
    const zone = timeZoneAt(64.1835, -51.7216);
    expect(zone).toBe("America/Nuuk");
    const at = new Date("2026-01-15T12:00:00Z");
    const options = { dateStyle: "short", timeStyle: "short" } as const;
    expect(new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone! }).format(at)).toBe(
      new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "America/Godthab" }).format(at),
    );
  });

  it.each([
    [Number.NaN, 13],
    [52, Number.NaN],
    [Number.POSITIVE_INFINITY, 13],
    [52, Number.NEGATIVE_INFINITY],
    [91, 13],
    [-91, 13],
    [52, 181],
    [52, -181],
  ])("returns null for invalid coordinates (%s, %s)", (lat, lng) => {
    expect(timeZoneAt(lat, lng)).toBeNull();
  });
});

describe("scheduleTimezoneForGeometry", () => {
  it.each([
    [-106.4245, 31.6904, "America/Ciudad_Juarez"],
    [-72.0662, -45.5752, "America/Coyhaique"],
  ] as const)("stamps the current zone at (%s, %s)", (lng, lat, expected) => {
    expect(scheduleTimezoneForGeometry({ type: "Point", coordinates: [lng, lat] })).toBe(expected);
  });

  it("resolves from a Point", () => {
    expect(scheduleTimezoneForGeometry({ type: "Point", coordinates: [13, 52] })).toBe(
      "Europe/Berlin",
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
      }),
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
      }),
    ).toBe("Europe/Berlin");
  });
  it("returns null for null/empty geometry", () => {
    expect(scheduleTimezoneForGeometry(null)).toBeNull();
    expect(scheduleTimezoneForGeometry(undefined)).toBeNull();
  });
});
