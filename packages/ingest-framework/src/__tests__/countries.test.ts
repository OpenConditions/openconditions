import { describe, expect, test } from "vitest";
import { countryAlpha2 } from "../countries.js";

describe("countryAlpha2", () => {
  test("an alpha-2 code is kept, an alpha-3 code converted, whatever its case", () => {
    expect(countryAlpha2("de")).toBe("DE");
    expect(countryAlpha2(" AUT ")).toBe("AT");
    expect(countryAlpha2("phl")).toBe("PH");
    expect(countryAlpha2("COD")).toBe("CD");
  });

  test("a code no country holds, and anything else, is no country", () => {
    expect(countryAlpha2("XYZ")).toBeUndefined();
    expect(countryAlpha2("constructor")).toBeUndefined();
    expect(countryAlpha2("")).toBeUndefined();
    expect(countryAlpha2(undefined)).toBeUndefined();
  });
});
