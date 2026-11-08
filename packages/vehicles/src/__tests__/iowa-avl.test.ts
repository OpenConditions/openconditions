import { describe, expect, test } from "vitest";
import { vehiclesDomain } from "../domain.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/vehicles-feed.js";

const at = "2026-09-19T15:46:01.014Z";
const historical = () => JSON.parse(fixture("iowa-dot-avl.json.txt").toString());
const parse = (doc = historical(), fetched = at) =>
  vehiclesDomain.formats["iowa-avl"]!.parse(
    catalogFeed("us-ia-iowadot-maintenance"),
    { main: [Buffer.from(JSON.stringify(doc))] },
    parseContext(fetched),
  );

describe("Iowa AVL", () => {
  test("accepts captured current empty without inventing a CRS or ping", () => {
    expect(parse(JSON.parse(fixture("iowa-current.json.txt").toString())).observations).toEqual([]);
  });
  test("registers healthy empty measurements without snapshot withdrawal", () => {
    expect(vehiclesDomain.formats["iowa-avl"]).toMatchObject({
      kind: "measurements",
      mayBeEmpty: true,
    });
    expect(vehiclesDomain.formats["iowa-avl"]?.restatesTransient).not.toBe(true);
  });
  test("seals historical positions against production vocabulary with ping expiry and exact MPH conversion", () => {
    const out = parse();
    expect(out.features).toHaveLength(1);
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(out.observations[0]).toMatchObject({
      subject: { kind: "feature", featureId: out.features[0]!["id"] },
      phenomenonTime: { instant: at },
      freshness: { expiresAt: "2026-09-19T15:56:01.014Z" },
      result: {
        value: {
          speed: { value: 65.855 * 1.609344, unit: "km/h" },
          spreaderOn: false,
          routeName: "I 35 S",
        },
      },
    });
    expect(JSON.stringify(out)).not.toMatch(/plowUp|plowing|trail|GARAGE|ROADTEMP/);
  });
  test.each(["NONE", "SOLID", "LIQUID", "LIQUID_SOLID", null, "OTHER"])(
    "material %s has only documented meaning",
    (material) => {
      const doc = historical();
      doc.features[0].attributes.ACTIVE_MATERIAL = material;
      const value = (parse(doc).observations[0]!["result"] as { value: Record<string, unknown> })
        .value;
      expect(value.spreaderOn).toBe(
        material === "NONE"
          ? false
          : ["SOLID", "LIQUID", "LIQUID_SOLID"].includes(material as string)
            ? true
            : undefined,
      );
    },
  );
  test("null and unknown optional readings remain unknown, including numeric blade codes", () => {
    const doc = historical();
    Object.assign(doc.features[0].attributes, {
      HEADING: null,
      VELOCITY: null,
      ROUTE_NAME: null,
      ACTIVE_MATERIAL: null,
      FRONTPLOWSTATE: 1,
    });
    expect((parse(doc).observations[0]!["result"] as { value: unknown }).value).toEqual({
      v: 1,
      point: { type: "Point", coordinates: [-93.570509, 42.42155499999999] },
    });
  });
  test("keeps LABEL identity when the system row is rekeyed", () => {
    const first = parse();
    const doc = historical();
    doc.features[0].attributes.OBJECTID = 7654;
    expect(parse(doc).features[0]!["id"]).toBe(first.features[0]!["id"]);
  });
  test.each([null, "", " A35674 "])("rejects ambiguous LABEL %s", (label) => {
    const doc = historical();
    doc.features[0].attributes.LABEL = label;
    expect(() => parse(doc)).toThrow();
  });
  test("rejects duplicate identities", () => {
    const doc = historical();
    doc.features.push(structuredClone(doc.features[0]));
    expect(() => parse(doc)).toThrow();
  });
  test.each([null, 0, NaN, Date.parse(at) + 1])(
    "does not replace an invalid/future ping %s using LOGDT or retrieval",
    (ping) => {
      const doc = historical();
      doc.features[0].attributes.MODIFIEDDT = ping;
      expect(parse(doc).observations).toEqual([]);
    },
  );
  test("stale pings and empty polls never renew observations", () => {
    expect(parse(historical(), "2026-09-19T15:56:01.014Z").observations).toEqual([]);
    expect(parse({ spatialReference: { wkid: 4326 }, features: [] }).observations).toEqual([]);
  });
  test.each([
    { error: { code: 400 } },
    { features: {} },
    { spatialReference: { wkid: 3857 }, features: [] },
  ])("rejects malformed/error/CRS envelopes", (doc) => expect(() => parse(doc)).toThrow());
  test("rejects projected coordinates and positions outside Iowa", () => {
    const doc = historical();
    doc.features[0].geometry.x = -10000000;
    expect(() => parse(doc)).toThrow();
  });
});
