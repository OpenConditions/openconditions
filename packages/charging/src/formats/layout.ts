import {
  decodeLayout,
  emptyParseOutput,
  type FeedPayloads,
  getPath,
  type LayoutRow,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { chargingCrosswalk } from "@openconditions/model-charging";
import { colocateSites } from "../colocate.js";
import type { ChargingCatalogFeed, ChargingMapping, FieldRef } from "../feed-schema.js";
import {
  type ConnectorInput,
  type EvseInput,
  type ParkingType,
  type PowerType,
  parsePowerKw,
  type SiteInput,
  siteDraft,
} from "../site.js";

/** The generic layouts a charging feed may be written in. */
export const CHARGING_LAYOUT_FORMATS = ["geojson", "json", "csv"] as const;

export type ChargingLayoutFormat = (typeof CHARGING_LAYOUT_FORMATS)[number];

const patterns = new Map<string, RegExp>();

function regex(pattern: string): RegExp {
  let re = patterns.get(pattern);
  if (re === undefined) {
    re = new RegExp(pattern);
    patterns.set(pattern, re);
  }
  return re;
}

/** A string, number or boolean as trimmed text; undefined when empty or not a scalar. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? undefined : text;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * A field's text in a record: the trimmed value at its path, or, with a
 * pattern, the pattern's first capture group (else the whole match) in it.
 */
function text(fields: Record<string, unknown>, ref: FieldRef | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === "string") return scalarText(getPath(fields, ref));
  const value = scalarText(getPath(fields, ref.field));
  if (value === undefined || ref.pattern === undefined) return value;
  const m = value.match(regex(ref.pattern));
  return m === null ? undefined : scalarText(m[1] ?? m[0]);
}

/** A whole number of zero or more; undefined for anything else. */
function countOf(fields: Record<string, unknown>, ref: FieldRef | undefined): number | undefined {
  const t = text(fields, ref);
  if (t === undefined || !/^\d+$/.test(t)) return undefined;
  return Number(t);
}

function lookup<T>(
  fields: Record<string, unknown>,
  rule: { field: FieldRef; map: Record<string, T> } | undefined,
): T | undefined {
  if (rule === undefined) return undefined;
  const key = text(fields, rule.field);
  return key !== undefined && Object.hasOwn(rule.map, key) ? rule.map[key] : undefined;
}

function kept(fields: Record<string, unknown>, mapping: ChargingMapping): boolean {
  return (mapping.filter ?? []).every((f) => {
    const value = text(fields, f.field);
    const among = (list: readonly (string | number)[]) =>
      value !== undefined && list.some((v) => String(v) === value);
    if (f.include !== undefined && !among(f.include)) return false;
    return !(f.exclude !== undefined && among(f.exclude));
  });
}

/** The site id: one field, or the parts of a composite id joined with `,`. */
function stationIdOf(fields: Record<string, unknown>, mapping: ChargingMapping) {
  if (!Array.isArray(mapping.id)) return text(fields, mapping.id);
  const parts = mapping.id.map((ref) => text(fields, ref));
  return parts.every((p) => p !== undefined) ? parts.join(",") : undefined;
}

/** One group of identical charge points a record names, with the connector each has. */
interface Entry {
  count?: number;
  connector: Omit<ConnectorInput, "id">;
}

/** Drops the keys whose value is undefined, so optional fields stay absent. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function rowEntry(
  fields: Record<string, unknown>,
  row: Extract<ChargingMapping["connectors"], { row: unknown }>["row"],
): Entry {
  const code = row.standard && text(fields, row.standard.field);
  const standard =
    code === undefined
      ? undefined
      : row.standard?.map === undefined
        ? chargingCrosswalk.value("connector_standard", "ocpi", code)
        : Object.hasOwn(row.standard.map, code)
          ? row.standard.map[code]
          : undefined;
  const power = row.powerKw;
  const powerText =
    power === undefined
      ? undefined
      : text(fields, power.pattern === undefined ? power.field : power);
  return {
    count: countOf(fields, row.count),
    connector: defined({
      standard: standard ?? "UNKNOWN",
      format: typeof row.format === "string" ? row.format : lookup(fields, row.format),
      current: lookup(fields, row.current),
      powerType: lookup(fields, row.powerType) as PowerType | undefined,
      maxPowerKw: power && parsePowerKw(powerText, power.unit),
    }),
  };
}

function columnEntries(
  fields: Record<string, unknown>,
  columns: Extract<ChargingMapping["connectors"], { columns: unknown }>["columns"],
): [string, Entry][] {
  return columns.flatMap((column): [string, Entry][] => {
    const count = countOf(fields, column.count);
    if (count === undefined || count === 0) return [];
    const key = typeof column.count === "string" ? column.count : column.count.field;
    return [
      [
        key,
        {
          count,
          connector: defined({
            standard: column.standard,
            current: column.current,
            format: column.format,
            maxPowerKw: column.powerKw,
          }),
        },
      ],
    ];
  });
}

type ListMapping = Extract<ChargingMapping["connectors"], { list: unknown }>["list"];

/** The named groups of each part of a list text that matches the list's pattern. */
function listParts(
  fields: Record<string, unknown>,
  list: { field: FieldRef; separator: string; pattern: string },
): Record<string, string | undefined>[] {
  const value = text(fields, list.field);
  if (value === undefined) return [];
  const pattern = regex(list.pattern);
  return value
    .split(regex(list.separator))
    .map((part) => part.trim())
    .flatMap((part) => {
      const m = part === "" ? null : part.match(pattern);
      return m === null ? [] : [m.groups ?? {}];
    });
}

