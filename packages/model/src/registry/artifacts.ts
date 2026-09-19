import { z } from "zod";
import type { Registry } from "./build.js";
import { majorOf, type SchemaVersion } from "./define.js";

/** Kernel schemas published under stable `$defs` names. */
function kernelDefs(registry: Registry) {
  const k = registry.kernel;
  return {
    Text: k.Text,
    Quantity: k.Quantity,
    Money: k.Money,
    RecordRef: k.RecordRef,
    Geometry: k.Geometry,
    ExternalId: k.ExternalId,
    Organization: k.Organization,
    Address: k.Address,
    DirectionRef: k.DirectionRef,
    LaneRef: k.LaneRef,
    RoadRef: k.RoadRef,
    LocationRef: k.LocationRef,
    Schedule: k.Schedule,
    Validity: k.Validity,
    Attribution: k.Attribution,
    RoutingRights: k.RoutingRights,
    Provenance: k.Provenance,
    Freshness: k.Freshness,
    Relation: k.Relation,
    VehicleSelector: k.VehicleSelector,
    VehicleApplicability: k.VehicleApplicability,
    Issue: k.Issue,
    Effect: k.Effect,
    Result: k.Result,
  } as const;
}

function toJson(schema: z.ZodType, ids: z.core.$ZodRegistry<{ id?: string }>) {
  return z.toJSONSchema(schema, { target: "draft-2020-12", metadata: ids }) as Record<
    string,
    unknown
  >;
}

export interface SchemaIndexEntry {
  class: string;
  code: string;
  version: SchemaVersion;
  file: string;
}

/**
 * Every published JSON Schema of a registry, keyed by path under `schemas/`:
 * `kernel@<major>.json` with the kernel `$defs`, one self-contained file per
 * registered kind, property, effect, selector and result schema
 * (`<class>/<code>@<major>.json`), and `index.json` listing them — the rows of
 * `registry_schema` (class, kind|property, version).
 */
