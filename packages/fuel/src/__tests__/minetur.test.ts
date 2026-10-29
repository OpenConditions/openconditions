import { spawnSync } from "node:child_process";
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

const components = (feature: Draft | undefined) =>
  (feature?.["components"] as { key: string; details: Draft }[] | undefined) ?? [];

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

  test("a station on a road with a kilometre point stands beside the side Margen names", () => {
    const right = parse(patched("15959", { Dirección: "AUTOVIA A-31 KM. 143,350", Margen: "D" }));
    const onRoad = station(right.features, "15959")!;
    expect((onRoad["location"] as Draft)["roads"]).toEqual([{ ref: "A-31", kmFrom: 143.35 }]);
    expect(onRoad["details"]).toMatchObject({
      direction: { value: "positive", basis: "road_reference" },
    });
    const left = parse(
      patched("15959", { Dirección: "CARRETERA N IV MADRID-CADIZ KM 531,5", Margen: "I" }),
    );
    const nIv = station(left.features, "15959")!;
    expect((nIv["location"] as Draft)["roads"]).toEqual([{ ref: "N-IV", kmFrom: 531.5 }]);
    expect(nIv["details"]).toMatchObject({ direction: { value: "negative" } });
    const european = parse(patched("15959", { Dirección: "CARRETERA E-15/N-340 KM. 471" }));
    expect((station(european.features, "15959")!["location"] as Draft)["roads"]).toEqual([
      { ref: "N-340", kmFrom: 471 },
    ]);
    const regional = parse(patched("15959", { Dirección: "AUTOVIA EX-A2 DE MIAJADAS KM. 6,160" }));
    expect(station(regional.features, "15959")!["location"]).not.toHaveProperty("roads");
    expect(sealFailures([...right.features, ...left.features])).toEqual([]);
  });

  test("a side without a road to read it against, or Margen N, places no side", () => {
    const { features } = parse();
    for (const id of ["15083", "15959"]) {
      expect(station(features, id)!["details"]).not.toHaveProperty("direction");
      expect(station(features, id)!["location"]).not.toHaveProperty("roads");
    }
    const none = parse(patched("15959", { Dirección: "CARRETERA N-340 KM. 963,7", Margen: "N" }));
    expect(station(none.features, "15959")!["details"]).not.toHaveProperty("direction");
    expect((station(none.features, "15959")!["location"] as Draft)["roads"]).toEqual([
      { ref: "N-340", kmFrom: 963.7 },
    ]);
  });

  test("a Margen the ministry does not define is counted", () => {
    __resetSkips();
    parse(patched("15959", { Margen: "X" }));
    // 15083's Monday-only Horario is the other value not read.
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 2, no_geometry: 1 });
  });

  test("a biodiesel and a bioethanol are the blends their declared shares make them", () => {
    const blend = (fields: Record<string, string>) => {
      const { features } = parse(patched("15959", fields));
      return components(station(features, "15959")).filter(
        (c) => c.details["biofuelPct"] !== undefined || ["b100", "ethanol"].includes(c.key),
      );
    };
    const b7 = blend({ "Precio Biodiesel": "1,699", "% Éster metílico": "7,0" });
    expect(b7.map((c) => [c.key, c.details["grade"], c.details["biofuelPct"]])).toEqual([
      ["b7", "b7", 7],
    ]);
    const neat = blend({ "Precio Biodiesel": "1,990", "% Éster metílico": "96,5" });
    expect(neat.map((c) => [c.key, c.details["biofuelPct"]])).toEqual([["b100", 96.5]]);
    const b30 = blend({ "Precio Biodiesel": "2,089", "% Éster metílico": "30,0" });
    expect(b30.map((c) => c.key)).toEqual(["b30"]);
    const odd = blend({ "Precio Biodiesel": "2,089", "% Éster metílico": "50,0" });
    expect(odd.map((c) => [c.key, c.details["biofuelPct"]])).toEqual([["b100", 50]]);
    const e85 = blend({ "Precio Bioetanol": "2,399", "% BioEtanol": "85,0" });
    expect(e85.map((c) => [c.key, c.details["biofuelPct"]])).toEqual([["e85", 85]]);
    const undeclared = blend({ "Precio Biodiesel": "1,749", "% Éster metílico": "0,0" });
    expect(undeclared.map((c) => [c.key, c.details["biofuelPct"]])).toEqual([["b100", undefined]]);
  });

  test("a blend already priced in its own column keeps the biofuel column's grade", () => {
    const { features } = parse(
      patched("15959", {
        "Precio Bioetanol": "2,399",
        "% BioEtanol": "85,0",
        "Precio Gasolina 95 E85": "1,299",
      }),
    );
    const blends = components(station(features, "15959"))
      .filter((c) => c.key === "e85" || c.key === "ethanol")
      .map((c) => [c.key, c.details["biofuelPct"]]);
    expect(blends).toEqual([
      ["ethanol", 85],
      ["e85", undefined],
    ]);
  });

  test("a share that is no percentage is counted and not read", () => {
    __resetSkips();
    const { features } = parse(
      patched("15959", { "Precio Biodiesel": "1,749", "% Éster metílico": "siete" }),
    );
    expect(
      components(station(features, "15959")).find((c) => c.key === "b100")?.details,
    ).not.toHaveProperty("biofuelPct");
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

  test("a null station is malformed, not a failed poll", () => {
    const file = JSON.parse(fixture("minetur-stations.json").toString("utf8")) as {
      ListaEESSPrecio: unknown[];
    };
    file.ListaEESSPrecio.push(null);
    const { features } = parse(Buffer.from(JSON.stringify(file)));
    expect(features).toHaveLength(parse().features.length);
    expect(drainSkipped(FEED)).toMatchObject({ malformed: 1 });
  });
});

