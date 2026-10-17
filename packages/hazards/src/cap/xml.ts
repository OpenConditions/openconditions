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

/**
 * One CAP XML document as a `CapAlert`. Throws a `CapReadError` on a document
 * that declares XML entities (CAP needs none, and an internal entity is the
 * billion-laughs amplification vector), on one whose root is not `alert`,
 * which is no CAP message but a publisher's error or index page, and on a
 * message of an earlier CAP version (`unsupported_version`). A root `alert`
 * that declares no namespace at all is read as CAP 1.2.
 */
export function readCapXml(body: Buffer): CapAlert {
  const text = body.toString("utf8");
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
