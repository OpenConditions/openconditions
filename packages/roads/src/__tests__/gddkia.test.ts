import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGddkia } from "../gddkia.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "gddkia-pl",
  attribution: "GDDKiA",
  country: "PL",
  license: "CC0-1.0",
};

describe("parseGddkia", () => {
  it("parses the utrdane.xml fixture into WGS84 point RoadEvents", () => {
    const events = parseGddkia(
      readFileSync(join(import.meta.dirname, "fixtures/gddkia-pl/utrdane.xml")),
      SRC
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.geometry?.type === "Point")).toBe(true);
    expect(events.every((e) => e.sourceFormat === "gddkia-xml")).toBe(true);
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
        "<utr><typ>U</typ><nr_drogi>A2</nr_drogi><geo_lat>52.2</geo_lat><geo_long>21.0</geo_long><droga_zamknieta>true</droga_zamknieta><awaria_mostu>false</awaria_mostu></utr>"
      ),
      SRC
    );
    expect(closed[0]!.type).toBe("road_closure");

    const accident = parseGddkia(
      xml(
        "<utr><typ>W</typ><nr_drogi>S8</nr_drogi><geo_lat>52.1</geo_lat><geo_long>21.1</geo_long><droga_zamknieta>false</droga_zamknieta><awaria_mostu>false</awaria_mostu></utr>"
      ),
      SRC
    );
    expect(accident[0]!.type).toBe("accident");

    const works = parseGddkia(
      xml(
        "<utr><typ>U</typ><nr_drogi>A1</nr_drogi><geo_lat>53.0</geo_lat><geo_long>18.5</geo_long><droga_zamknieta>false</droga_zamknieta><awaria_mostu>false</awaria_mostu></utr>"
      ),
      SRC
    );
    expect(works[0]!.type).toBe("roadworks");
  });

  it("skips records without coordinates and tolerates non-XML", () => {
    expect(parseGddkia("<utrudnienia><utr><typ>U</typ></utr></utrudnienia>", SRC)).toEqual([]);
    expect(parseGddkia("", SRC)).toEqual([]);
  });
});
