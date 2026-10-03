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
});