function countIn(groups: Record<string, string | undefined>): number | undefined {
  const count = scalarText(groups["count"]);
  return count !== undefined && /^\d+$/.test(count) ? Number(count) : undefined;
}

function listEntries(fields: Record<string, unknown>, list: ListMapping): Entry[] {
  const current = lookup(fields, list.current);
  return listParts(fields, list).map((groups) => {
    const type = scalarText(groups["type"]);
    const mapped =
      type !== undefined && list.map !== undefined && Object.hasOwn(list.map, type)
        ? list.map[type]
        : undefined;
    return {
      count: countIn(groups),
      connector: defined({
        standard: mapped?.standard ?? "UNKNOWN",
        current: mapped?.current ?? current,
        format: mapped?.format,
        maxPowerKw: parsePowerKw(scalarText(groups["power"])),
      }),
    };
  });
}

/**
 * The charge points of a record whose list names connector types: one per
 * charger group (its count the quantity, its power each connector's), each
 * with every listed connector, or a connector it does not name when the list
 * is empty. Without groups, the listed connectors are one charge point's.
 * Keys are set by the caller.
 */
function chargerGroups(fields: Record<string, unknown>, list: ListMapping): EvseInput[] {
  const plugs = listEntries(fields, list).map((entry) => entry.connector);
  const groups = list.groups === undefined ? [] : listParts(fields, list.groups);
  const numbered = (connectors: Omit<ConnectorInput, "id">[]) =>
    connectors.map((c, i) => ({ id: String(i + 1), ...c }));
  if (groups.length === 0) {
    return plugs.length === 0 ? [] : [{ key: "", connectors: numbered(plugs) }];
  }
  return groups.flatMap((group): EvseInput[] => {
    const count = countIn(group);
    if (count === 0) return [];
    const power = parsePowerKw(scalarText(group["power"]));
    const types = plugs.length === 0 ? [{ standard: "UNKNOWN" }] : plugs;
    return [
      {
        key: "",
        ...(count !== undefined && count > 1 ? { quantity: count } : {}),
        connectors: numbered(
          types.map((c) => defined({ ...c, maxPowerKw: power ?? c.maxPowerKw })),
        ),
      },
    ];
  });
}

/** A charge point group; none for a count of zero, `quantity` for a count above one. */
function evseOf(key: string, entry: Entry): EvseInput | undefined {
  if (entry.count === 0) return undefined;
  return {
    key,
    ...(entry.count !== undefined && entry.count > 1 ? { quantity: entry.count } : {}),
    connectors: [{ id: "1", ...entry.connector }],
  };
}

