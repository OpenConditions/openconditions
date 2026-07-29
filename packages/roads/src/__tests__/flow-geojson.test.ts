import { describe, expect, it } from "vitest";
import { parseGeojsonFlow } from "../flow-geojson.js";
import type { SourceDescriptor } from "../types.js";

/** Rennes-style descriptor: measured speed + native free-flow + DATEX status. */
const rennes = {
  id: "fr-rennesmetropole",
  attribution: "Rennes Métropole",
  country: "FR",
  license: "ODbL-1.0",
  flowMap: {
    idField: "predefinedlocationreference",
    speedField: "averagevehiclespeed",
    freeFlowField: "vitesse_maxi",
    statusField: "trafficstatus",
    updatedField: "datetime",
  },
} as SourceDescriptor;

/** Bordeaux-style descriptor: categorical status only, mapped to DATEX tokens. */
const bordeaux = {
  id: "fr-bordeauxmetropole",
  attribution: "Bordeaux Métropole",
  country: "FR",
  license: "etalab-2.0",
  flowMap: {
    idField: "ident",
    statusField: "etat",
    statusMap: { FLUIDE: "freeFlow", DENSE: "heavy", EMBOUTEILLE: "congested", INCONNU: "unknown" },
    updatedField: "mdate",
  },
} as SourceDescriptor;

const line = (a: [number, number], b: [number, number]) => ({
  type: "LineString" as const,
  coordinates: [a, b],
});

describe("parseGeojsonFlow", () => {
  it("maps measured speed + native free-flow into a RoadFlow (Rennes shape)", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: line([-1.68, 48.11], [-1.67, 48.12]),
          properties: {
            predefinedlocationreference: "10273_D",
            averagevehiclespeed: 83,
            vitesse_maxi: 70,
            trafficstatus: "freeFlow",
            datetime: "2026-07-29T12:49:00+02:00",
          },
        },
      ],
    };
    const { flows, events } = parseGeojsonFlow(JSON.stringify(fc), rennes);
    expect(flows).toHaveLength(1);
    const f = flows[0]!;
    expect(f.id).toBe("fr-rennesmetropole:10273_D");
    expect(f.sourceFormat).toBe("geojson-flow");
    expect(f.speedKph).toBe(83);
    expect(f.freeFlowKph).toBe(70);
    expect(f.freeFlowSource).toBe("native");
    expect(f.los).toBe("free_flow");
    expect(f.dataUpdatedAt).toBe("2026-07-29T12:49:00+02:00");
    expect(events).toHaveLength(0);
  });

  it("emits a derived congestion event when the DATEX status is congested", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: line([-1.7, 48.1], [-1.69, 48.1]),
          properties: {
            predefinedlocationreference: "9001_G",
            averagevehiclespeed: 12,
            vitesse_maxi: 90,
            trafficstatus: "congested",
          },
        },
      ],
    };
    const { flows, events } = parseGeojsonFlow(JSON.stringify(fc), rennes);
    expect(flows[0]!.los).toBe("queuing");
    expect(flows[0]!.speedRatio).toBeCloseTo(12 / 90, 3);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("congestion");
    expect(events[0]!.sourceFormat).toBe("geojson-flow");
  });

  it("maps a categorical status with no speed via statusMap and skips unknowns (Bordeaux shape)", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
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
      ],
    };
    const { flows, events } = parseGeojsonFlow(JSON.stringify(fc), bordeaux);
    // INCONNU → unknown, no speed → dropped; only the EMBOUTEILLE segment survives.
    expect(flows).toHaveLength(1);
    expect(flows[0]!.id).toBe("fr-bordeauxmetropole:I83");
    expect(flows[0]!.speedKph).toBeUndefined();
    expect(flows[0]!.los).toBe("queuing");
    expect(events).toHaveLength(1);
  });

  it("skips features with no usable geometry", () => {
    const fc = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: null, properties: { ident: "X", etat: "DENSE" } }],
    };
    expect(parseGeojsonFlow(JSON.stringify(fc), bordeaux).flows).toHaveLength(0);
  });

  it("maps averageSpeed + condition and unwraps a GeometryCollection (Victoria shape)", () => {
    const victoria = {
      id: "au-vic-vicroads",
      attribution: "Department of Transport and Planning (Victoria)",
      country: "AU",
      license: "CC-BY-4.0",
      flowMap: {
        idField: "id",
        speedField: "averageSpeed",
        statusField: "condition",
        statusMap: { Light: "freeFlow", Medium: "heavy", Heavy: "congested" },
        updatedField: "publishedTime",
      },
    } as SourceDescriptor;
    const fc = {
      type: "FeatureCollection",
      features: [
        {
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
        },
      ],
    };
    const { flows, events } = parseGeojsonFlow(JSON.stringify(fc), victoria);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.id).toBe("au-vic-vicroads:Streams:1");
    expect(flows[0]!.speedKph).toBe(20);
    expect(flows[0]!.los).toBe("queuing");
    expect(flows[0]!.geometry.type).toBe("LineString");
    expect(flows[0]!.sourceFormat).toBe("geojson-flow");
    expect(events).toHaveLength(1);
  });

  it("flags a hard parse failure on non-JSON and on a non-collection", () => {
    expect(parseGeojsonFlow("not json <", rennes).failed).toBe(true);
    expect(parseGeojsonFlow(JSON.stringify({ foo: 1 }), rennes).failed).toBe(true);
  });
});
