import { XMLParser } from "fast-xml-parser";
import { validateXML } from "xmllint-wasm";
import type { SchemaFile } from "./pinned.js";

/**
 * The libxml2 validation errors of an XML document against a schema set,
 * empty when it is valid. `root` names the schema file the document's root
 * element is declared in; the others are loaded for its imports.
 */
export async function xsdErrors(
  xml: string,
  schemas: readonly SchemaFile[],
  root: string,
  fileName = "document.xml",
): Promise<string[]> {
  if (!schemas.some((s) => s.fileName === root)) throw new Error(`no schema file ${root}`);
  const result = await validateXML({
    xml: [{ fileName, contents: xml }],
    schema: schemas.filter((s) => s.fileName === root),
    preload: schemas.filter((s) => s.fileName !== root),
    maxMemoryPages: 4096,
  });
  return result.errors.map((e) => e.rawMessage);
}

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
});

const list = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : []);
const attr = (n: Node, name: string): string | undefined =>
  typeof n[`@${name}`] === "string" ? (n[`@${name}`] as string) : undefined;
/** A QName's local part. */
const local = (qname: string) => qname.slice(qname.indexOf(":") + 1);

/** Every element of one local name at any depth below a node. */
function descendants(node: Node, name: string, out: Node[] = []): Node[] {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@") || key === "#text") continue;
    for (const child of list(value)) {
      if (key === name) out.push(child);
      descendants(child, name, out);
    }
  }
  return out;
}

interface SchemaRoot {
  file: string;
  schema: Node;
  namespace: string;
  /** Namespace URIs by the prefixes the schema root declares. */
  prefixes: Map<string, string>;
}

/**
 * The namespace declarations of a schema document's root element. The parser
 * drops `xmlns` attributes along with the prefixes it removes, so they are
 * read from the root's start tag itself.
 */
