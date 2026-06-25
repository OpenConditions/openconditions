import { XMLParser, XMLValidator } from "fast-xml-parser";

export interface XmlObject {
  [key: string]: unknown;
}

export interface XmlParseOptions {
  ignoreAttributes?: boolean;
  removeNSPrefix?: boolean;
  validate?: boolean;
  isArray?: (name: string) => boolean;
}

const XML_ATTRIBUTE_PREFIX = "@_";

function validationMessage(result: unknown): string {
  if (result === true) return "";
  if (
    typeof result === "object" &&
    result !== null &&
    "err" in result &&
    typeof result.err === "object" &&
    result.err !== null &&
    "msg" in result.err &&
    typeof result.err.msg === "string"
  ) {
    return result.err.msg;
  }
  return "Unknown XML validation error";
}

/**
 * Live feeds never declare custom XML entities. Reject any document that does:
 * an internal-subset <!ENTITY ...> is the billion-laughs amplification vector.
 */
function assertNoEntityDeclarations(content: string): void {
  if (/<!ENTITY/i.test(content)) {
    throw new Error("XML entity declarations are not allowed");
  }
}

export function isXmlObject(value: unknown): value is XmlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripXmlNamespace(name: string): string {
  const idx = name.indexOf(":");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Returns a flat, independent copy of a string.
 *
 * Streaming SAX parsers (saxes) hand back attribute/text values as substrings of
 * the current input chunk. V8 represents those as "sliced strings" that keep the
 * entire backing chunk (tens of KB) alive for as long as the slice is reachable.
 * When such a value is retained long-term — e.g. a measurement-site id used as a
 * Map key or baked into a feature id — it pins every chunk it came from, bloating
 * a 97k-entry site-table map from ~40 MB to ~380 MB. Round-tripping through a
 * Buffer forces a fresh, standalone allocation that holds nothing but its own
 * bytes. Use this on any short string kept past the chunk that produced it.
 */
export function flattenString(s: string): string {
  return Buffer.from(s, "utf8").toString("utf8");
}

export function parseXmlDocument(
  content: string | Buffer,
  options: XmlParseOptions = {}
): XmlObject {
  const str = Buffer.isBuffer(content) ? content.toString("utf8") : content;

  assertNoEntityDeclarations(str);

  if (options.validate ?? true) {
    const result = XMLValidator.validate(str);
    if (result !== true) {
      throw new Error(`Invalid XML document: ${validationMessage(result)}`);
    }
  }

  const parser = new XMLParser({
    attributeNamePrefix: XML_ATTRIBUTE_PREFIX,
    ignoreAttributes: options.ignoreAttributes ?? false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
    removeNSPrefix: options.removeNSPrefix ?? false,
    trimValues: true,
    isArray: options.isArray,
  });

  const parsed = parser.parse(str) as unknown;
  if (!isXmlObject(parsed)) {
    throw new Error("Expected XML document to parse into an object root.");
  }
  return parsed;
}

export function xmlNodeToArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function xmlText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!isXmlObject(value)) return undefined;

  const textValue = value["#text"] ?? value["text"];
  if (typeof textValue === "string") return textValue;
  if (typeof textValue === "number" || typeof textValue === "boolean") return String(textValue);
  return undefined;
}

export function getXmlAttribute(node: unknown, name: string): string | undefined {
  if (!isXmlObject(node)) return undefined;
  return xmlText(node[`${XML_ATTRIBUTE_PREFIX}${name}`]);
}

export function getXmlChild(node: unknown, key: string): XmlObject | undefined {
  if (!isXmlObject(node)) return undefined;
  const child = node[key];
  return isXmlObject(child) ? child : undefined;
}

/**
 * Text of a child element regardless of whether it parsed as a string (leaf
 * `<x>v</x>`) or an object (`<x a="1">v</x>` → `{ "#text": "v" }`). Use this for
 * leaf-value reads — `getXmlChild` returns undefined for string children, so
 * `xmlText(getXmlChild(...))` silently drops plain-text leaves.
 */
export function getXmlChildText(node: unknown, key: string): string | undefined {
  if (!isXmlObject(node)) return undefined;
  return xmlText(node[key]);
}

export function getXmlChildren(node: unknown, key: string): XmlObject[] {
  if (!isXmlObject(node)) return [];
  return xmlNodeToArray(node[key]).filter(isXmlObject);
}
