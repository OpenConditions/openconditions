import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import { fixture, parseContext, wfigsFeed } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T21:10:00Z";
const wfigs = hazardsDomain.formats["wfigs"]!;
const feed = wfigsFeed();
const parse = (payloads: FeedPayloads): ParseOutput =>
  wfigs.parse(feed, payloads, parseContext(FETCHED, 300));

const ASPEN = "1CDF5E5A-F22E-4352-A582-C2A47663B93D";
const TARTAR = "DB5448A6-FCAC-4041-A817-6F8198161DBA";
const RX = "B4D2CA1F-461C-4CDA-A854-5AEDD8B20E13";
const NEWMAN = "C2664A2A-3464-4719-BA12-2AB8224829A4";

interface Collection {
  features: { properties: Record<string, unknown>; geometry: unknown }[];
}
const collection = (name: string): Collection =>
  JSON.parse(fixture(name).toString("utf8")) as Collection;
const buffer = (c: unknown) => Buffer.from(JSON.stringify(c));
const payloads = (
  perimeters = "nifc-perimeters.geojson",
  incidents = "nifc-incidents.geojson",
) => ({
  perimeters: [fixture(perimeters)],
  incidents: [fixture(incidents)],
});
const byId = (out: ParseOutput, irwin: string) =>
  out.situations.find((s) => s["id"] === `oc:situation:us-nifc-fires:${irwin}`) as RecordDraft;
const location = (s: RecordDraft) =>
  s["location"] as { geometry: { type: string }; extent: string; admin?: object };

describe("the wfigs format over the captured layers", () => {
  const out = parse(payloads());

  test("every fire is one situation and the complex is skipped", () => {
    expect(out.situations.map((s) => String(s["id"]).split(":").at(-1))).toEqual([
      ASPEN,
      TARTAR,
      RX,
      NEWMAN,
    ]);
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.rejected).toBeUndefined();
  });

  test("Aspen Acres is one record with its perimeter and the incident's fields", () => {
    const s = byId(out, ASPEN);
    expect(s).toMatchObject({
      kind: "natural_hazard",
      type: "wildfire",
      subtype: "wildfire_perimeter",
      planned: false,
      externalIds: [{ scheme: "irwin", id: ASPEN }],
      validity: { status: "active", start: "2026-06-29T12:04:46Z" },
      provenance: {
        sourceId: "us-nifc-fires",
        sourceFormat: "wfigs",
        recordId: ASPEN,
        sourceUpdatedAt: "2026-08-10T14:04:00Z",
      },
      details: {
        name: [{ lang: "en", text: "Aspen Acres" }],
        // The perimeter's GIS acres (102,003.46), not the incident's reported size (102,007).
        areaHa: 41279.34,
        containmentPct: 82,
        discoveredAt: "2026-06-29T12:04:46Z",
        perimeterAt: "2026-08-02T05:30:00Z",
        ignitionCause: "human",
      },
    });
    expect(location(s)).toMatchObject({
      geometry: { type: "MultiPolygon" },
      extent: "area",
      admin: { country: "US", subdivision: "US-CO" },
    });
  });

  test("NEWMAN DR has no perimeter: a point record without a subtype", () => {
    const s = byId(out, NEWMAN);
    expect(s).not.toHaveProperty("subtype");
    expect(s).toMatchObject({
      type: "wildfire",
      planned: false,
      location: {
        geometry: { type: "Point", coordinates: [-81.633058709669, 26.150282549932] },
        extent: "point",
        admin: { country: "US", subdivision: "US-FL" },
      },
      validity: { status: "active", start: "2026-04-13T16:08:00Z" },
      details: {
        name: [{ lang: "en", text: "NEWMAN DR" }],
        areaHa: 701.32,
        containmentPct: 100,
        ignitionCause: "undetermined",
      },
      provenance: { sourceUpdatedAt: "2026-10-06T17:18:47.980Z" },
    });
    expect((s["details"] as object) && "perimeterAt" in (s["details"] as object)).toBe(false);
  });

  test("the prescribed burn is planned, with its perimeter", () => {
    expect(byId(out, RX)).toMatchObject({
      subtype: "prescribed_burn",
      planned: true,
      location: { extent: "area" },
      details: { areaHa: 7.11 },
    });
    expect(byId(out, RX)["details"]).not.toHaveProperty("containmentPct");
    expect(byId(out, RX)["details"]).not.toHaveProperty("ignitionCause");
  });

  test("a perimeter without its incident point is a record of its own", () => {
    expect(byId(out, TARTAR)).toMatchObject({
      subtype: "wildfire_perimeter",
      details: { containmentPct: 100, ignitionCause: "natural" },
    });
    expect(byId(out, TARTAR)["details"]).not.toHaveProperty("perimeterAt");
  });

  test("the accounting counts every feature and skips the complex as terminal", () => {
    expect(out.records).toMatchObject({
      inputCount: 6,
      uniqueCount: 6,
      duplicates: 0,
      accepted: 4,
      terminal: 1,
      unlocatable: 0,
    });
    expect(out.records!.situationRecords).toEqual({
      [`oc:situation:us-nifc-fires:${ASPEN}`]: 2,
      [`oc:situation:us-nifc-fires:${TARTAR}`]: 1,
      [`oc:situation:us-nifc-fires:${RX}`]: 1,
      [`oc:situation:us-nifc-fires:${NEWMAN}`]: 1,
    });
  });

  test("the incident points alone place every fire they list", () => {
    const points = parse({ incidents: [fixture("nifc-incidents.geojson")] });
    expect(points.situations).toHaveLength(2);
    expect(points.situations.map((s) => location(s).extent)).toEqual(["point", "point"]);
    expect(byId(points, ASPEN)).not.toHaveProperty("subtype");
    expect(byId(points, ASPEN)["details"]).toMatchObject({ areaHa: 41280.77 });
  });
});

