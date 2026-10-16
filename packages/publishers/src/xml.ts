import { XMLBuilder } from "fast-xml-parser";

/**
 * Any code point outside the XML 1.0 `Char` production: C0 controls other
 * than tab, line feed and carriage return, unpaired surrogates, U+FFFE and
 * U+FFFF. A character reference cannot carry them either, so they cannot be
 * escaped. Discouraged but legal characters such as U+007F–U+009F stay.
 */
const NOT_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** Replaces each character XML 1.0 cannot represent with U+FFFD. */
export function xmlChars(value: string): string {
  return value.replace(NOT_XML_CHAR, "\uFFFD");
}

const sanitize = (_name: string, value: unknown) =>
  typeof value === "string" ? xmlChars(value) : value;

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
  tagValueProcessor: sanitize,
  attributeValueProcessor: sanitize,
});

/**
 * Serializes a fast-xml-parser object tree (`@_` attributes, `#text` content)
 * as a UTF-8 XML 1.0 document. Every element text and attribute value is
 * limited to XML characters, so source text cannot make the document malformed.
 */
export function buildXmlDocument(doc: Record<string, unknown>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}`;
}