function rootPrefixes(contents: string): Map<string, string> {
  const start = /<(?:[\w.-]+:)?schema\b([^>]*)>/.exec(contents)?.[1] ?? "";
  return new Map(
    [...start.matchAll(/\sxmlns(?::([\w.-]+))?\s*=\s*(["'])(.*?)\2/g)].map(
      (m) => [m[1] ?? "", m[3]!] as const,
    ),
  );
}

function schemaRoots(schemas: readonly SchemaFile[]): SchemaRoot[] {
  return schemas.flatMap((s) =>
    list((parser.parse(s.contents) as Node)["schema"]).map((schema) => ({
      file: s.fileName,
      schema,
      namespace: attr(schema, "targetNamespace") ?? "",
      prefixes: rootPrefixes(s.contents),
    })),
  );
}

/** A type's name in Clark notation, `{namespace}local`, unique across a schema set. */
const clark = (namespace: string, name: string) => `{${namespace}}${name}`;

/** A QName attribute value resolved against the schema root's prefixes. */
function resolve(root: SchemaRoot, qname: string): string {
  const colon = qname.indexOf(":");
  const prefix = colon < 0 ? "" : qname.slice(0, colon);
  return clark(root.prefixes.get(prefix) ?? root.namespace, local(qname));
}

/**
 * An enumeration's values and where it is declared: a named simple type, or
 * the anonymous simple type of a named element (CAP declares every one of its
 * enumerations that way), known by the element's name.
 */
export interface XsdEnumeration {
  file: string;
  namespace: string;
  name: string;
  /** Whether `name` is a simple type's or an element's. */
  declaredBy: "type" | "element";
  values: string[];
}

const enumerationValues = (simpleType: Node): string[] =>
  list(simpleType["restriction"]).flatMap((r) =>
    list(r["enumeration"]).map((e) => attr(e, "value") ?? ""),
  );

/** Every enumeration of the schemas, named types first, then elements' anonymous ones. */
export function xsdEnumerations(schemas: readonly SchemaFile[]): XsdEnumeration[] {
  const out: XsdEnumeration[] = [];
  for (const { file, schema, namespace } of schemaRoots(schemas)) {
    for (const type of list(schema["simpleType"])) {
      const name = attr(type, "name");
      const values = enumerationValues(type);
      if (name && values.length > 0)
        out.push({ file, namespace, name, declaredBy: "type", values });
    }
    for (const element of descendants(schema, "element")) {
      const name = attr(element, "name");
      const values = list(element["simpleType"]).flatMap(enumerationValues);
      if (name && values.length > 0) {
        out.push({ file, namespace, name, declaredBy: "element", values });
      }
    }
  }
  return out;
}

/**
 * The values of one enumerated type by local name, narrowed to a namespace
 * where the name is declared in several. Throws when no declaration, or more
 * than one with different values, answers: the caller would not know which
 * list it was checking against.
 */
export function xsdEnumeration(
  enumerations: readonly XsdEnumeration[],
  name: string,
  namespace?: string,
): string[] {
  const found = enumerations.filter(
    (e) => e.name === name && (namespace === undefined || e.namespace === namespace),
  );
  if (found.length === 0) throw new Error(`no enumerated type ${name}`);
  const distinct = new Set(found.map((e) => e.values.join("\n")));
  if (distinct.size > 1) {
    throw new Error(
      `${name} is declared differently in ${found.map((e) => `${e.file} (${e.namespace})`).join(", ")}; name the namespace`,
    );
  }
  return found[0]!.values;
}

/** A named complex type: what it extends or restricts, and whether it is abstract. */
export interface XsdComplexType {
  file: string;
  namespace: string;
  name: string;
  /** The base type in Clark notation, absent for a type with no base. */
  base?: string;
  abstract: boolean;
  /** The local names of the elements its own content declares, in document order. */
  elements: string[];
}

/** Every named complex type of the schemas, by its name in Clark notation. */
export function xsdComplexTypes(schemas: readonly SchemaFile[]): Map<string, XsdComplexType> {
  const out = new Map<string, XsdComplexType>();
  for (const root of schemaRoots(schemas)) {
    for (const type of list(root.schema["complexType"])) {
      const name = attr(type, "name");
      if (!name) continue;
      const derivation = [
        ...descendants(type, "extension"),
        ...descendants(type, "restriction"),
      ].find((d) => attr(d, "base"));
      out.set(clark(root.namespace, name), {
        file: root.file,
        namespace: root.namespace,
        name,
        ...(derivation ? { base: resolve(root, attr(derivation, "base")!) } : {}),
        abstract: attr(type, "abstract") === "true",
        elements: descendants(type, "element")
          .map((e) => attr(e, "name") ?? (attr(e, "ref") ? local(attr(e, "ref")!) : undefined))
          .filter((n): n is string => n !== undefined),
      });
    }
  }
  return out;
}

/**
 * The local names of the types derived from `base` at any depth: the
 * concrete ones only unless `abstract` is set. `base` is a local name, or a
 * name in Clark notation where the local name is declared in several
 * namespaces. A DATEX `SituationRecord`'s concrete subtypes are the record
 * types an `xsi:type` may name.
 */
export function xsdSubtypes(
  types: ReadonlyMap<string, XsdComplexType>,
  base: string,
  options: { abstract?: boolean } = {},
): string[] {
  const roots = base.startsWith("{")
    ? [base]
    : [...types.entries()].filter(([, t]) => t.name === base).map(([key]) => key);
  if (roots.length === 0) throw new Error(`no complex type ${base}`);
  const found = new Map<string, XsdComplexType>();
  const visit = (key: string): void => {
    for (const [child, type] of types) {
      if (type.base === key && child !== key && !found.has(child)) {
        found.set(child, type);
        visit(child);
      }
    }
  };
  for (const root of roots) visit(root);
  return [
    ...new Set(
      [...found.values()].filter((t) => options.abstract || !t.abstract).map((t) => t.name),
    ),
  ].sort();
}