/** The charge points of one site's records, in the order the records name them. */
function evsesOf(rows: readonly LayoutRow[], mapping: ChargingMapping): EvseInput[] {
  const connectors = mapping.connectors;
  if ("columns" in connectors) {
    return rows.flatMap((row, i) =>
      columnEntries(row.fields, connectors.columns).flatMap(([key, entry]) => {
        const evse = evseOf(rows.length > 1 ? `${i + 1}.${key}` : key, entry);
        return evse === undefined ? [] : [evse];
      }),
    );
  }
  if ("list" in connectors) {
    const list = connectors.list;
    if (list.as === "connectors") {
      return rows
        .flatMap((row) => chargerGroups(row.fields, list))
        .map((evse, i) => ({ ...evse, key: String(i + 1) }));
    }
    const entries = rows.flatMap((row) => listEntries(row.fields, list));
    return entries.flatMap((entry, i) => {
      const evse = evseOf(String(i + 1), entry);
      return evse === undefined ? [] : [evse];
    });
  }
  // One connector per record: records sharing an EVSE key are one charge point;
  // a record without one is its own, keyed apart from every source key.
  const byKey = new Map<string, EvseInput>();
  rows.forEach((row, i) => {
    const entry = rowEntry(row.fields, connectors.row);
    const key = text(row.fields, mapping.evse?.key);
    if (key === undefined) {
      const evse = evseOf(`row-${i + 1}`, entry);
      if (evse !== undefined) byKey.set(`\u0000${i}`, evse);
      return;
    }
    const known = byKey.get(key);
    if (known !== undefined) {
      if (entry.count !== 0) {
        known.connectors.push({ id: String(known.connectors.length + 1), ...entry.connector });
      }
      return;
    }
    const evse = evseOf(key, entry);
    if (evse === undefined) return;
    const evseId = text(row.fields, mapping.evse?.evseId);
    byKey.set(key, evseId === undefined ? evse : { ...evse, evseId });
  });
  return [...byKey.values()];
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const isoDate = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/**
 * The day a completion text names, `YYYY-MM-DD`: `31/07/2023` day first,
 * `30 November 2023`, or `November 2023` as the month's last day. Undefined
 * for any other text or a day the month lacks.
 */
function completionDay(value: string): string | undefined {
  const t = value.trim().toLowerCase();
  const numeric = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const named = t.match(/^(?:(\d{1,2})\s+)?([a-z]+)\s+(\d{4})$/);
  let year: number;
  let month: number;
  let day: number | undefined;
  if (numeric !== null) {
    [day, month, year] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
  } else if (named !== null && MONTHS.includes(named[2]!)) {
    month = MONTHS.indexOf(named[2]!) + 1;
    year = Number(named[3]);
    day = named[1] === undefined ? undefined : Number(named[1]);
  } else return undefined;
  if (month < 1 || month > 12) return undefined;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day !== undefined && (day < 1 || day > last)) return undefined;
  return isoDate(year, month, day ?? last);
}

function siteInput(
  stationId: string,
  point: [number, number],
  rows: readonly [LayoutRow, ...LayoutRow[]],
  mapping: ChargingMapping,
  fetchedAt: string,
): SiteInput {
  const f = rows[0].fields;
  const completion = text(f, mapping.completion);
  const completes = completion === undefined ? undefined : completionDay(completion);
  const unbuilt = completes !== undefined && completes > fetchedAt.slice(0, 10);
  const name = (mapping.name ?? []).map((ref) => text(f, ref)).find((n) => n !== undefined);
  const hours = mapping.openingHours && text(f, mapping.openingHours.field);
  const operator = text(f, mapping.operator);
  const address = mapping.address && {
    street: text(f, mapping.address.street),
    houseNumber: text(f, mapping.address.houseNumber),
    postalCode: text(f, mapping.address.postalCode),
    city: text(f, mapping.address.city),
    text: text(f, mapping.address.text),
  };
  return defined({
    stationId,
    point,
    name,
    lang: mapping.lang,
    operator: operator === undefined ? undefined : { name: operator },
    website: text(f, mapping.website),
    address,
    ...(hours === undefined
      ? {}
      : mapping.openingHours?.syntax === "osm"
        ? { openingHoursOsm: hours }
        : { openingHoursText: hours }),
    audience: lookup(f, mapping.audience),
    lifecycle: unbuilt ? "planned" : lookup(f, mapping.lifecycle),
    parkingType: lookup(f, mapping.parkingType) as ParkingType | undefined,
    tariffText: text(f, mapping.tariffText),
    notes: text(f, mapping.notes),
    evses: evsesOf(rows, mapping),
  });
}

/**
 * A feed in a generic layout (`geojson`, `json`, `csv`): its `layout` block
 * cuts the payloads into records, and its `charging` mapping makes the
 * records sharing an id one site, with the charge points and connectors they
 * name; one operator's sites within 15 m are then one site. A record without
 * an id or a placeable point is rejected. The pages of a paginated feed are
 * read as one list, so a site may span them.
 */
export function parseLayout(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const bodies = payloads["main"] ?? [];
  if (bodies.length === 0) return out;
  const mapping = feed.charging;
  if (mapping === undefined) throw new Error(`feed ${feed.id} has no charging mapping`);
  const kind = feed.format as ChargingLayoutFormat;
  const sites = new Map<string, { point: [number, number]; rows: [LayoutRow, ...LayoutRow[]] }>();
  let rejected = 0;
  for (const body of bodies) {
    for (const row of decodeLayout(kind, body, feed.layout ?? {})) {
      if (!kept(row.fields, mapping)) continue;
      const stationId = stationIdOf(row.fields, mapping);
      if (stationId === undefined || row.point === undefined) {
        rejected++;
        continue;
      }
      const known = sites.get(stationId);
      if (known === undefined) sites.set(stationId, { point: row.point, rows: [row] });
      else known.rows.push(row);
    }
  }
  for (const [stationId, { point, rows }] of sites) {
    const input = siteInput(stationId, point, rows, mapping, ctx.fetchedAt);
    out.features.push(siteDraft(feed, input, ctx.fetchedAt));
  }
  out.rejected = rejected;
  return colocateSites(out);
}
