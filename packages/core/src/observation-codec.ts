import {
  canonicalIdOf,
  contentHash,
  observationId,
  type PropertyEntry,
  parseRecordId,
  qualifierKey,
  type Registry,
  subjectKey,
} from "@openconditions/model";

type Rec = Record<string, unknown>;

/** What identifies a series: one subject, property, qualifier set and source. */
export interface SeriesKey {
  subjectKey: string;
  property: string;
  qualifierKey: string;
  sourceId: string;
}

export function seriesKeyOf(record: Rec): SeriesKey {
  return {
    subjectKey: subjectKey(record as Parameters<typeof subjectKey>[0]),
    property: record["property"] as string,
    qualifierKey: qualifierKey(record["qualifiers"] as Rec | undefined),
    sourceId: (record["provenance"] as Rec)["sourceId"] as string,
  };
}

/** Provenance fields that vary between readings of one series, kept per history row. */
const VARYING_PROVENANCE = ["rawRef", "sourceUpdatedAt", "recordVersion"] as const;

/**
 * The parts of an observation every reading of its series shares: what it
 * is about and who published it. A history row stores none of them.
 */
export function templateOf(record: Rec): Rec {
  const provenance = { ...(record["provenance"] as Rec) };
  for (const key of VARYING_PROVENANCE) delete provenance[key];
  return {
    namespace: parseRecordId(record["id"] as string)?.namespace,
    class: record["class"],
    kind: record["kind"],
    property: record["property"],
    domain: record["domain"],
    subject: record["subject"],
    ...(record["qualifiers"] !== undefined ? { qualifiers: record["qualifiers"] } : {}),
    location: record["location"],
    provenance,
  };
}

/** Result types whose value has a column of its own when the property declares that type. */
const COLUMN_TYPES = new Set(["quantity", "count", "boolean", "category", "money"]);

interface ResultColumns {
  value_num: number | null;
  value_money: string | null;
  value_text: string | null;
  value_json: Rec | null;
}

/**
 * A result as history columns. A result of the property's own type keeps its
 * value in a column and leaves out what the registry implies (the unit, the
 * vocabulary); anything else it carries goes to `value_json`. A result of
 * another type (`unknown`, `not_applicable`) is stored whole in `value_json`.
 */
export function encodeResult(result: Rec, spec: PropertyEntry["result"]): ResultColumns {
  const out: ResultColumns = {
    value_num: null,
    value_money: null,
    value_text: null,
    value_json: null,
  };
  const type = result["type"] as string;
  if (type !== spec.type || !COLUMN_TYPES.has(type)) {
    out.value_json = result;
    return out;
  }
  const { type: _type, ...rest } = result;
  const residue: Rec = { ...rest };
  switch (type) {
    case "quantity":
      out.value_num = result["value"] as number;
      delete residue["value"];
      if (residue["unit"] === (spec as { unit: string }).unit) delete residue["unit"];
      break;
    case "count":
      out.value_num = result["value"] as number;
      delete residue["value"];
      break;
    case "boolean":
      out.value_text = String(result["value"]);
      delete residue["value"];
      break;
    case "category":
      out.value_text = result["value"] as string;
      delete residue["value"];
      if (residue["vocabulary"] === (spec as { vocabulary: string }).vocabulary) {
        delete residue["vocabulary"];
      }
      break;
    case "money":
      out.value_money = result["amount"] as string;
      delete residue["amount"];
      break;
  }
  out.value_json = Object.keys(residue).length > 0 ? residue : null;
  return out;
}

/** The inverse of {@link encodeResult}. */
export function decodeResult(columns: ResultColumns, spec: PropertyEntry["result"]): Rec {
  const json = columns.value_json ?? {};
  if (typeof json["type"] === "string") return json;
  switch (spec.type) {
    case "quantity":
      return { type: "quantity", value: columns.value_num, unit: spec.unit, ...json };
    case "count":
      return { type: "count", value: columns.value_num, ...json };
    case "boolean":
      return { type: "boolean", value: columns.value_text === "true", ...json };
    case "category":
      return { type: "category", value: columns.value_text, vocabulary: spec.vocabulary, ...json };
    case "money":
      return { type: "money", amount: columns.value_money, ...json };
    default:
      throw new TypeError(`a ${spec.type} result is always stored whole`);
  }
}

const NEG_INFINITY = "-infinity";

/**
 * A stored observation as a compact history row: the reading's times,
 * statistic, value and quality, the poll it came from, and in `extra` the
 * few things a reading may carry that neither its series nor these columns
 * hold. `rawPart` is the position of its payload in its poll's payload
 * hashes, when it names one.
 */