export function jsonSchemaArtifacts(registry: Registry): Map<string, unknown> {
  const ids = z.registry<{ id?: string }>();
  const defs = kernelDefs(registry);
  for (const [id, schema] of Object.entries(defs)) ids.add(schema as z.ZodType, { id });
  const files = new Map<string, unknown>();
  const index: SchemaIndexEntry[] = [];
  const emit = (cls: string, code: string, version: SchemaVersion, schema: z.ZodType) => {
    const file = `${cls}/${code}@${majorOf(version)}.json`;
    files.set(file, toJson(schema, ids));
    index.push({ class: cls, code, version, file });
  };

  const kernelMajor = majorOf(registry.kernelVersion as SchemaVersion);
  const all = toJson(z.strictObject(defs), ids);
  files.set(`kernel@${kernelMajor}.json`, {
    $schema: all["$schema"],
    title: `OpenConditions kernel ${registry.kernelVersion}`,
    $defs: all["$defs"],
  });
  index.push({
    class: "kernel",
    code: "kernel",
    version: registry.kernelVersion as SchemaVersion,
    file: `kernel@${kernelMajor}.json`,
  });

  for (const kind of registry.kinds()) {
    if (kind.class === "component") continue;
    emit(
      kind.class,
      kind.code,
      kind.version,
      registry.recordSchema(kind.class, kind.code, "stored")!,
    );
  }
  for (const p of registry.properties()) {
    emit("observation", p.code, p.version, registry.recordSchema("observation", p.code, "stored")!);
  }
  for (const e of registry.effects())
    emit("effect", e.code, e.version, registry.effectSchema(e.code)!);
  for (const s of registry.selectors())
    emit("selector", s.code, s.version, s.schema(registry.kernel));
  for (const r of registry.resultSchemas()) {
    emit(
      "result",
      r.code,
      r.version,
      z.strictObject({ v: z.literal(majorOf(r.version)), ...r.shape(registry.kernel) }),
    );
  }
  index.sort((a, b) => a.file.localeCompare(b.file));
  files.set("index.json", index);
  return files;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function column(name: string): string {
  if (!IDENTIFIER.test(name)) throw new TypeError(`"${name}" is not a plain column name`);
  return `"${name}"`;
}

/** `CHECK` body for a text column holding one registry value, e.g. for drizzle `check(name, sql.raw(...))`. */
export function enumCheckSql(columnName: string, values: readonly string[]): string {
  if (values.length === 0) return "false";
  return `${column(columnName)} IN (${values.map(literal).join(", ")})`;
}

/** `CHECK` body for a text[] column whose elements are registry values. */
export function enumArrayCheckSql(columnName: string, values: readonly string[]): string {
  return `${column(columnName)} <@ ARRAY[${values.map(literal).join(", ")}]::text[]`;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** The generated "Registry" section of docs/model.md. */
export function registryMarkdown(registry: Registry): string {
  const out: string[] = [];
  out.push(
    `Kernel version \`${registry.kernelVersion}\`; modules: ${registry.modules.map((m) => `\`${m}\``).join(", ")}.`,
    "",
  );
  const domains = registry.domains();
  out.push("### Domains", "");
  if (domains.length === 0) out.push("None registered yet (domain packages contribute them).", "");
  else {
    out.push("| domain | description |", "|---|---|");
    for (const d of domains) out.push(`| \`${d.code}\` | ${cell(d.description)} |`);
    out.push("");
  }
  out.push("### Vocabularies", "", "| vocabulary | extensible | values |", "|---|---|---|");
  for (const v of [...registry.vocabularies()].sort((a, b) => a.code.localeCompare(b.code))) {
    const values = v.values.length === 0 ? "—" : v.values.map((x) => `\`${cell(x)}\``).join(", ");
    out.push(`| \`${v.code}\` | ${v.extensible ? "yes" : "no"} | ${values} |`);
  }
  out.push("");
  for (const cls of ["situation", "feature", "component", "offer"] as const) {
    const kinds = registry.kinds(cls);
    if (kinds.length === 0) continue;
    out.push(
      `### ${cls[0]!.toUpperCase()}${cls.slice(1)} kinds`,
      "",
      "| kind | domain | version | types |",
      "|---|---|---|---|",
    );
    for (const k of kinds) {
      const types = Object.entries(k.types ?? {})
        .map(([t, subs]) => (subs.length > 0 ? `\`${t}\` (${subs.join(", ")})` : `\`${t}\``))
        .join("; ");
      out.push(`| \`${k.code}\` | ${k.domain ?? "—"} | ${k.version} | ${types || "—"} |`);
    }
    out.push("");
  }
  const props = registry.properties();
  if (props.length > 0) {
    out.push(
      "### Properties",
      "",
      "| property | domain | version | result | subjects |",
      "|---|---|---|---|---|",
    );
    for (const p of props) {
      const r = p.result;
      const result =
        r.type === "quantity" || r.type === "vector"
          ? `${r.type} (${r.unit})`
          : r.type === "category"
            ? `category (${r.vocabulary})`
            : r.type === "structured"
              ? `structured (${r.schema})`
              : r.type;
      out.push(
        `| \`${p.code}\` | ${p.domain} | ${p.version} | ${result} | ${p.subjects.map((s) => s.kind).join(", ")} |`,
      );
    }
    out.push("");
  }
  out.push("### Effects", "", "| effect | version | description |", "|---|---|---|");
  for (const e of registry.effects())
    out.push(`| \`${e.code}\` | ${e.version} | ${cell(e.description)} |`);
  out.push(
    "",
    "### Situation selectors",
    "",
    "| selector | version | description |",
    "|---|---|---|",
  );
  for (const s of registry.selectors())
    out.push(`| \`${s.code}\` | ${s.version} | ${cell(s.description)} |`);
  const results = registry.resultSchemas();
  if (results.length > 0) {
    out.push(
      "",
      "### Structured result schemas",
      "",
      "| schema | version | description |",
      "|---|---|---|",
    );
    for (const r of results) out.push(`| \`${r.code}\` | ${r.version} | ${cell(r.description)} |`);
  }
  return `${out.join("\n").trimEnd()}\n`;
}
