import { describe, expect, it } from "vitest";
import type { GeojsonFlowMapping } from "../types.js";
import { flowFeed, flows, readings, site, siteIds, value } from "./flow-fixtures.js";

/** Rennes-style mapping: measured speed + native free-flow + DATEX status. */
const RENNES = "fr-rennesmetropole-flow";
const rennes = flowFeed(RENNES, "geojson-flow", {
  flowMap: {
    idField: "predefinedlocationreference",
    speedField: "averagevehiclespeed",
    freeFlowField: "vitesse_maxi",
    statusField: "trafficstatus",
    updatedField: "datetime",
  },
});

/** Bordeaux-style mapping: categorical status only, mapped to DATEX tokens. */
const BORDEAUX = "fr-bordeauxmetropole-flow";
const bordeaux = flowFeed(BORDEAUX, "geojson-flow", {
  flowMap: {
    idField: "ident",
    statusField: "etat",
    statusMap: { FLUIDE: "freeFlow", DENSE: "heavy", EMBOUTEILLE: "congested", INCONNU: "unknown" },
    updatedField: "mdate",
  },
});

const line = (a: [number, number], b: [number, number]) => ({
  type: "LineString" as const,
  coordinates: [a, b],
});
const collection = (...features: unknown[]) =>
  JSON.stringify({ type: "FeatureCollection", features });

describe("GeoJSON flow", () => {
  it("keeps the measured speed with the native free-flow speed (Rennes shape)", () => {
    const out = flows(
      rennes,
      collection({
        type: "Feature",
        geometry: line([-1.68, 48.11], [-1.67, 48.12]),
        properties: {
          predefinedlocationreference: "10273_D",
          averagevehiclespeed: 83,
          vitesse_maxi: 70,
          trafficstatus: "freeFlow",
          datetime: "2026-07-29T12:49:00+02:00",
        },
      }),
    );
    expect(siteIds(out, RENNES)).toEqual(["10273_D"]);
    const [speed] = readings(out, RENNES, "10273_D", "traffic.speed");
    expect(speed!["result"]).toMatchObject({ value: 83 });
    expect(speed!["baseline"]).toMatchObject({ freeFlow: { value: 70 }, source: "native" });
    expect(speed!["phenomenonTime"]).toEqual({ instant: "2026-07-29T10:49:00.000Z" });
    expect(value(out, RENNES, "10273_D", "traffic.los")).toBe("free_flow");
    expect(out.situations).toEqual([]);
  });

  it("derives a congestion situation when the DATEX status is congested", () => {
    const out = flows(
      rennes,
      collection({
        type: "Feature",
        geometry: line([-1.7, 48.1], [-1.69, 48.1]),
        properties: {
          predefinedlocationreference: "9001_G",
          averagevehiclespeed: 12,
          vitesse_maxi: 90,
          trafficstatus: "congested",
        },
      }),
    );
    expect(value(out, RENNES, "9001_G", "traffic.los")).toBe("queuing");
    expect(
      (readings(out, RENNES, "9001_G", "traffic.speed")[0]!["baseline"] as { ratio: number }).ratio,
    ).toBeCloseTo(12 / 90, 3);
    expect(out.situations).toHaveLength(1);
    expect(out.situations[0]).toMatchObject({
      kind: "congestion",
      provenance: { sourceFormat: "geojson-flow" },
    });
  });

  it("maps a categorical status with no speed via statusMap and skips unknowns (Bordeaux shape)", () => {
    const out = flows(
      bordeaux,
      collection(
        {
          type: "Feature",
          geometry: line([-0.6, 44.82], [-0.601, 44.821]),
          properties: { ident: "I83", etat: "EMBOUTEILLE", mdate: "2026-07-29T10:45:50+00:00" },
        },
        {
          type: "Feature",
          geometry: line([-0.5, 44.8], [-0.501, 44.801]),
          properties: { ident: "I99", etat: "INCONNU", mdate: "2026-07-29T10:45:50+00:00" },
        },
      ),
    );
    // INCONNU → unknown, no speed → dropped; only the EMBOUTEILLE segment survives.
    expect(siteIds(out, BORDEAUX)).toEqual(["I83"]);
    expect(readings(out, BORDEAUX, "I83", "traffic.speed")).toEqual([]);
    expect(value(out, BORDEAUX, "I83", "traffic.los")).toBe("queuing");
    expect(out.situations).toHaveLength(1);
  });

  it("skips features with no usable geometry", () => {
    const out = flows(
      bordeaux,
      collection({ type: "Feature", geometry: null, properties: { ident: "X", etat: "DENSE" } }),
    );
    expect(out.features).toEqual([]);
  });

  it("maps averageSpeed + condition and unwraps a GeometryCollection (Victoria shape)", () => {
    const VIC = "au-vic-vicroads-flow";
    const flowMap: GeojsonFlowMapping = {
      idField: "id",
      speedField: "averageSpeed",
      statusField: "condition",
      statusMap: { Light: "freeFlow", Medium: "heavy", Heavy: "congested" },
      updatedField: "publishedTime",
    };
    const out = flows(
      flowFeed(VIC, "geojson-flow", { flowMap }),
      collection({
        type: "Feature",
        geometry: {
          type: "GeometryCollection",
          geometries: [line([145.09, -37.87], [145.12, -37.88])],
        },
        properties: {
          id: "Streams:1",
          averageSpeed: 20,
          condition: "Heavy",
          publishedTime: "2026-07-29T08:15:00",
        },
      }),
    );
    expect(siteIds(out, VIC)).toEqual(["Streams:1"]);
    expect(value(out, VIC, "Streams:1", "traffic.speed")).toBe(20);
    expect(value(out, VIC, "Streams:1", "traffic.los")).toBe("queuing");
    expect(
      (site(out, VIC, "Streams:1")!["location"] as { geometry: { type: string } }).geometry.type,
    ).toBe("LineString");
    expect(out.situations).toHaveLength(1);
  });

  it("refuses non-JSON and a non-collection as a hard parse failure", () => {
    expect(() => flows(rennes, "not json <")).toThrow("hard parse failure");
    expect(() => flows(rennes, JSON.stringify({ foo: 1 }))).toThrow("hard parse failure");
  });
});
