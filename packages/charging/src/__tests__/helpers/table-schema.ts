/**
 * A Frictionless Table Schema (v1) validator for CSV files, enough of the
 * specification to hold a publisher's file to a schema a standard publishes:
 * the header against the fields, each cell against its field's type and
 * format (with `missingValues` read as null), and the `required`, `unique`,
 * `enum`, `pattern`, `minimum`/`maximum` and `minLength`/`maxLength`
 * constraints, then the `primaryKey` and `uniqueKeys` across rows.
 *
 * It follows https://specs.frictionlessdata.io/table-schema/, not any one
 * implementation: a datetime of the default format is ISO 8601 with its `T`,
 * where a lenient library (Validata's dateutil) also takes a space.
 */

export interface TableSchemaField {
  name: string;
  type: string;
  format?: string;
  description?: string;
  trueValues?: string[];
  falseValues?: string[];
  decimalChar?: string;
  groupChar?: string;
  bareNumber?: boolean;
  constraints?: {
    required?: boolean;
    unique?: boolean;
    enum?: unknown[];
    pattern?: string;
    minimum?: number | string;
    maximum?: number | string;
    minLength?: number;
    maxLength?: number;
  };
}

export interface TableSchema {
  fields: TableSchemaField[];
  missingValues?: string[];
  primaryKey?: string | string[];
  uniqueKeys?: string[][];
}

/** One violation: `row` is the data row (1 is the first after the header), 0 for the header. */
export interface TableError {
  row: number;
  field: string;
  message: string;
}

export interface TableReport {
  /** The file's columns that no field of the schema names, in file order. */
  extraColumns: string[];
  errors: TableError[];
  rows: number;
}

/** RFC 4180 records of a CSV text: quoted cells may hold delimiters, quotes and line breaks. */
export function csvRecords(text: string, delimiter = ","): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.startsWith("﻿") ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      record.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records.filter((r) => r.some((c) => c !== ""));
}

const DEFAULT_TRUE = ["true", "True", "TRUE", "1"];
const DEFAULT_FALSE = ["false", "False", "FALSE", "0"];

/** The physical values a boolean field reads as true and as false. */
export function booleanValues(field: TableSchemaField): { true: string[]; false: string[] } {
  return { true: field.trueValues ?? DEFAULT_TRUE, false: field.falseValues ?? DEFAULT_FALSE };
}

/** A field's `enum` constraint as strings; empty when it has none. */
export const enumOf = (field: TableSchemaField): string[] =>
  (field.constraints?.enum ?? []).map((v) => String(v));

export function fieldOf(schema: TableSchema, name: string): TableSchemaField {
  const field = schema.fields.find((f) => f.name === name);
  if (field === undefined) throw new Error(`the schema has no field ${name}`);
  return field;
}

function validDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const validTime = (h: number, min: number, s: number) =>
  (h < 24 && min < 60 && s < 61) || (h === 24 && min === 0 && s === 0);

/** A strptime pattern as an anchored regular expression with named parts. */
function strptimeRegex(pattern: string): RegExp {
  const parts: Record<string, string> = {
    Y: "(?<Y>\\d{4})",
    y: "(?<y>\\d{2})",
    m: "(?<m>\\d{1,2})",
    d: "(?<d>\\d{1,2})",
    H: "(?<H>\\d{1,2})",
    M: "(?<M>\\d{1,2})",
    S: "(?<S>\\d{1,2})",
    f: "(?<f>\\d{1,6})",
    z: "(?<z>[+-]\\d{2}:?\\d{2}|Z)",
    "%": "%",
  };
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch !== "%") {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    const directive = parts[pattern[++i] ?? ""];
    if (directive === undefined) throw new Error(`strptime directive %${pattern[i]} not supported`);
    out += directive;
  }
  return new RegExp(`^${out}$`);
}

