import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { localAccessExceptionOf } from "../situation/local-access.js";

describe("localAccessExceptionOf", () => {
  it.each([
    ["Leitungsbau, Vollsperrung, Anlieger frei", "Anlieger frei"],
    ["Vollsperrung (Anliegerverkehr frei)", "Anliegerverkehr frei"],
    ["Sperrung außer Anlieger", "außer Anlieger"],
    ["Gesperrt, frei für Anliegerverkehr", "frei für Anliegerverkehr"],
    [
      "Durchfahrt gesperrt, Anliegerverkehr ist weiterhin möglich",
      "Anliegerverkehr ist weiterhin möglich",
    ],
    ["Road closed, local traffic only", "local traffic only"],
    ["Closed except for access", "except for access"],
    ["Wegafsluiting, uitgezonderd bestemmingsverkeer", "uitgezonderd bestemmingsverkeer"],
    ["Route barrée sauf desserte locale", "sauf desserte locale"],
  ])("reads local access from %j", (text, phrase) => {
    expect(localAccessExceptionOf([text])).toEqual({ usage: "local_access", phrase });
  });

  it.each([
    ["Vollsperrung, Anwohner frei", "Anwohner frei"],
    ["Closed to through traffic, residents only", "residents only"],
    ["Route barrée sauf riverains", "sauf riverains"],
  ])("reads residents from %j", (text, phrase) => {
    expect(localAccessExceptionOf([text])).toEqual({ usage: "residents", phrase });
  });

  it.each([
    "Straßenbau, Vollsperrung für Kfz-Verkehr, Zufahrt bis Tankstelle frei",
    "Sanierung der Anliegerstraße, Vollsperrung",
    "Anlieger werden gebeten, die Umleitung zu nutzen",
    "Closed, access to the car park via Main Street",
    "Vollsperrung, auch kein Anliegerverkehr möglich",
    "Keine Anwohner zugelassen",
    "Vollsperrung, Anlieger frei bis Baustelle",
    "Gesperrt, frei für Anliegerverkehr bis Hausnummer 20",
    "Road closed to all traffic except for access by emergency vehicles",
  ])("reads no exception from %j", (text) => {
    expect(localAccessExceptionOf([text])).toBeUndefined();
  });

  it("reads the first text that states one", () => {
    expect(localAccessExceptionOf([undefined, "Vollsperrung", "Anlieger frei"])).toEqual({
      usage: "local_access",
      phrase: "Anlieger frei",
    });
  });

  it.each([
    [" bis Haus", false],
    [",bis!", false],
    [" \t, \nUP\tTO fence", false],
    ["\u00a0TOT 20", false],
    [" biscuit", true],
    [" up toad", true],
    [" tot_1", true],
    ["! bis Haus", true],
    [",, bis Haus", true],
    [" \n!", true],
  ])("preserves the immediate terminator %j", (suffix, allowed) => {
    expect(localAccessExceptionOf(["Anlieger frei" + suffix])).toEqual(
      allowed ? { usage: "local_access", phrase: "Anlieger frei" } : undefined,
    );
  });

  it("bounds access-exception suffix work through public effects", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const { effectsOf } = await import(process.argv[1]);
      const { event, ctx } = JSON.parse(process.argv[2]);
      const read = (text) => effectsOf({ ...event, description: text }, ctx).find(p => p.effect.kind === "closure").effect.applicability;
      assert.deepEqual(read("Anlieger frei!").except, [{ usage: "local_access" }]);
      console.log("control passed");
      assert.deepEqual(read("Anlieger frei" + " ".repeat(100_000) + "!").except, [{ usage: "local_access" }]);
      console.log("decoded");
    `,
        new URL("../../dist/index.js", import.meta.url).href,
        JSON.stringify({
          event: { id: "bounded", roadState: "closed" },
          ctx: { recordId: "bounded", closureNature: false, laneClosureNature: false },
        }),
      ],
      { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
    );
    expect(result.stdout).toContain("control passed");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("control passed\ndecoded");
  });
});
