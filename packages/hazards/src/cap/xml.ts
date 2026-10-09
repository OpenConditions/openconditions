import { XMLParser } from "fast-xml-parser";
import { isRecord } from "../records.js";
import type { CapAlert } from "./types.js";

/** The CAP elements that may repeat, which the decoder always reads as lists. */
const REPEATED = new Set([
  "code",
  "info",
  "category",
  "responseType",
  "eventCode",
  "parameter",
  "area",
  "polygon",
  "circle",
  "geocode",
]);

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (tag) => REPEATED.has(tag),
});

/**
 * One CAP XML document as a `CapAlert`. Throws on a document that declares
 * XML entities (CAP needs none, and an internal entity is the
 * billion-laughs amplification vector) and on one whose root is not
 * `alert`, which is no CAP message but a publisher's error or index page.
 */
export function readCapXml(body: Buffer): CapAlert {
  const text = body.toString("utf8");
  if (/<!ENTITY/i.test(text)) throw new Error("CAP: XML entity declarations are not allowed");
  const doc: unknown = parser.parse(text);
  const alert = isRecord(doc) ? doc["alert"] : undefined;
  if (!isRecord(alert)) {
    const roots = isRecord(doc) ? Object.keys(doc).filter((k) => !k.startsWith("?")) : [];
    throw new Error(`CAP: the document's root is ${roots[0] ?? "missing"}, not alert`);
  }
  return alert as unknown as CapAlert;
}
