import { type SchemaFile, xsdEnumerations } from "@openconditions/conformance";
import { CAP_NAMESPACE, CAP_SCHEMA } from "@openconditions/conformance/standards/cap-v1.2";
import { XMLParser } from "fast-xml-parser";

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
});

const children = (node: Node): [string, Node[]][] =>
  Object.entries(node).flatMap(([key, value]) =>
    key.startsWith("@") || key === "#text" || !Array.isArray(value)
      ? []
      : [[key, value.filter((v): v is Node => typeof v === "object" && v !== null)]],
  );

/** An element declaration's name, or the local name of the global element it refers to. */
const elementName = (element: Node): string | undefined => {
  const name = element["@name"] ?? element["@ref"];
  return typeof name === "string" ? name.slice(name.indexOf(":") + 1) : undefined;
};

/**
 * What the CAP 1.2 schema declares, read from the pinned XSD: the values of
 * each element whose type is an enumeration (CAP declares every enumeration
 * as an anonymous type inside its element: `status`, `category`, …), and
 * each element's children in the order its sequence requires.
 */
export interface CapSchema {
  enumerations: ReadonlyMap<string, readonly string[]>;
  children: ReadonlyMap<string, readonly string[]>;
}

export function capSchema(files: readonly SchemaFile[]): CapSchema {
  const xsd = files.find((f) => f.fileName === CAP_SCHEMA);
  if (xsd === undefined) throw new Error(`no ${CAP_SCHEMA}`);
  const enumerations = new Map(
    xsdEnumerations([xsd])
      .filter((e) => e.declaredBy === "element")
      .map((e) => [e.name, e.values] as const),
  );
  const order = new Map<string, string[]>();
  const walk = (node: Node, parent: string | undefined): void => {
    for (const [key, nodes] of children(node)) {
      for (const child of nodes) {
        if (key !== "element") {
          walk(child, parent);
          continue;
        }
        const name = elementName(child);
        if (name === undefined) continue;
        if (parent !== undefined) {
          const siblings = order.get(parent) ?? [];
          if (!siblings.includes(name)) siblings.push(name);
          order.set(parent, siblings);
        }
        walk(child, name);
      }
    }
  };
  const root = (parser.parse(xsd.contents) as { schema: Node[] }).schema[0]!;
  walk(root, undefined);
  return { enumerations, children: order };
}

/** The values the CAP schema enumerates for one element. */
export function capValues(schema: CapSchema, element: string): string[] {
  const values = schema.enumerations.get(element);
  if (values === undefined) throw new Error(`CAP enumerates no ${element}`);
  return [...values];
}

const escapeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A CAP message written as JSON (MeteoAlarm's `alert`: every element a key,
 * every repeatable one a list) as the CAP XML it renders, children in the
 * order the schema requires. A key the schema does not declare is written
 * after the declared ones, so validation reports it rather than losing it.
 */
export function capJsonAsXml(schema: CapSchema, alert: unknown): string {
  const write = (name: string, value: unknown): string => {
    if (Array.isArray(value)) return value.map((v) => write(name, v)).join("");
    if (typeof value === "object" && value !== null) {
      const declared = schema.children.get(name) ?? [];
      const keys = [
        ...declared.filter((k) => k in value),
        ...Object.keys(value).filter((k) => !declared.includes(k)),
      ];
      const body = keys.map((k) => write(k, (value as Node)[k])).join("");
      return `<${name}>${body}</${name}>`;
    }
    return `<${name}>${escapeText(String(value))}</${name}>`;
  };
  return write("alert", alert).replace("<alert>", `<alert xmlns="${CAP_NAMESPACE}">`);
}

/**
 * The CAP alerts an RSS document embeds (GDACS's `cap:alert` per item), each
 * as a document of its own: the item's `alert` element with the CAP
 * namespace declared on it, as the RSS root declared it.
 */
export function embeddedCapAlerts(rss: string): string[] {
  const prefix = /xmlns:([\w.-]+)\s*=\s*"urn:oasis:names:tc:emergency:cap:1\.2"/.exec(rss)?.[1];
  if (prefix === undefined) throw new Error("the document declares no CAP 1.2 prefix");
  const element = new RegExp(`<${prefix}:alert>[\\s\\S]*?</${prefix}:alert>`, "g");
  return [...rss.matchAll(element)].map(([alert]) =>
    alert.replace(`<${prefix}:alert>`, `<${prefix}:alert xmlns:${prefix}="${CAP_NAMESPACE}">`),
  );
}