function strptimeValid(value: string, pattern: string): boolean {
  const m = strptimeRegex(pattern).exec(value);
  if (m === null) return false;
  const g = m.groups ?? {};
  const year =
    g["Y"] !== undefined ? Number(g["Y"]) : g["y"] !== undefined ? 2000 + Number(g["y"]) : 2000;
  const month = g["m"] === undefined ? 1 : Number(g["m"]);
  const day = g["d"] === undefined ? 1 : Number(g["d"]);
  return (
    validDate(year, month, day) &&
    validTime(Number(g["H"] ?? 0), Number(g["M"] ?? 0), Number(g["S"] ?? 0))
  );
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isLon = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;
const isLat = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** A cell's logical value for the comparing constraints, or an error message. */
type Cast = { value: unknown } | { error: string };

function numberText(field: TableSchemaField, raw: string): string {
  let v = raw;
  if (field.bareNumber === false) v = v.replace(/^[^\d+\-.]+|[^\d.]+$/g, "");
  if (field.groupChar) v = v.split(field.groupChar).join("");
  if (field.decimalChar && field.decimalChar !== ".") v = v.split(field.decimalChar).join(".");
  return v;
}

function cast(field: TableSchemaField, raw: string): Cast {
  const format = field.format ?? "default";
  const bad = (what: string): Cast => ({ error: `"${raw}" is no ${what}` });
  switch (field.type) {
    case "string":
      if (format === "email" && !EMAIL.test(raw)) return bad("email address");
      if (format === "uri" && !URL.canParse(raw)) return bad("URI");
      if (format === "uuid" && !UUID.test(raw)) return bad("UUID");
      if (format === "binary" && !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return bad("base64");
      return { value: raw };
    case "number": {
      const v = numberText(field, raw);
      if (["NaN", "INF", "-INF"].includes(v))
        return { value: Number(v.replace("INF", "Infinity")) };
      return NUMBER.test(v) ? { value: Number(v) } : bad("number");
    }
    case "integer": {
      const v = numberText(field, raw);
      return /^[+-]?\d+$/.test(v) ? { value: Number(v) } : bad("integer");
    }
    case "boolean": {
      const values = booleanValues(field);
      if (values.true.includes(raw)) return { value: true };
      if (values.false.includes(raw)) return { value: false };
      return bad(`boolean (${[...values.true, ...values.false].join(", ")})`);
    }
    case "date": {
      if (format === "any") return Number.isNaN(Date.parse(raw)) ? bad("date") : { value: raw };
      if (format !== "default")
        return strptimeValid(raw, format) ? { value: raw } : bad(`date of ${format}`);
      const m = ISO_DATE.exec(raw);
      return m && validDate(Number(m[1]), Number(m[2]), Number(m[3]))
        ? { value: raw }
        : bad("ISO 8601 date");
    }
    case "time": {
      if (format !== "default" && format !== "any") {
        return strptimeValid(raw, format) ? { value: raw } : bad(`time of ${format}`);
      }
      const m = ISO_TIME.exec(raw);
      return m && validTime(Number(m[1]), Number(m[2]), Number(m[3]))
        ? { value: raw }
        : bad("ISO 8601 time");
    }
    case "datetime": {
      if (format === "any") return Number.isNaN(Date.parse(raw)) ? bad("datetime") : { value: raw };
      if (format !== "default") {
        return strptimeValid(raw, format) ? { value: raw } : bad(`datetime of ${format}`);
      }
      const m = ISO_DATETIME.exec(raw);
      return m &&
        validDate(Number(m[1]), Number(m[2]), Number(m[3])) &&
        validTime(Number(m[4]), Number(m[5]), Number(m[6]))
        ? { value: raw }
        : bad("ISO 8601 datetime (YYYY-MM-DDThh:mm:ss)");
    }
    case "year":
      return /^-?\d{4}$/.test(raw) ? { value: Number(raw) } : bad("year");
    case "yearmonth":
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? { value: raw } : bad("year and month");
    case "geopoint": {
      if (format === "default") {
        const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(raw);
        const [lon, lat] = m ? [Number(m[1]), Number(m[2])] : [];
        return isLon(lon) && isLat(lat) ? { value: [lon, lat] } : bad("geopoint (lon, lat)");
      }
      const v = json(raw);
      if (format === "array") {
        return Array.isArray(v) && v.length === 2 && isLon(v[0]) && isLat(v[1])
          ? { value: v }
          : bad("geopoint array [lon, lat]");
      }
      if (format === "object") {
        const o = v as Record<string, unknown> | undefined;
        return o &&
          typeof o === "object" &&
          Object.keys(o).length === 2 &&
          isLon(o["lon"]) &&
          isLat(o["lat"])
          ? { value: [o["lon"], o["lat"]] }
          : bad("geopoint object {lon, lat}");
      }
      throw new Error(`geopoint format ${format} not supported`);
    }
    case "array": {
      const v = json(raw);
      return Array.isArray(v) ? { value: v } : bad("JSON array");
    }
    case "object":
    case "geojson": {
      const v = json(raw);
      return v !== null && typeof v === "object" && !Array.isArray(v)
        ? { value: v }
        : bad("JSON object");
    }
    case "duration":
      return /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(raw)
        ? { value: raw }
        : bad("ISO 8601 duration");
    case "any":
      return { value: raw };
    default:
      throw new Error(`field ${field.name}: Table Schema type ${field.type} not supported`);
  }
}

/** A comparable form of a logical value for `minimum`/`maximum`. */
const comparable = (v: unknown): number | string =>
  typeof v === "number" ? v : typeof v === "string" ? v : JSON.stringify(v);

function bound(field: TableSchemaField, limit: number | string): number | string {
  if (typeof limit === "number") return limit;
  const c = cast(field, limit);
  if ("error" in c) throw new Error(`field ${field.name}: bound ${limit} does not cast`);
  return comparable(c.value);
}

/**
 * The XML Schema regular expression of a `pattern` constraint as JavaScript:
 * XML Schema patterns match the whole value, so the pattern is anchored.
 */
export const patternRegex = (pattern: string) => new RegExp(`^(?:${pattern})$`, "u");

/** Validates a CSV text against a Table Schema. */
export function validateTable(schema: TableSchema, text: string, delimiter = ","): TableReport {
  const [header = [], ...rows] = csvRecords(text, delimiter);
  const errors: TableError[] = [];
  const missing = schema.missingValues ?? [""];
  const names = schema.fields.map((f) => f.name);
  const columns = new Map<string, number>();
  header.forEach((name, i) => {
    if (columns.has(name)) errors.push({ row: 0, field: name, message: "duplicate column" });
    else columns.set(name, i);
  });
  for (const name of names) {
    if (!columns.has(name)) errors.push({ row: 0, field: name, message: "missing column" });
  }
  const present = header.filter((h) => names.includes(h));
  const expected = names.filter((n) => columns.has(n));
  if (present.join("\n") !== expected.join("\n")) {
    errors.push({
      row: 0,
      field: "*",
      message: `columns out of the schema's order: ${present.join(", ")}`,
    });
  }
  const primary =
    schema.primaryKey === undefined
      ? []
      : typeof schema.primaryKey === "string"
        ? [schema.primaryKey]
        : schema.primaryKey;
  const keys: { fields: string[]; primary: boolean }[] = [
    ...(primary.length ? [{ fields: primary, primary: true }] : []),
    ...(schema.uniqueKeys ?? []).map((fields) => ({ fields, primary: false })),
    ...schema.fields
      .filter((f) => f.constraints?.unique)
      .map((f) => ({ fields: [f.name], primary: false })),
  ];
  const seen = keys.map(() => new Map<string, number>());
  const patterns = new Map(
    schema.fields
      .filter((f) => f.constraints?.pattern !== undefined)
      .map((f) => [f.name, patternRegex(f.constraints!.pattern!)]),
  );

  rows.forEach((cells, index) => {
    const row = index + 1;
    if (cells.length !== header.length) {
      errors.push({
        row,
        field: "*",
        message: `${cells.length} cells for ${header.length} columns`,
      });
    }
    const logical = new Map<string, unknown>();
    for (const field of schema.fields) {
      const at = columns.get(field.name);
      if (at === undefined) continue;
      const raw = cells[at] ?? "";
      const c = field.constraints ?? {};
      const fail = (message: string) => errors.push({ row, field: field.name, message });
      if (missing.includes(raw)) {
        if (c.required || primary.includes(field.name)) fail("required but missing");
        logical.set(field.name, null);
        continue;
      }
      const result = cast(field, raw);
      if ("error" in result) {
        fail(result.error);
        continue;
      }
      logical.set(field.name, result.value);
      if (c.enum !== undefined && !c.enum.map((v) => String(v)).includes(String(result.value))) {
        fail(`"${raw}" is not one of ${c.enum.map((v) => `"${v}"`).join(", ")}`);
      }
      const pattern = patterns.get(field.name);
      if (pattern !== undefined && !pattern.test(raw)) fail(`"${raw}" does not match ${c.pattern}`);
      const v = comparable(result.value);
      if (c.minimum !== undefined && v < bound(field, c.minimum))
        fail(`${raw} is below ${c.minimum}`);
      if (c.maximum !== undefined && v > bound(field, c.maximum))
        fail(`${raw} is above ${c.maximum}`);
      const length = Array.isArray(result.value) ? result.value.length : raw.length;
      if (c.minLength !== undefined && length < c.minLength) fail(`shorter than ${c.minLength}`);
      if (c.maxLength !== undefined && length > c.maxLength) fail(`longer than ${c.maxLength}`);
    }
    keys.forEach((key, k) => {
      const values = key.fields.map((f) => logical.get(f));
      // A unique key holds among the rows that have all its parts; a primary key's parts are required.
      if (!key.primary && values.some((v) => v === null || v === undefined)) return;
      const id = JSON.stringify(values);
      const first = seen[k]!.get(id);
      if (first === undefined) seen[k]!.set(id, row);
      else {
        errors.push({
          row,
          field: key.fields.join("+"),
          message: `${key.primary ? "primary" : "unique"} key repeats row ${first}`,
        });
      }
    });
  });
  return { extraColumns: header.filter((h) => !names.includes(h)), errors, rows: rows.length };
}
