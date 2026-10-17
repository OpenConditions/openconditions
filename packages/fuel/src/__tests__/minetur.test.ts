import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { observationId } from "@openconditions/model";
import { beforeEach, describe, expect, test } from "vitest";
import { fuelDomain } from "../domain.js";
import { fixture, mineturFeed, parseContext } from "./helpers/fuel-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * `minetur-stations.json` is a trimmed capture of the live MINETUR file,
 * fetched 2026-10-03 (publication `Fecha` 03/10/2026 23:54:02, Madrid): three
 * of its 11463 stations, one of them published at 0,0. 15083's `Horario` names
 * Monday alone (`L: 24H`), which is counted as a value not read in every parse.
 */
const FETCHED = "2026-10-03T21:55:00Z";
const PUBLISHED = "2026-10-03T21:54:02Z";

type Draft = Record<string, unknown>;

const parse = (payload: Buffer = fixture("minetur-stations.json")) =>
  fuelDomain.formats["minetur"]!.parse(mineturFeed(), { main: [payload] }, parseContext(FETCHED));

const FEED = "es-minetur-fuel";

const station = (features: Draft[], id: string) =>
  features.find((f) => f["id"] === `oc:feature:es-minetur-fuel:${id}`);

const componentKeys = (feature: Draft | undefined) =>
  (feature?.["components"] as { key: string }[] | undefined)?.map((c) => c.key);

const prices = (observations: Draft[], featureId: string) =>
  observations.filter(
    (o) =>
      o["property"] === "fuel.price" &&
      (o["subject"] as { featureId: string }).featureId === featureId,
  );

/** The fixture with one station's fields replaced. */
function patched(id: string, fields: Record<string, string>): Buffer {
  const file = JSON.parse(fixture("minetur-stations.json").toString("utf8"));
  for (const s of file.ListaEESSPrecio as Record<string, string>[]) {
    if (s["IDEESS"] === id) Object.assign(s, fields);
  }
  return Buffer.from(JSON.stringify(file));
}

