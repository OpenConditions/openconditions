import { describe, expect, it } from "vitest";
import type { FlowSites } from "../flow-output.js";
import { createSiteTableParser, equipmentOf, parseDatexSiteTable } from "../siteTable.js";
import { fixture, text } from "./flow-fixtures.js";

const TABLE = "ndw-flow/measurement_site_table.xml";

describe("parseDatexSiteTable", () => {
  it("places a Point record at its display point", () => {
    expect(parseDatexSiteTable(fixture(TABLE)).get("PZH01_MST_0065_00")?.geometry).toEqual({
      type: "Point",
      coordinates: [4.536069, 52.0235558],
    });
  });

  it("places a Linear record on its start and end coordinates", () => {
    expect(parseDatexSiteTable(fixture(TABLE)).get("PZH01_MST_0029-00")).toEqual({
      geometry: {
        type: "LineString",
        coordinates: [
          [4.675, 52.009],
          [4.6765, 52.0076],
        ],
      },
      name: "N206 hmp 2.9 Li",
      nameLang: "nl",
      laneCount: 1,
    });
  });

  it("skips records with no resolvable location", () => {
    expect(parseDatexSiteTable(fixture(TABLE)).has("PZH01_MST_NOLOC_00")).toBe(false);
  });

  it("never throws on an empty document", () => {
    expect(parseDatexSiteTable(Buffer.from("<d2LogicalModel/>")).size).toBe(0);
  });

  it("keeps what resolved before a truncation", () => {
    const xml = text(TABLE);
    let sites: FlowSites = new Map();
    expect(() => {
      sites = parseDatexSiteTable(xml.slice(0, xml.indexOf("PZH01_MST_0029-00")));
    }).not.toThrow();
    expect(sites.get("PZH01_MST_0065_00")?.geometry.type).toBe("Point");
  });

  it("shares one channel object per lane/class/period combination", () => {
    const a = parseDatexSiteTable(fixture(TABLE)).get("PZH01_MST_0065_00")!.channels!;
    expect(a.get("7")).toBe(a.get("9"));
  });
});

describe("createSiteTableParser — streaming state machine", () => {
  it("reads the same sites whole or in many mid-element chunks", () => {
    const xml = text(TABLE);
    const parser = createSiteTableParser();
    for (let i = 0; i < xml.length; i += 7) parser.write(xml.slice(i, i + 7));
    expect(parser.close()).toEqual(parseDatexSiteTable(xml));
  });

  it("resolves a Point record split mid-coordinate across two writes", () => {
    const parser = createSiteTableParser();
    const doc = `<measurementSiteTable><measurementSiteRecord id="S1">
      <measurementSiteLocation xsi:type="Point">
        <locationForDisplay><latitude>52.012</latitude><longitude>4.5</longitude></locationForDisplay>
      </measurementSiteLocation></measurementSiteRecord></measurementSiteTable>`;
    const split = doc.indexOf("52.0") + 2;
    parser.write(doc.slice(0, split));
    parser.write(doc.slice(split));
    expect(parser.close().get("S1")?.geometry).toEqual({
      type: "Point",
      coordinates: [4.5, 52.012],
    });
  });

  it("prefers a posList line over a coordinate pair and a display point", () => {
    const parser = createSiteTableParser();
    parser.write(
      `<measurementSiteRecord id="P1"><measurementSiteLocation>` +
        `<locationForDisplay><latitude>9</latitude><longitude>9</longitude></locationForDisplay>` +
        `<gml:posList>52.0 4.0 52.1 4.1</gml:posList>` +
        `</measurementSiteLocation></measurementSiteRecord>`,
    );
    expect(parser.close().get("P1")?.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [4.0, 52.0],
        [4.1, 52.1],
      ],
    });
  });

  it("skips a record with no resolvable location", () => {
    const parser = createSiteTableParser();
    parser.write(
      `<measurementSiteRecord id="N1"><measurementSiteName>x</measurementSiteName></measurementSiteRecord>`,
    );
    expect(parser.close().has("N1")).toBe(false);
  });
});

describe("equipmentOf", () => {
  it("maps the publishers' equipment wording onto the site kind's values", () => {
    expect(equipmentOf("lus")).toBe("loop");
    expect(equipmentOf("Induktionsschleife")).toBe("loop");
    expect(equipmentOf("Radar")).toBe("radar");
    expect(equipmentOf("ANPR camera")).toBe("anpr");
    expect(equipmentOf("something else")).toBeUndefined();
  });
});
