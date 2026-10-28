import { describe, expect, it } from "vitest";
import { identityScore, isStreetName, normalizeName, roadIdentity } from "../identity.js";

describe("normalizeName", () => {
  it("compares Straße, Strasse and Str. alike, without house numbers or notes", () => {
    expect(normalizeName("Hermannstraße 6")).toBe("hermannstr");
    expect(normalizeName("Hermannstrasse")).toBe("hermannstr");
    expect(normalizeName("Hermannstr.")).toBe("hermannstr");
    expect(normalizeName("Charlottenburger Chaussee (Spandau)")).toBe("charlottenburgerchaussee");
    expect(normalizeName("Bodelschwingher Str. 211-217")).toBe("bodelschwingherstr");
  });
});

describe("isStreetName", () => {
  it("reads a name with a street word as a street's", () => {
    for (const name of [
      "Rosenweg",
      "Max-Brauer-Allee",
      "Am Alten Markt",
      "Hofmühlenstraße",
      "Main Street",
      "Rue de Rivoli",
      "Kerkstraat",
    ])
      expect(isStreetName(name)).toBe(true);
  });

  it("reads a route description as no street's", () => {
    for (const name of [
      "Stuttgart-Großbottwar",
      "Bretten-Germersheim",
      "Furtwangen im Schwarzwald-St. Georgen im Schwarzwald",
    ])
      expect(isStreetName(name)).toBe(false);
  });
});

describe("roadIdentity", () => {
  it("reads a name written as a road number as the number", () => {
    expect(roadIdentity([{ name: "B410" }])).toEqual({ refs: ["B410"], names: [] });
    expect(roadIdentity([{ name: "A100 (Stadtring)" }])).toEqual({ refs: ["A100"], names: [] });
    expect(roadIdentity([{ ref: "K1876", name: "L1148/K1876, WN*Michelau (Nord)" }])).toEqual({
      refs: ["K1876", "L1148"],
      names: [],
    });
  });

  it("reads no number out of a word before one", () => {
    expect(roadIdentity([{ ref: "40", name: "Tie 40, eli Turun kehätie, Lieto." }]).refs).toEqual([
      "40",
    ]);
    expect(roadIdentity([{ name: "St 2240" }]).refs).toEqual(["ST2240"]);
  });

  it("keeps street names and leaves route descriptions out", () => {
    expect(roadIdentity([{ name: "Hermannstraße" }])).toEqual({ refs: [], names: ["hermannstr"] });
    expect(roadIdentity([{ ref: "L1100", name: "Stuttgart-Großbottwar" }])).toEqual({
      refs: ["L1100"],
      names: [],
    });
  });
});

describe("identityScore", () => {
  it("matches the stated number, or the stated street name", () => {
    expect(identityScore({ refs: ["B410"] }, { ref: "B 410", name: "Brunnenstraße" })).toBe(1);
    expect(
      identityScore({ refs: [], names: ["hauptstr"] }, { ref: "B 9", name: "Hauptstraße" }),
    ).toBe(1);
    expect(
      identityScore(
        { refs: [], names: ["werrenstrkreuzungsbereichgansbergstr"] },
        { ref: null, name: "Werrenstraße" },
      ),
    ).toBe(1);
  });

  it("rules out a road the stated number or street name contradicts", () => {
    expect(identityScore({ refs: ["K32"] }, { ref: "B 410", name: null })).toBe(0);
    expect(
      identityScore({ refs: [], names: ["rosenweg"] }, { ref: null, name: "Adenauerallee" }),
    ).toBe(0);
  });

  it("leaves a road neither side names open", () => {
    expect(identityScore({ refs: [] }, { ref: "A 1", name: "Hansalinie" })).toBe(0.5);
    expect(identityScore({ refs: ["B410"] }, { ref: null, name: "Brunnenstraße" })).toBe(0.5);
    expect(identityScore({ refs: [], names: ["rosenweg"] }, { ref: "B 1", name: null })).toBe(0.5);
    expect(identityScore({ refs: [], names: ["rosenweg"] }, { ref: null })).toBe(0.5);
  });

  it("lets a European route number match but contradict nothing", () => {
    expect(identityScore({ refs: ["E40"] }, { ref: "E 40", name: null })).toBe(1);
    expect(identityScore({ refs: ["E40"] }, { ref: "A 3", name: null })).toBe(0.5);
    expect(identityScore({ refs: ["E40", "A3"] }, { ref: "A 1", name: null })).toBe(0);
  });

  it("decides by a stated number before a contradicting street name", () => {
    expect(
      identityScore({ refs: ["B9"], names: ["hauptstr"] }, { ref: "B 9", name: "Mainzer Straße" }),
    ).toBe(1);
    expect(
      identityScore({ refs: ["B9"], names: ["hauptstr"] }, { ref: "B 42", name: "Hauptstraße" }),
    ).toBe(0);
    expect(
      identityScore({ refs: ["B9"], names: ["hauptstr"] }, { ref: null, name: "Hauptstraße" }),
    ).toBe(1);
    expect(
      identityScore({ refs: ["B9"], names: ["hauptstr"] }, { ref: null, name: "Ringstraße" }),
    ).toBe(0.5);
  });
});