export function historyRowOf(
  record: Rec,
  spec: PropertyEntry["result"],
  poll: { fetchId?: number; payloadHashes?: readonly string[] },
): Rec {
  const time = record["phenomenonTime"] as { instant?: string; start?: string; end?: string };
  const forecast = record["forecast"] as Rec | undefined;
  const provenance = record["provenance"] as Rec;
  const rawRef = provenance["rawRef"] as
    | { hash: string; part?: string; pointer?: string }
    | undefined;
  const rawPart = rawRef ? (poll.payloadHashes?.indexOf(rawRef.hash) ?? -1) : -1;
  const extraProvenance: Rec = {};
  if (
    rawRef !== undefined &&
    (rawPart < 0 || rawRef.part !== undefined || rawRef.pointer !== undefined)
  ) {
    extraProvenance["rawRef"] = rawRef;
  }
  for (const key of ["sourceUpdatedAt", "recordVersion"] as const) {
    if (provenance[key] !== undefined) extraProvenance[key] = provenance[key];
  }
  const { fetchedAt, ...freshness } = record["freshness"] as Rec;
  const extra: Rec = {
    ...(forecast ? { forecast } : {}),
    ...(Object.keys(extraProvenance).length > 0 ? { provenance: extraProvenance } : {}),
    ...(Object.keys(freshness).length > 0 ? { freshness } : {}),
  };
  for (const key of ["externalIds", "relations", "extras"] as const) {
    if (record[key] !== undefined) extra[key] = record[key];
  }
  return {
    phenomenon_start: time.instant ?? time.start,
    phenomenon_end: time.end ?? null,
    issued_at: (forecast?.["issuedAt"] as string | undefined) ?? NEG_INFINITY,
    result_time: record["resultTime"] ?? null,
    valid_until: record["validUntil"] ?? null,
    fetched_at: fetchedAt,
    recorded_at: record["recordedAt"],
    temporality: record["temporality"],
    aggregation: record["aggregation"],
    ...encodeResult(record["result"] as Rec, spec),
    quality: record["quality"] ?? null,
    baseline: record["baseline"] ?? null,
    fetch_id: rawPart >= 0 ? (poll.fetchId ?? null) : null,
    raw_part: rawPart >= 0 && poll.fetchId !== undefined ? rawPart : null,
    extra: Object.keys(extra).length > 0 ? extra : null,
  };
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string));

/**
 * Rebuilds the stored observation a history row was written from, given its
 * series template and, when the row names one, its poll's payload hashes.
 * The id, canonical id and content hash are derived again. Instants read back
 * in UTC with milliseconds: a source's spelling of an instant is not kept
 * (the id already treats two spellings as one point), so the content hash is
 * that of the record as read back. The template is the series' current one.
 */
export function recordFromHistory(
  registry: Registry,
  series: Rec,
  row: Rec,
  payloadHashes: readonly string[] = [],
): Rec {
  const { namespace, ...template } = series;
  const property = registry.property(template["property"] as string);
  if (property === undefined) {
    throw new TypeError(`unregistered property ${String(template["property"])}`);
  }
  const extra = (row["extra"] as Rec | null) ?? {};
  const start = iso(row["phenomenon_start"]);
  const end = row["phenomenon_end"] == null ? undefined : iso(row["phenomenon_end"]);
  const recordedAt = iso(row["recorded_at"]);
  const provenance: Rec = {
    ...(template["provenance"] as Rec),
    ...((extra["provenance"] as Rec) ?? {}),
  };
  if (row["raw_part"] != null && provenance["rawRef"] === undefined) {
    provenance["rawRef"] = { hash: payloadHashes[row["raw_part"] as number] };
  }
  const record: Rec = {
    ...template,
    temporality: row["temporality"],
    phenomenonTime: end === undefined ? { instant: start } : { start, end },
    ...(row["result_time"] != null ? { resultTime: iso(row["result_time"]) } : {}),
    ...(row["valid_until"] != null ? { validUntil: iso(row["valid_until"]) } : {}),
    aggregation: row["aggregation"],
    result: decodeResult(row as unknown as ResultColumns, property.result),
    ...(row["quality"] != null ? { quality: row["quality"] } : {}),
    ...(row["baseline"] != null ? { baseline: row["baseline"] } : {}),
    ...(extra["forecast"] !== undefined ? { forecast: extra["forecast"] } : {}),
    ...(extra["externalIds"] !== undefined ? { externalIds: extra["externalIds"] } : {}),
    ...(extra["relations"] !== undefined ? { relations: extra["relations"] } : {}),
    ...(extra["extras"] !== undefined ? { extras: extra["extras"] } : {}),
    provenance,
    freshness: { fetchedAt: iso(row["fetched_at"]), ...((extra["freshness"] as Rec) ?? {}) },
    revision: 1,
    recordedAt,
  };
  const id = observationId(namespace as string, record as Parameters<typeof observationId>[1]);
  record["id"] = id;
  record["canonicalId"] = canonicalIdOf(namespace as string, parseRecordId(id)!.localId);
  record["contentHash"] = contentHash(record);
  return record;
}
