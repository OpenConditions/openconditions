import type { RecordSkipReason } from "@openconditions/ingest-framework";
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
  "resource",
  "area",
  "polygon",
  "circle",
  "geocode",
]);

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  captureMetaData: true,
  isArray: (tag) => REPEATED.has(tag),
});

/** The namespace CAP 1.2 puts every element of a message in. */
export const CAP_1_2_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2";

/** The namespaces of the CAP versions before 1.2, whose messages this decoder does not read. */
const EARLIER_CAP =
  /^(?:urn:oasis:names:tc:emergency:cap:1\.[01]|http:\/\/www\.incident\.com\/cap\/1\.0)$/;

/** A CAP document that does not decode, and the reason its record is skipped under. */
export class CapReadError extends Error {
  constructor(
    message: string,
    readonly reason: Extract<RecordSkipReason, "malformed" | "unsupported_version">,
  ) {
    super(message);
  }
}

const XML_METADATA = XMLParser.getMetaDataSymbol() as symbol;

/** Read only the parsed alert's opening tag; quoted values cannot supply declarations. */
function rootNamespace(text: string, alert: Record<string, unknown>): string | undefined {
  const metadata: unknown = Reflect.get(alert, XML_METADATA);
  const offset = isRecord(metadata) ? metadata["startIndex"] : undefined;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= text.length
  ) {
    throw new CapReadError("CAP: cannot locate the alert document element", "malformed");
  }
  // fast-xml-parser counts offsets after normalizing CRLF (and CR) to LF.
  let start = 0;
  for (let index = 0; index < offset; index++, start++) {
    if (text[start] === "\r" && text[start + 1] === "\n") start++;
  }
  if (text[start] !== "<") {
    throw new CapReadError("CAP: cannot locate the alert document element", "malformed");
  }
  let at = start + 1;
  while (at < text.length && !/[\s>]/u.test(text.charAt(at))) at++;
  const name = text.slice(start + 1, at).replace(/\/$/u, "");
  const colon = name.indexOf(":");
  if (name.slice(colon + 1) !== "alert") {
    throw new CapReadError("CAP: cannot locate the alert document element", "malformed");
  }
  const declaration = colon < 0 ? "xmlns" : `xmlns:${name.slice(0, colon)}`;
  while (at < text.length) {
    const separated = /\s/u.test(text.charAt(at));
    while (/\s/u.test(text.charAt(at))) at++;
    if (text[at] === ">") return undefined;
    const from = at;
    while (at < text.length && !/[\s=>]/u.test(text.charAt(at))) at++;
    const attribute = text.slice(from, at);
    let equals = at;
    while (/\s/u.test(text.charAt(equals))) equals++;
    if (text[equals] !== "=") continue;
    at = equals + 1;
    while (/\s/u.test(text.charAt(at))) at++;
    const quote = text[at];
    if (quote !== '"' && quote !== "'") {
      // As before, only quoted namespace declarations are recognized.
      while (at < text.length && !/[\s>]/u.test(text.charAt(at))) at++;
      continue;
    }
    const end = text.indexOf(quote, at + 1);
    if (end < 0) throw new CapReadError("CAP: unclosed document attribute", "malformed");
    if (separated && attribute === declaration) return text.slice(at + 1, end).trim();
    at = end + 1;
  }
  return undefined;
}

/** Source offsets are validation-only, never part of the CAP projection. */
function stripXmlMetadata(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  Reflect.deleteProperty(value, XML_METADATA);
  for (const child of Object.values(value)) stripXmlMetadata(child);
}

/** The encoding an XML declaration names. */
const DECLARED_ENCODING = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*(["'])([A-Za-z][\w.:-]*)\1/;

const UTF8 = new Set(["utf-8", "utf8", "unicode-1-1-utf-8"]);

/**
 * A document's text, in UTF-16 when it starts with that encoding's
 * byte-order mark, else in the encoding its XML declaration names; UTF-8 when
 * it names none or one the platform does not know. Bytes that are no UTF-8
 * under a UTF-8 declaration are read as Windows-1252, the single-byte
 * encoding such bytes almost always are: OASIS's own CAP 1.2 example of a
 * multilingual message declares UTF-8 but is written in Latin-1, and read as
 * UTF-8 every accented letter of its Spanish block would become U+FFFD.
 */
function decode(body: Buffer): string {
  // A UTF-16 document starts with its byte-order mark, before any declaration.
  if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder("utf-16le").decode(body);
  if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder("utf-16be").decode(body);
  const declared = DECLARED_ENCODING.exec(body.subarray(0, 256).toString("latin1"))?.[2];
  const label = declared?.toLowerCase();
  if (label !== undefined && !UTF8.has(label)) {
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      // A label the platform does not know is read as UTF-8, XML's default.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/**
 * One CAP XML document as a `CapAlert`. Throws a `CapReadError` on a document
 * that declares XML entities (CAP needs none, and an internal entity is the
 * billion-laughs amplification vector), on one whose root is not `alert`,
 * which is no CAP message but a publisher's error or index page, and on a
 * message of an earlier CAP version (`unsupported_version`). A root `alert`
 * that declares no namespace at all is read as CAP 1.2. The text is decoded
 * as its XML declaration says ({@link decode}).
 */
export function readCapXml(body: Buffer): CapAlert {
  const text = decode(body);
  if (/<!ENTITY/i.test(text)) {
    throw new CapReadError("CAP: XML entity declarations are not allowed", "malformed");
  }
  const doc: unknown = parser.parse(text);
  const roots = isRecord(doc)
    ? Object.keys(doc).filter((key) => !key.startsWith("?") && key !== "#text")
    : [];
  const alert = isRecord(doc) ? doc["alert"] : undefined;
  if (roots[0] !== "alert" || !isRecord(alert)) {
    throw new CapReadError(
      `CAP: the document's root is ${roots[0] ?? "missing"}, not alert`,
      "malformed",
    );
  }
  const namespace = rootNamespace(text, alert);
  if (namespace !== undefined && namespace !== CAP_1_2_NAMESPACE) {
    throw EARLIER_CAP.test(namespace)
      ? new CapReadError(`CAP: ${namespace} is not CAP 1.2`, "unsupported_version")
      : new CapReadError(`CAP: the alert is in ${namespace}, not CAP 1.2's namespace`, "malformed");
  }
  stripXmlMetadata(alert);
  return alert as unknown as CapAlert;
}
