import {
  decodeLayout,
  emptyParseOutput,
  type FeedPayloads,
  type FieldRef,
  fieldId,
  type LayoutRow,
  lookupField as lookup,
  type ParseContext,
  type ParseOutput,
  type RecordSkipReason,
  readField as read,
  recordSkipped,
  scalarText,
  fieldText as text,
} from "@openconditions/ingest-framework";
import { zonedWallClockToInstant } from "@openconditions/model";
import type { ParkingStatus } from "@openconditions/model-parking";
import type { ParkingCatalogFeed, ParkingMapping } from "../feed-schema.js";
import {
  type AreaInput,
  instantIn,
  occupancyDrafts,
  type ParkingTrend,
  type ReadingInput,
  rateDraft,
  type SiteInput,
  siteDraft,
  statusDraft,
  trendDraft,
  utcInstant,
} from "../site.js";

/** The generic layouts a parking feed may be written in. */
export const PARKING_LAYOUT_FORMATS = ["geojson", "json", "csv"] as const;

export type ParkingLayoutFormat = (typeof PARKING_LAYOUT_FORMATS)[number];

/** A number from a number or numeric text; a decimal comma is read as a point. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const t = scalarText(value);
  if (t === undefined || !/^-?\d+(?:[.,]\d+)?$/.test(t)) return undefined;
  return Number(t.replace(",", "."));
}

/** A count: a whole number; whether it is a possible one is the drafts' call. */
function countOf(fields: Record<string, unknown>, ref: FieldRef | undefined): number | undefined {
  if (ref === undefined) return undefined;
  const n = numberOf(read(fields, ref));
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

const holds = (
  fields: Record<string, unknown>,
  rule: { field: FieldRef; equals: string | number | boolean },
) => text(fields, rule.field) === String(rule.equals);

function kept(fields: Record<string, unknown>, mapping: ParkingMapping): boolean {
  return (mapping.filter ?? []).every((f) => {
    const value = text(fields, f.field);
    const among = (list: readonly (string | number)[]) =>
      value !== undefined && list.some((v) => String(v) === value);
    if (f.include !== undefined && !among(f.include)) return false;
    return !(f.exclude !== undefined && among(f.exclude));
  });
}

const D_M_Y_H_M = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** An ISO 8601 date and time, with or without an offset; nothing else is read as one. */
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
const pad = (n: string) => n.padStart(2, "0");

/**
 * When the record's counts were measured, as a UTC instant: an ISO time with
 * an offset as given, one without in the mapping's zone, a `d.m.y h:m` time
 * in the mapping's zone. Undefined when the time is missing or unreadable;
 * a text that is not ISO is never handed to the server's own date parsing.
 */
function measuredAt(
  fields: Record<string, unknown>,
  rule: NonNullable<ParkingMapping["updated"]>,
): string | undefined {
  const value = text(fields, rule.field);
  if (value === undefined) return undefined;
  if (rule.format !== "d.m.y h:m") {
    return ISO.test(value) ? instantIn(rule.timezone, value) : undefined;
  }
  const m = value.match(D_M_Y_H_M);
  if (!m) return undefined;
  const wallClock = `${m[3]}-${pad(m[2]!)}-${pad(m[1]!)}T${pad(m[4]!)}:${m[5]}:${m[6] ?? "00"}`;
  const at = zonedWallClockToInstant(rule.timezone, wallClock);
  return at === null ? undefined : utcInstant(at);
}

function areasOf(fields: Record<string, unknown>, mapping: ParkingMapping): AreaInput[] {
  const out: AreaInput[] = [];
  for (const area of mapping.areas ?? []) {
    const capacity = countOf(fields, area.capacity);
    const present =
      area.presentWhen !== undefined
        ? holds(fields, area.presentWhen)
        : capacity !== undefined && capacity > 0;
    if (!present) continue;
    out.push({
      vehicleType: area.vehicleType,
      userGroup: area.userGroup,
      ...(capacity !== undefined && capacity >= 0 ? { capacity } : {}),
    });
  }
  return out;
}

/** A height or width limit in metres; zero or less (a `-999` sentinel) is none. */
function limitOf(
  fields: Record<string, unknown>,
  limit: ParkingMapping["heightLimit"],
): number | undefined {
  if (limit === undefined) return undefined;
  const n = numberOf(read(fields, limit.field));
  if (n === undefined || n <= 0) return undefined;
  return limit.unit === "cm" ? n / 100 : n;
}

/** Called for each enumerated value a record holds that its mapping does not name. */
type OnUnknown = () => void;

function siteInput(
  row: LayoutRow & { point: [number, number] },
  stationId: string,
  mapping: ParkingMapping,
  unknown: OnUnknown,
): SiteInput {
  const f = row.fields;
  const name = (mapping.name ?? []).map((ref) => text(f, ref)).find((n) => n !== undefined);
  const hours = mapping.openingHours && text(f, mapping.openingHours.field);
  const address = mapping.address && {
    street: text(f, mapping.address.street),
    houseNumber: text(f, mapping.address.houseNumber),
    postalCode: text(f, mapping.address.postalCode),
    city: text(f, mapping.address.city),
    text: text(f, mapping.address.text),
  };
  const optional = <K extends keyof SiteInput>(key: K, value: SiteInput[K] | undefined) =>
    value === undefined ? {} : { [key]: value };
  return {
    stationId,
    point: row.point,
    ...optional("name", name),
    ...optional("lang", mapping.lang),
    ...optional(
      "type",
      lookup(f, mapping.type, mapping.defaultType === undefined ? unknown : undefined) ??
        mapping.defaultType,
    ),
    ...optional(
      "layout",
      lookup(f, mapping.layout, mapping.defaultLayout === undefined ? unknown : undefined) ??
        mapping.defaultLayout,
    ),
    ...optional("operator", text(f, mapping.operator)),
    ...optional("website", text(f, mapping.website)),
    ...optional("address", address),
    ...(hours === undefined
      ? {}
      : mapping.openingHours?.syntax === "osm"
        ? { openingHoursOsm: hours }
        : { openingHoursText: hours }),
    ...(mapping.free !== undefined && holds(f, mapping.free) ? { free: true } : {}),
    ...optional("capacityTotal", countOf(f, mapping.capacity)),
    ...optional("heightLimitM", limitOf(f, mapping.heightLimit)),
    ...optional("widthLimitM", limitOf(f, mapping.widthLimit)),
    ...optional("levels", countOf(f, mapping.levels)),
    ...optional("areas", mapping.areas && areasOf(f, mapping)),
    ...optional("tariffText", text(f, mapping.tariffText)),
    ...optional("notes", text(f, mapping.notes)),
  };
}

/** The status of the first rule whose value maps; a value no rule maps counts as unknown. */
function statusOf(
  fields: Record<string, unknown>,
  mapping: ParkingMapping,
  unknown: OnUnknown,
): ParkingStatus | undefined {
  if (mapping.status === undefined) return undefined;
  const rules = Array.isArray(mapping.status) ? mapping.status : [mapping.status];
  let unmapped = false;
  for (const rule of rules) {
    const status = lookup(fields, rule, () => {
      unmapped = true;
    });
    if (status !== undefined) return status;
  }
  if (unmapped) unknown();
  return undefined;
}

/**
 * A feed in a generic layout (`geojson`, `json`, `csv`): its `layout` block
 * cuts the payload into records, its `parking` mapping makes each record a
 * site, its live counts and status, and its rate. A record without a point
 * is skipped as malformed when its position cannot be read, else as having no
 * geometry; a placed record without an id, or an item that is no object, as
 * malformed. A value a map does not name, and no default stands in for,
 * counts as unknown.
 */
export function parseLayout(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const bodies = payloads["main"] ?? [];
  if (bodies.length === 0) return out;
  const mapping = feed.parking;
  if (mapping === undefined) throw new Error(`feed ${feed.id} has no parking mapping`);
  const kind = feed.format as (typeof PARKING_LAYOUT_FORMATS)[number];
  const skip = (reason: RecordSkipReason) => recordSkipped(feed.id, reason);
  const unknown = () => recordSkipped(feed.id, "unknown_value");
  for (const body of bodies) {
    for (const row of decodeLayout(kind, body, feed.layout ?? {}, skip)) {
      if (!kept(row.fields, mapping)) continue;
      if (row.point === undefined) {
        skip(row.unplaced ?? "no_geometry");
        continue;
      }
      const stationId = fieldId(row.fields, mapping.id);
      if (stationId === undefined) {
        skip("malformed");
        continue;
      }
      const placed = { ...row, point: row.point };
      const input = siteInput(placed, stationId, mapping, unknown);
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));

      if (mapping.rates !== undefined) {
        const rows = mapping.rates.rows.flatMap((r) => {
          const amount = numberOf(read(row.fields, r.field));
          return amount === undefined
            ? []
            : [
                {
                  amount,
                  ...(r.maxDuration === undefined ? {} : { maxDuration: r.maxDuration }),
                  ...(r.userGroups === undefined ? {} : { userGroups: r.userGroups }),
                },
              ];
        });
        const rate = rateDraft(feed, stationId, 1, {
          currency: mapping.rates.currency,
          rows,
          point: placed.point,
          fetchedAt: ctx.fetchedAt,
          ...(mapping.lang === undefined ? {} : { lang: mapping.lang }),
        });
        if (rate !== undefined) out.offers.push(rate);
      }

      if (mapping.liveWhen !== undefined && !holds(row.fields, mapping.liveWhen)) continue;
      // A feed that dates its counts gives no reading the record cannot date.
      const at =
        mapping.updated === undefined ? ctx.fetchedAt : measuredAt(row.fields, mapping.updated);
      if (at === undefined) continue;
      const reading: ReadingInput = { stationId, at, point: placed.point };
      out.observations.push(
        ...occupancyDrafts(
          feed,
          reading,
          {
            available: countOf(row.fields, mapping.available),
            occupied: countOf(row.fields, mapping.occupied),
            capacity: input.capacityTotal,
          },
          ctx,
        ),
      );
      const status = statusOf(row.fields, mapping, unknown);
      if (status !== undefined) {
        const draft = statusDraft(feed, { ...reading, status }, ctx);
        if (draft) out.observations.push(draft);
      }
      const trend: ParkingTrend | undefined = lookup(row.fields, mapping.trend, unknown);
      if (trend !== undefined) {
        const draft = trendDraft(feed, { ...reading, trend }, ctx);
        if (draft) out.observations.push(draft);
      }
    }
  }
  return out;
}
