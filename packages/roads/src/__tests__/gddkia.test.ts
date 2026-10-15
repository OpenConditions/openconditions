import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGddkia } from "../gddkia.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "pl-gddkia-events",
  attribution: "GDDKiA",
  country: "PL",
  license: "CC0-1.0",
};

describe("parseGddkia", () => {
  it("parses the utrdane.xml fixture into WGS84 point RoadEvents", () => {
    const events = parseGddkia(
      readFileSync(join(import.meta.dirname, "fixtures/gddkia-pl/utrdane.xml")),
      SRC,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.geometry?.type === "Point")).toBe(true);
    expect(events.every((e) => e.sourceFormat === "gddkia")).toBe(true);
    // Poland WGS84 bounds.
    const g = events[0]!.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    expect(g.coordinates[0]!).toBeGreaterThan(14);
    expect(g.coordinates[0]!).toBeLessThan(24);
    expect(g.coordinates[1]!).toBeGreaterThan(49);
    expect(g.coordinates[1]!).toBeLessThan(55);
  });

  it("derives type from typ + the boolean flags", () => {
    const xml = (utr: string) => `<?xml version="1.0"?><utrudnienia>${utr}</utrudnienia>`;
    const closed = parseGddkia(
      xml(
        "<utr><typ>U</typ><nr_drogi>A2</nr_drogi><geo_lat>52.2</geo_lat><geo_long>21.0</geo_long><droga_zamknieta>true</droga_zamknieta><awaria_mostu>false</awaria_mostu></utr>",
      ),
      SRC,
    );
    expect(closed[0]!.type).toBe("road_closure");

    const accident = parseGddkia(
      xml(
        "<utr><typ>W</typ><nr_drogi>S8</nr_drogi><geo_lat>52.1</geo_lat><geo_long>21.1</geo_long><droga_zamknieta>false</droga_zamknieta><awaria_mostu>false</awaria_mostu></utr>",
      ),
      SRC,
    );
    expect(accident[0]!.type).toBe("accident");

    const works = parseGddkia(
      xml(
        "<utr><typ>U</typ><nr_drogi>A1</nr_drogi><geo_lat>53.0</geo_lat><geo_long>18.5</geo_long><droga_zamknieta>false</droga_zamknieta><awaria_mostu>false</awaria_mostu></utr>",
      ),
      SRC,
    );
    expect(works[0]!.type).toBe("roadworks");
  });

  it("skips records without coordinates and tolerates non-XML", () => {
    expect(parseGddkia("<utrudnienia><utr><typ>U</typ></utr></utrudnienia>", SRC)).toEqual([]);
    expect(parseGddkia("", SRC)).toEqual([]);
  });
});

describe("GDDKiA native kilometre references", () => {
  const sample = (km: string, dl: string, road = "S7x") =>
    `<utrudnienia><utr><nr_drogi>${road}</nr_drogi><km>${km}</km><dl>${dl}</dl><geo_lat>52.2</geo_lat><geo_long>21</geo_long></utr></utrudnienia>`;

  it("preserves suffix sections, zero chainage and reported length without guessing an endpoint", async () => {
    const { locationOf } = await import("../situation/location.js");
    const event = parseGddkia(sample("0", "2,750"), SRC)[0]!;
    const location = locationOf(event, SRC);
    expect(location["linear"]).toEqual({
      system: "kilometre_post",
      ref: "S7x",
      from: 0,
      reportedLengthM: 2750,
      authority: "GDDKiA",
    });
    expect(location["geometry"]).toEqual({ type: "Point", coordinates: [21, 52.2] });
    expect(location["linear"]).not.toHaveProperty("to");
    expect(event.id).toBe(parseGddkia(sample("0", "40"), SRC)[0]!.id);
  });

  it.each(["", "-1", "NaN", "Infinity", "1.2junk"])(
    "does not invent a starting kilometre from %j",
    async (km) => {
      const { locationOf } = await import("../situation/location.js");
      expect(locationOf(parseGddkia(sample(km, "2"), SRC)[0]!, SRC)["linear"]).toBeUndefined();
    },
  );

  it("keeps a valid start when length is absent or invalid, including explicit zero length", async () => {
    const { locationOf } = await import("../situation/location.js");
    for (const dl of ["", "-1", "1km"]) {
      expect(locationOf(parseGddkia(sample("123.5", dl), SRC)[0]!, SRC)["linear"]).toEqual({
        system: "kilometre_post",
        ref: "S7x",
        from: 123.5,
        authority: "GDDKiA",
      });
    }
    expect(locationOf(parseGddkia(sample("123.5", "0"), SRC)[0]!, SRC)["linear"]).toMatchObject({
      reportedLengthM: 0,
    });
    expect(locationOf(parseGddkia(sample("1", "2", ""), SRC)[0]!, SRC)["linear"]).toBeUndefined();
  });
});
