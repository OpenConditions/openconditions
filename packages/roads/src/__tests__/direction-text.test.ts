import { describe, expect, it } from "vitest";
import { directionFromText } from "../situation/location.js";

describe("directionFromText", () => {
  it("reads German both-direction words as both, keeping the publisher's text", () => {
    for (const text of ["Beidseitig", "in beiden Richtungen", "beide Richtungen"]) {
      expect(directionFromText(text, false), text).toEqual({ value: "both", basis: "text", text });
    }
  });

  it("leaves one side it does not name an unknown direction", () => {
    expect(directionFromText("Einseitig", false)).toEqual({
      value: "unknown",
      basis: "text",
      text: "Einseitig",
    });
  });
});
