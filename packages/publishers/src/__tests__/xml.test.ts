import { describe, expect, it } from "vitest";
import { validateXML } from "xmllint-wasm";
import { buildXmlDocument, xmlChars } from "../xml.js";

/** XML 1.0 production [2] Char, matched per code point. */
const XML_CHARS = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

const forbidden: [string, string][] = [
  ["NUL", "\u0000"],
  ["U+0001", "\u0001"],
  ["backspace", "\u0008"],
  ["vertical tab", "\u000B"],
  ["form feed", "\u000C"],
  ["U+001F", "\u001F"],
  ["lone high surrogate", "\uD800"],
  ["lone low surrogate", "\uDFFF"],
  ["reversed surrogate pair", "\uDC00\uD800"],
  ["U+FFFE", "\uFFFE"],
  ["U+FFFF", "\uFFFF"],
];

const allowed: [string, string][] = [
  ["tab", "\t"],
  ["line feed", "\n"],
  ["carriage return", "\r"],
  ["space", " "],
  ["DEL", "\u007F"],
  ["NEL", "\u0085"],
  ["U+009F", "\u009F"],
  ["U+D7FF", "\uD7FF"],
  ["private use U+E000", "\uE000"],
  ["U+FFFD", "\uFFFD"],
  ["U+FDD0 noncharacter", "\uFDD0"],
  ["astral pair", "\u{1F6A7}"],
  ["U+10000", "\u{10000}"],
  ["U+10FFFF", "\u{10FFFF}"],
];

describe("xmlChars", () => {
  it.for(forbidden)("replaces %s with U+FFFD", ([, char]) => {
    const out = xmlChars(`a${char}b`);
    expect(out).toMatch(XML_CHARS);
    expect(out).toBe(`a${"\uFFFD".repeat([...char].length)}b`);
  });

  it.for(allowed)("keeps %s", ([, char]) => {
    expect(xmlChars(`a${char}b`)).toBe(`a${char}b`);
  });
});

describe("buildXmlDocument", () => {
  const dirty = `x${forbidden.map(([, c]) => c).join("")}<&>"'${allowed.map(([, c]) => c).join("")}y`;

  it("writes only XML characters in element text and attribute values", async () => {
    const xml = buildXmlDocument({
      root: {
        "@_id": dirty,
        "@_n": 7,
        item: [dirty, { "@_lang": `de${"\u0001"}`, "#text": dirty }],
        count: 3,
      },
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<root')).toBe(true);
    expect(xml).toMatch(XML_CHARS);
    const result = await validateXML({
      xml: [{ fileName: "doc.xml", contents: xml }],
      normalization: "format",
    });
    expect(result.errors).toEqual([]);
    expect(result.normalized).toContain("&lt;&amp;&gt;");
    expect(xml).toContain('n="7"');
    expect(xml).toContain("<count>3</count>");
  });

  it("writes an attribute whose value is true with that value", async () => {
    const xml = buildXmlDocument({ root: { "@_forecast": "true", "@_flag": true } });
    expect(xml).toContain('<root forecast="true" flag="true"');
    const result = await validateXML({
      xml: [{ fileName: "doc.xml", contents: xml }],
      normalization: "format",
    });
    expect(result.errors).toEqual([]);
  });
});
