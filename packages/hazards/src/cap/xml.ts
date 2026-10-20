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

/** The document element's prefix, local name and attributes, from the first tag that is no declaration or comment. */
const ROOT = /<(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)(\s[^>]*)?>/;

/** The namespace the document element is in, undefined when it declares none. */
function rootNamespace(text: string): string | undefined {
  const root = ROOT.exec(text);
  if (root === null) return undefined;
  const [, prefix, , attributes = ""] = root;
  const name = prefix === undefined ? "xmlns" : `xmlns:${prefix}`;
  const declared = new RegExp(`\\s${name.replaceAll(".", "\\.")}\\s*=\\s*(["'])(.*?)\\1`).exec(
    attributes,
  );
  return declared?.[2]?.trim();
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
  const alert = isRecord(doc) ? doc["alert"] : undefined;
  if (!isRecord(alert)) {
    const roots = isRecord(doc) ? Object.keys(doc).filter((k) => !k.startsWith("?")) : [];
    throw new CapReadError(
      `CAP: the document's root is ${roots[0] ?? "missing"}, not alert`,
      "malformed",
    );
  }
  const namespace = rootNamespace(text);
  if (namespace !== undefined && namespace !== CAP_1_2_NAMESPACE) {
    throw EARLIER_CAP.test(namespace)
      ? new CapReadError(`CAP: ${namespace} is not CAP 1.2`, "unsupported_version")
      : new CapReadError(`CAP: the alert is in ${namespace}, not CAP 1.2's namespace`, "malformed");
  }
  return alert as unknown as CapAlert;
}