const scheduleDoc = (horario: string | undefined) => {
  const file = JSON.parse(fixture("minetur-stations.json").toString("utf8"));
  file.ListaEESSPrecio = file.ListaEESSPrecio.filter(
    (s: Record<string, string>) => s["IDEESS"] === "15959",
  );
  if (horario === undefined) delete file.ListaEESSPrecio[0].Horario;
  else file.ListaEESSPrecio[0].Horario = horario;
  return file;
};

describe("MINETUR schedule whitespace", () => {
  beforeEach(() => __resetSkips());

  test.each([
    [" \nL-D:\n24H\r\n", "24/7"],
    ["L-D: \u2028 06:00-22:00", "Mo-Su 06:00-22:00"],
    ["L-D:06:00-14:00 \t y \t16:00-22:00", "Mo-Su 06:00-14:00,16:00-22:00"],
    ["L-D:06:00-14:00\u000by\f16:00-22:00", "Mo-Su 06:00-14:00,16:00-22:00"],
    ["L-D:06:00-\u000b22:00", "Mo-Su 06:00-22:00"],
  ])("preserves readable %j", (horario, osm) => {
    const out = parse(Buffer.from(JSON.stringify(scheduleDoc(horario))));
    expect(out.features[0]?.["openingHours"]).toMatchObject({ osm });
    expect(drainSkipped(FEED)).toEqual({});
  });

  test.each([
    "L-D:06:00-\n22:00",
    "L-D:06:00-\r22:00",
    "L-D:06:00-\u202822:00",
    "L-D:06:00-\u202922:00",
    "L-D:06:00-14:00 y\n16:00-22:00",
    "L-D:06:00-14:00 Y 16:00-22:00",
    "L-D:06:00-14:00y16:00-22:00",
    "L-D:24h",
    "l-d:24H",
    "L-D:24H;",
    "L-D:24H; D:24H",
    "D-L:24H",
    "L:24H",
  ])("does not reinterpret %j", (horario) => {
    const out = parse(Buffer.from(JSON.stringify(scheduleDoc(horario))));
    expect(out.features).toHaveLength(1);
    expect(out.features[0]?.["openingHours"]).toBeUndefined();
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 1 });
  });

  test.each([undefined, "", " \n "])("absent %j is not an unknown value", (horario) => {
    const out = parse(Buffer.from(JSON.stringify(scheduleDoc(horario))));
    expect(out.features[0]?.["openingHours"]).toBeUndefined();
    expect(drainSkipped(FEED)).toEqual({});
  });

  test.each(["rule", "separator"])("bounded schedule work: %s", (mode) => {
    const data = JSON.stringify({
      file: scheduleDoc("L-D:24H"),
      feed: mineturFeed(),
      ctx: parseContext(FETCHED),
      mode,
    });
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const { parseMinetur } = await import(process.argv[1]);
      const { file, feed, ctx, mode } = JSON.parse(process.argv[2]);
      const read = () => parseMinetur(feed, { main: [Buffer.from(JSON.stringify(file))] }, ctx);
      assert.equal(read().features[0].openingHours.osm, "24/7");
      console.log("control passed");
      file.ListaEESSPrecio[0].Horario = mode === "rule"
        ? "L-D:" + " ".repeat(100_000) + "08:00\\n20:00"
        : "L-D:08:00-14:00" + " ".repeat(100_000) + "!";
      const out = read();
      assert.equal(out.features.length, 1);
      assert.equal(out.features[0].openingHours, undefined);
      console.log("decoded");
    `,
        new URL("../../dist/index.js", import.meta.url).href,
        data,
      ],
      { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
    );
    expect(result.stdout).toContain("control passed");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("control passed\ndecoded");
  });
});
