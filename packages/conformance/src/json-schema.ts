import { Ajv, type AnySchemaObject, type ErrorObject, type Options } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";

// ajv-formats is CommonJS with a default export, which NodeNext types as the module.
const addFormats = ((formatsModule as unknown as { default?: unknown }).default ??
  formatsModule) as (ajv: Ajv | Ajv2019 | Ajv2020) => void;

type Json = Record<string, unknown>;

/** The JSON Schema dialects the standards' schemas are written in. */
export type JsonSchemaDraft = "draft-07" | "2019-09" | "2020-12";

/** Validation errors of a document, empty when it is valid. */
export type JsonValidator = (data: unknown) => string[];

/** The dialect a schema names in `$schema`, draft-07 when it names none or an older one. */
export function draftOf(schema: Json): JsonSchemaDraft {
  const id = typeof schema["$schema"] === "string" ? schema["$schema"] : "";
  if (id.includes("2020-12")) return "2020-12";
  if (id.includes("2019-09")) return "2019-09";
  return "draft-07";
}

function ajvFor(draft: JsonSchemaDraft, options: Options = {}): Ajv | Ajv2019 | Ajv2020 {
  // Not strict: the standards' schemas carry annotations of their own
  // (`example`, `x-*`, `deprecated`), which describe rather than constrain.
  const common: Options = { strict: false, allErrors: true, ...options };
  const ajv =
    draft === "2020-12"
      ? new Ajv2020(common)
      : draft === "2019-09"
        ? new Ajv2019(common)
        : new Ajv(common);
  addFormats(ajv);
  return ajv;
}

const describe = (errors: readonly ErrorObject[] | null | undefined): string[] =>
  (errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? e.keyword} ${JSON.stringify(e.params)}`,
  );

/**
 * A validator for one JSON Schema. `refs` are further schemas its `$ref`s
 * name by `$id`; a draft-04 or draft-06 schema is read as draft-07, whose
 * keywords it shares for everything the standards here use.
 */
export function jsonSchemaValidator(
  schema: Json,
  options: { draft?: JsonSchemaDraft; refs?: readonly Json[] } = {},
): JsonValidator {
  const ajv = ajvFor(options.draft ?? draftOf(schema), { validateSchema: false });
  for (const ref of options.refs ?? []) ajv.addSchema(ref as AnySchemaObject);
  const { $schema: _dialect, ...body } = schema;
  const validate = ajv.compile(body);
  return (data) => (validate(data) ? [] : describe(validate.errors));
}

const OPENAPI_ID = "https://conformance.openconditions.invalid/openapi.json";

/**
 * A validator for one of an OpenAPI document's component schemas, by name.
 * OpenAPI 3.0's `nullable` and `discriminator` are read as OpenAPI defines
 * them; a 3.1 document's schemas are JSON Schema 2020-12.
 */
export function openApiValidator(doc: Json, schemaName: string): JsonValidator {
  const version = typeof doc["openapi"] === "string" ? doc["openapi"] : "";
  const ajv = ajvFor(version.startsWith("3.1") ? "2020-12" : "draft-07", {
    validateSchema: false,
    discriminator: true,
  });
  ajv.addSchema({ ...doc, $id: OPENAPI_ID } as AnySchemaObject);
  const validate = ajv.getSchema(`${OPENAPI_ID}#/components/schemas/${schemaName}`);
  if (!validate) throw new Error(`the OpenAPI document has no schema ${schemaName}`);
  return (data) => (validate(data) ? [] : describe(validate.errors));
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null;

/** A schema's alternatives that are each a single constant, as an enumeration. */
function constAlternatives(schema: Json): unknown[] | undefined {
  for (const key of ["oneOf", "anyOf"]) {
    const alternatives = schema[key];
    if (
      Array.isArray(alternatives) &&
      alternatives.length > 0 &&
      alternatives.every((a) => isObject(a) && "const" in a)
    ) {
      return alternatives.map((a) => (a as Json)["const"]);
    }
  }
  return undefined;
}

/**
 * Every enumeration in a JSON Schema or OpenAPI document, by the JSON pointer
 * of the schema holding it: an `enum`, or `oneOf`/`anyOf` alternatives that
 * are each a `const`. Values are kept as strings; a `null` member, which
 * marks an optional value rather than one to map, is left out.
 */
export function jsonSchemaEnums(doc: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const token = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
  const walk = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      for (const [i, child] of node.entries()) walk(child, `${pointer}/${i}`);
      return;
    }
    if (!isObject(node)) return;
    const values = Array.isArray(node["enum"]) ? node["enum"] : constAlternatives(node);
    if (values) {
      out.set(
        pointer,
        values.filter((v) => v !== null).map((v) => String(v)),
      );
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${pointer}/${token(key)}`);
  };
  walk(doc, "#");
  return out;
}

/** The enumeration of one named definition (`definitions`, `$defs` or OpenAPI components). */
export function definitionEnum(doc: unknown, name: string): string[] {
  const enums = jsonSchemaEnums(doc);
  for (const prefix of ["#/definitions/", "#/$defs/", "#/components/schemas/"]) {
    const values = enums.get(`${prefix}${name}`);
    if (values) return values;
  }
  throw new Error(`no enumerated definition ${name}`);
}
