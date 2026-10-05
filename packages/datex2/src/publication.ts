import { elementType, localChild, localChildren, localChildText } from "./values.js";
import { isXmlObject, stripXmlNamespace, type XmlObject, xmlNodeToArray } from "./xml.js";

/** One payload publication in a DATEX II document, whichever wrapper carried it. */
export interface DatexPublication {
  version: 2 | 3;
  /** The publication class without namespace, e.g. `ParkingTablePublication`. */
  type: string;
  publicationTime?: string;
  /** The publication element; for a v2 generic publication, its extension's publication. */
  body: XmlObject;
}

/**
 * The document element to look for publications under: some national access
 * points (France DIR / Bison Futé) wrap the DATEX document in a SOAP envelope.
 */
export function datexRoot(doc: XmlObject): XmlObject {
  return localChild(localChild(doc, "Envelope"), "Body") ?? doc;
}

function firstElement(node: XmlObject): { name: string; element: XmlObject } | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    const element = xmlNodeToArray(value).find(isXmlObject);
    if (element) return { name: stripXmlNamespace(key), element };
  }
  return undefined;
}

const capitalised = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** `fallbackType` names the publication when it declares no `xsi:type`. */
function publication(element: XmlObject, version: 2 | 3, fallbackType = ""): DatexPublication {
  const publicationTime = localChildText(element, "publicationTime");
  const time = publicationTime === undefined ? {} : { publicationTime };
  const declared = elementType(element);
  if (declared === "GenericPublication") {
    // NDW and CITA publish their v2 parking tables and statuses as a generic
    // publication whose extension holds the real one.
    const inner = firstElement(localChild(element, "genericPublicationExtension") ?? {});
    const type =
      localChildText(element, "genericPublicationName") ??
      (inner ? capitalised(inner.name) : declared);
    return { version, type, ...time, body: inner?.element ?? element };
  }
  return { version, type: declared || fallbackType, ...time, body: element };
}

/**
 * Every payload publication in a DATEX II document: v2
 * `d2LogicalModel/payloadPublication` (a generic publication resolved to its
 * extension), v3 `messageContainer/payload` and a v3 `payload` document root,
 * inside a SOAP envelope or not. Namespace prefixes may be kept or stripped.
 */
export function datexPublications(doc: XmlObject): DatexPublication[] {
  const root = datexRoot(doc);

  const container = localChild(root, "messageContainer");
  if (container) {
    const found = [
      ...localChildren(container, "payload"),
      ...localChildren(container, "payloadPublication"),
    ].map((p) => publication(p, 3));
    if (found.length > 0) return found;
  }

  const logicalModel = localChild(root, "d2LogicalModel") ?? localChild(root, "D2LogicalModel");
  if (logicalModel) {
    const v3 = localChildren(logicalModel, "payload").map((p) => publication(p, 3));
    if (v3.length > 0) return v3;
    const v2 = localChildren(logicalModel, "payloadPublication").map((p) => publication(p, 2));
    if (v2.length > 0) return v2;
    // A publication element named for its class (`situationPublication`).
    for (const [key, value] of Object.entries(logicalModel)) {
      if (key.startsWith("@_")) continue;
      const name = stripXmlNamespace(key);
      if (!name.endsWith("Publication")) continue;
      const element = xmlNodeToArray(value).find(isXmlObject);
      if (element) return [publication(element, 2, capitalised(name))];
    }
  }

  const found: DatexPublication[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith("@_")) continue;
    const name = stripXmlNamespace(key);
    if (name !== "payload" && name !== "D2Payload") continue;
    for (const element of xmlNodeToArray(value).filter(isXmlObject)) {
      found.push(publication(element, 3));
    }
  }
  return found;
}