describe("the wfigs format over altered features", () => {
  const perimeters = () => collection("nifc-perimeters.geojson");
  const incidents = () => collection("nifc-incidents.geojson");

  test("a fire out is ended at its out time", () => {
    const inc = incidents();
    inc.features[0]!.properties["FireOutDateTime"] = Date.parse("2026-10-05T10:00:00Z");
    const out = parse({ incidents: [buffer(inc)] });
    expect(byId(out, NEWMAN)["validity"]).toEqual({
      status: "ended",
      start: "2026-04-13T16:08:00Z",
      end: "2026-10-05T10:00:00Z",
    });
  });

  test("containment outside 0..100 and unknown causes are left out", () => {
    const inc = incidents();
    inc.features[0]!.properties["PercentContained"] = 140;
    inc.features[0]!.properties["FireCause"] = "Lightning?";
    const out = parse({ incidents: [buffer(inc)] });
    expect(byId(out, NEWMAN)["details"]).not.toHaveProperty("containmentPct");
    expect(byId(out, NEWMAN)["details"]).not.toHaveProperty("ignitionCause");
  });

  test("a state that is no ISO 3166-2 code leaves the country alone", () => {
    const inc = incidents();
    inc.features[0]!.properties["POOState"] = "Florida";
    const out = parse({ incidents: [buffer(inc)] });
    expect(location(byId(out, NEWMAN)).admin).toEqual({ country: "US" });
  });

  test("an unreadable perimeter shape leaves the incident's point and is counted", () => {
    const per = perimeters();
    per.features[0]!.geometry = { type: "Polygon", coordinates: [[[200, 40]]] };
    const out = parse({
      perimeters: [buffer(per)],
      incidents: [fixture("nifc-incidents.geojson")],
    });
    expect(location(byId(out, ASPEN)).extent).toBe("point");
    expect(byId(out, ASPEN)).not.toHaveProperty("subtype");
    expect(out.rejected).toBe(1);
    expect(out.records).toMatchObject({ inputCount: 6, uniqueCount: 6, accepted: 4, terminal: 1 });
    expect(sealFailures(out.situations)).toEqual([]);
  });

  test("features with no IRWIN id or no position are rejected, the rest publish", () => {
    const inc = incidents();
    inc.features.push(
      {
        properties: { ...inc.features[0]!.properties, IrwinID: "not-a-guid" },
        geometry: inc.features[0]!.geometry,
      },
      {
        properties: {
          ...inc.features[0]!.properties,
          IrwinID: "{11111111-2222-3333-4444-555555555555}",
        },
        geometry: { type: "Point", coordinates: [-181, 20] },
      },
      {
        properties: {
          ...inc.features[0]!.properties,
          IrwinID: "{11111111-2222-3333-4444-666666666666}",
          IncidentTypeCategory: "OT",
        },
        geometry: inc.features[0]!.geometry,
      },
    );
    const out = parse({ incidents: [buffer(inc)] });
    expect(out.situations).toHaveLength(2);
    expect(out.rejected).toBe(3);
  });

  test("a perimeter whose own id does not read is matched by its incident copy", () => {
    const per = perimeters();
    per.features[0]!.properties["poly_IRWINID"] = "not-a-guid";
    const out = parse({
      perimeters: [buffer(per)],
      incidents: [fixture("nifc-incidents.geojson")],
    });
    expect(location(byId(out, ASPEN)).extent).toBe("area");
    expect(out.rejected).toBeUndefined();
  });

  test("an unknown category counts every record of the fire as rejected", () => {
    const per = perimeters();
    const inc = incidents();
    const aspen = inc.features.find((f) => f.properties["IrwinID"] === `{${ASPEN}}`)!;
    aspen.properties["IncidentTypeCategory"] = "OT";
    const perimeterOfAspen = per.features.find(
      (f) => f.properties["poly_IRWINID"] === `{${ASPEN}}`,
    )!;
    perimeterOfAspen.properties["attr_IncidentTypeCategory"] = "OT";
    const out = parse({ perimeters: [buffer(per)], incidents: [buffer(inc)] });
    expect(byId(out, ASPEN)).toBeUndefined();
    expect(out.rejected).toBe(2);
    expect(out.records).toMatchObject({ inputCount: 6, uniqueCount: 6, accepted: 3, terminal: 1 });
  });

  test("an incident listed twice counts once", () => {
    const inc = incidents();
    inc.features.push(inc.features[0]!);
    const out = parse({ incidents: [buffer(inc)] });
    expect(out.records).toMatchObject({ inputCount: 4, uniqueCount: 3, duplicates: 1 });
    expect(out.situations).toHaveLength(2);
  });

  test("an empty layer is an accounted zero", () => {
    const out = parse({ incidents: [Buffer.from('{"type":"FeatureCollection","features":[]}')] });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 0, accepted: 0, terminal: 0 });
  });
});

describe("the wfigs format over an answer that is no layer", () => {
  test("an ArcGIS error at HTTP 200 fails the parse", () => {
    expect(() => parse({ incidents: [fixture("arcgis-error.json")] })).toThrow(
      /WFIGS answered an error: 400.*BOGUS_FIELD/,
    );
    expect(() =>
      parse({
        perimeters: [fixture("arcgis-error.json")],
        incidents: [fixture("nifc-incidents.geojson")],
      }),
    ).toThrow(/answered an error/);
  });

  test("a body without features fails the parse", () => {
    expect(() => parse({ incidents: [Buffer.from('{"type":"FeatureCollection"}')] })).toThrow(
      /no feature collection/,
    );
  });
});