describe("MINETUR", () => {
  beforeEach(() => __resetSkips());

  test("MINETUR prices each sold grade at the publication time in Madrid", () => {
    const { features, observations } = parse();
    const tarragona = station(features, "15083")!;
    expect(componentKeys(tarragona)).toEqual([
      "e5",
      "diesel",
      "diesel_premium",
      "agricultural_diesel",
      "lpg",
      "cng",
      "lng",
      "adblue",
      "e5_premium",
    ]);
    const priced = prices(observations, tarragona["id"] as string);
    expect(priced).toHaveLength(9);
    for (const o of priced) {
      expect(o["phenomenonTime"]).toEqual({ instant: PUBLISHED });
      expect(o["id"]).toBe(observationId("es-minetur-fuel", o as never));
    }
    const result = (key: string) =>
      priced.find((o) => (o["subject"] as { componentKey: string }).componentKey === key)?.[
        "result"
      ];
    // Standard and premium 95 E5 are two products, each with its own price.
    expect(result("e5")).toEqual({ type: "money", amount: "1.649", currency: "EUR", per: "L" });
    expect(result("e5_premium")).toEqual({
      type: "money",
      amount: "1.689",
      currency: "EUR",
      per: "L",
    });
    expect(result("cng")).toEqual({ type: "money", amount: "1.850", currency: "EUR", per: "kg" });
    expect(tarragona["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [0.910639, 41.00725] },
      admin: { country: "ES", geocodes: [{ scheme: "iso3166-2", code: "ES-T" }] },
      address: { street: "CARRER DE JOAN ORÓ, 2", postalCode: "43891", country: "ES" },
    });
    expect(tarragona["access"]).toEqual({ audience: "public" });
    expect(tarragona["details"]).toEqual({
      kind: "fuel_station",
      v: 1,
      brand: "ALAS CENTRAL",
      productsComplete: true,
    });
  });

  test("an empty MINETUR column is a grade the station does not sell", () => {
    const { features, observations } = parse();
    const alcala = station(features, "15959")!;
    expect(componentKeys(alcala)).toEqual(["e5", "diesel", "adblue"]);
    expect((alcala["details"] as { productsComplete: boolean }).productsComplete).toBe(true);
    expect(prices(observations, alcala["id"] as string)).toHaveLength(3);
  });

  test("a station selling only premium 95 E5 sells e5_premium, not e5", () => {
    const { features, observations } = parse(
      patched("15959", { "Precio Gasolina 95 E5": "", "Precio Gasolina 95 E5 Premium": "1,799" }),
    );
    const alcala = station(features, "15959")!;
    expect(componentKeys(alcala)).toEqual(["diesel", "adblue", "e5_premium"]);
    expect(
      prices(observations, alcala["id"] as string).map(
        (o) => (o["subject"] as { componentKey: string }).componentKey,
      ),
    ).toEqual(["diesel", "adblue", "e5_premium"]);
  });

  test("each biomethane and 98 E10 column is a grade of its own", () => {
    const { features } = parse(
      patched("15959", {
        "Precio Gasolina 98 E5": "1,899",
        "Precio Gasolina 98 E10": "1,869",
        "Precio Biogas Natural Comprimido": "1,500",
        "Precio Biogas Natural Licuado": "1,400",
      }),
    );
    const keys = componentKeys(station(features, "15959"));
    expect(keys).toEqual(expect.arrayContaining(["sp98", "sp98_e10", "cng_bio", "lng_bio"]));
    const per = (key: string) =>
      (
        station(features, "15959")!["components"] as { key: string; details: { per: string } }[]
      ).find((c) => c.key === key)?.details.per;
    expect(per("cng_bio")).toBe("kg");
    expect(per("lng_bio")).toBe("kg");
  });

  test("a price that is not a string is no price", () => {
    const file = JSON.parse(fixture("minetur-stations.json").toString("utf8"));
    const alcala = (file.ListaEESSPrecio as Record<string, unknown>[]).find(
      (s) => s["IDEESS"] === "15959",
    )!;
    alcala["Precio Gasoleo A"] = 1.829;
    alcala["Precio Adblue"] = null;
    const { features } = parse(Buffer.from(JSON.stringify(file)));
    expect(componentKeys(station(features, "15959"))).toEqual(["e5"]);
  });

  test("a station at 0,0 is skipped as unplaced", () => {
    const out = parse();
    expect(station(out.features, "16499")).toBeUndefined();
    expect(out.features).toHaveLength(2);
    expect(out.rejected ?? 0).toBe(0);
    expect(drainSkipped(FEED)).toEqual({ no_geometry: 1, unknown_value: 1 });
  });

  test("an unreadable position or a missing id skips the station as malformed", () => {
    expect(parse(patched("15959", { Latitud: "40,48x" })).features).toHaveLength(1);
    expect(drainSkipped(FEED)).toEqual({ malformed: 1, no_geometry: 1, unknown_value: 1 });
    expect(parse(patched("15959", { IDEESS: "" })).features).toHaveLength(1);
    expect(drainSkipped(FEED)).toEqual({ malformed: 1, no_geometry: 1, unknown_value: 1 });
  });

  test("a priced column of a grade the parser does not know is a value not read", () => {
    const { features } = parse(patched("15959", { "Precio Gasolina 100": "2,019" }));
    expect(features).toHaveLength(2);
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 2, no_geometry: 1 });
  });

  test("a station sold restricted (Tipo Venta R) is not public", () => {
    const { features } = parse(patched("15959", { "Tipo Venta": "R" }));
    expect(station(features, "15959")!["access"]).toEqual({ audience: "restricted" });
  });

  test("a Tipo Venta the parser does not know leaves the audience unknown and is counted", () => {
    const { features } = parse(patched("15959", { "Tipo Venta": "Q" }));
    expect(station(features, "15959")!["access"]).toEqual({ audience: "unknown" });
    expect(drainSkipped(FEED)).toEqual({ no_geometry: 1, unknown_value: 2 });
  });

  test("Horario is read as OSM opening hours", () => {
    const { features } = parse();
    expect(station(features, "15959")!["openingHours"]).toEqual({
      osm: "24/7",
      twentyFourSeven: true,
    });
    // Monday alone is not read.
    expect(station(features, "15083")!["openingHours"]).toBeUndefined();
  });

  test.each([
    ["L-D: 06:00-22:00", "Mo-Su 06:00-22:00"],
    ["L-V: 06:00-22:00; S-D: 07:00-22:00", "Mo-Fr 06:00-22:00; Sa-Su 07:00-22:00"],
    ["L-S: 06:00-22:00", "Mo-Sa 06:00-22:00; Su off"],
    [
      "L-V: 07:00-14:00 y 16:00-21:00; S: 09:00-14:00",
      "Mo-Fr 07:00-14:00,16:00-21:00; Sa 09:00-14:00; Su off",
    ],
    ["L-J: 24H; V-D: 06:00-00:00", "Mo-Th 00:00-24:00; Fr-Su 06:00-24:00"],
    ["L-S: 8:00 -21:00; D: 08:00-14:00", "Mo-Sa 08:00-21:00; Su 08:00-14:00"],
    ["L-D: 00:00-23:59", "Mo-Su 00:00-23:59"],
  ])("Horario %j is %j", (horario, osm) => {
    const { features } = parse(patched("15959", { Horario: horario }));
    expect(station(features, "15959")!["openingHours"]).toEqual({ osm });
    expect(drainSkipped(FEED)).toEqual({ no_geometry: 1, unknown_value: 1 });
  });

  test.each([
    "L: 06:00-22:00",
    "L-D: 06:00",
    "L-D: abierto",
    "D-L: 24H",
    "L-V: 24H; V-D: 06:00-22:00",
    "L-D: 06:00-06:00",
  ])("Horario %j is not read and is counted", (horario) => {
    const { features } = parse(patched("15959", { Horario: horario }));
    expect(station(features, "15959")!["openingHours"]).toBeUndefined();
    expect(drainSkipped(FEED)).toEqual({ no_geometry: 1, unknown_value: 2 });
  });

  test("reads a publication hour written without its leading zero", () => {
    // As published at 00:09 Madrid time on 2026-10-04.
    const file = JSON.parse(fixture("minetur-stations.json").toString("utf8"));
    file.Fecha = "04/10/2026 0:09:09";
    const { observations } = parse(Buffer.from(JSON.stringify(file)));
    expect(observations[0]!["phenomenonTime"]).toEqual({ instant: "2026-10-03T22:09:09Z" });
  });

  test("an unreadable publication time fails the parse", () => {
    const file = JSON.parse(fixture("minetur-stations.json").toString("utf8"));
    file.Fecha = "yesterday";
    expect(() => parse(Buffer.from(JSON.stringify(file)))).toThrow(/Fecha/);
  });

  test("every drafted record seals", () => {
    const { features, observations } = parse();
    expect(sealFailures([...features, ...observations])).toEqual([]);
  });
});
