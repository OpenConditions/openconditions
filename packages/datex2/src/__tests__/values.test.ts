import { describe, expect, test } from "vitest";
import { multilingual, parseXmlDocument, pointOf } from "../index.js";

const node = (xml: string) => parseXmlDocument(xml)["n"];

describe("multilingual", () => {
  test("every language in document order, with an undetermined language for a bad tag", () => {
    const n = node(
      `<n><values><value lang="nl">Rustplaats</value><value lang="en"> Rest area </value><value lang="??">x</value></values></n>`,
    );
    expect(multilingual(n)).toEqual([
      { lang: "nl", value: "Rustplaats" },
      { lang: "en", value: "Rest area" },
      { lang: "und", value: "x" },
    ]);
  });

  test("reads prefixed v3 values", () => {
    const n = node(
      `<n xmlns:com="c"><com:values><com:value lang="de">Parkhaus</com:value></com:values></n>`,
    );
    expect(multilingual(n)).toEqual([{ lang: "de", value: "Parkhaus" }]);
  });

  test("a plain leaf is undetermined text, and an empty block is nothing", () => {
    expect(multilingual("Glacis")).toEqual([{ lang: "und", value: "Glacis" }]);
    expect(multilingual(node("<n><values/></n>"))).toEqual([]);
    expect(multilingual(undefined)).toEqual([]);
  });
});

describe("pointOf", () => {
  test("a v2 pointByCoordinates gives [lon, lat]", () => {
    const n = node(
      `<n><pointByCoordinates><pointCoordinates><latitude>51.39038</latitude><longitude>6.108905</longitude></pointCoordinates></pointByCoordinates></n>`,
    );
    expect(pointOf(n)).toEqual([6.108905, 51.39038]);
  });

  test("a v3 locationForDisplay is read through its prefixes", () => {
    const n = node(
      `<n xmlns:loc="l"><loc:locationForDisplay><loc:latitude>49.6</loc:latitude><loc:longitude>6.13</loc:longitude></loc:locationForDisplay></n>`,
    );
    expect(pointOf(n)).toEqual([6.13, 49.6]);
  });

  test("0,0, out-of-range and missing coordinates give no point", () => {
    const at = (lat: string, lon: string) =>
      node(
        `<n><pointCoordinates><latitude>${lat}</latitude><longitude>${lon}</longitude></pointCoordinates></n>`,
      );
    expect(pointOf(at("0", "0"))).toBeUndefined();
    expect(pointOf(at("95", "6"))).toBeUndefined();
    expect(pointOf(at("51", "190"))).toBeUndefined();
    expect(pointOf(at("x", "6"))).toBeUndefined();
    expect(pointOf(node("<n><other>1</other></n>"))).toBeUndefined();
  });
});
