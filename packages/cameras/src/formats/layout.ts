import {
  decodeLayout,
  emptyParseOutput,
  type FeedPayloads,
  type FieldRef,
  fieldId,
  lookupField as lookup,
  type ParseContext,
  type ParseOutput,
  type RecordSkipReason,
  recordSkipped,
  fieldText as text,
} from "@openconditions/ingest-framework";
import {
  type CameraStatus,
  type CameraType,
  cameraDraft,
  type DraftContext,
  imageReading,
  type ViewInput,
  viewKey,
} from "../camera.js";
import { type CamerasCatalogFeed, type CamerasMapping, readMapping } from "../feed-schema.js";

/** The generic layouts a camera feed may be written in. */
export const CAMERAS_LAYOUT_FORMATS = ["geojson", "json", "csv"] as const;

export type CamerasLayoutFormat = (typeof CAMERAS_LAYOUT_FORMATS)[number];

/** A finite number a field holds, as a number or as plain numeric text. */
function numberOf(fields: Record<string, unknown>, ref: FieldRef | undefined): number | undefined {
  const t = text(fields, ref);
  if (t === undefined || !/^[+-]?\d+(?:\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

/**
 * The camera id: the `groupBy` field, or the `id` field, or the parts of a
 * composite id joined with `:`.
 */
function cameraIdOf(fields: Record<string, unknown>, mapping: CamerasMapping) {
  const ref = mapping.groupBy ?? mapping.id;
  if (!Array.isArray(ref)) return fieldId(fields, ref);
  const parts = ref.map((part) => fieldId(fields, part));
  return parts.every((p) => p !== undefined) ? parts.join(":") : undefined;
}

/** Called for each enumerated value a record holds that its mapping does not name. */
type OnUnknown = () => void;

/** The camera type; a value the map does not name, with no default, is `other` and counts as unknown. */
function typeOf(
  fields: Record<string, unknown>,
  mapping: CamerasMapping,
  unknown: OnUnknown,
): CameraType {
  const rule = mapping.type;
  if (typeof rule === "string") return rule;
  return (
    lookup(fields, rule, rule.default === undefined ? unknown : undefined) ??
    rule.default ??
    "other"
  );
}

function refreshOf(fields: Record<string, unknown>, mapping: CamerasMapping) {
  const rule = mapping.refreshSec;
  if (rule === undefined || typeof rule === "number") return rule;
  const n = numberOf(fields, rule.field);
  if (n === undefined || n <= 0) return undefined;
  return rule.unit === "min" ? n * 60 : n;
}

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The instant an image-time field names, in UTC; undefined for a time
 * without a zone, which names no instant.
 */
function imageAtOf(fields: Record<string, unknown>, mapping: CamerasMapping) {
  const rule = mapping.imageAt;
  if (rule === undefined) return undefined;
  if (rule.format === "iso") {
    const t = text(fields, rule.field);
    if (t === undefined || !ZONED.test(t)) return undefined;
    const ms = Date.parse(t.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  const n = numberOf(fields, rule.field);
  if (n === undefined) return undefined;
  const ms = rule.format === "epoch-s" ? n * 1000 : n;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const textOf = (value: string | undefined, lang: string) =>
  value === undefined ? undefined : [{ lang, text: value }];

function viewOf(
  key: string,
  fields: Record<string, unknown>,
  mapping: CamerasMapping,
  unknown: OnUnknown,
): ViewInput {
  const compass = lookup(fields, mapping.direction, unknown);
  const bearing = numberOf(fields, mapping.bearing);
  const name = textOf(text(fields, mapping.viewName), mapping.lang);
  return {
    key,
    ...(name === undefined ? {} : { name }),
    ...(bearing === undefined ? {} : { bearingDeg: bearing }),
    ...(compass === undefined || compass === "none"
      ? {}
      : { direction: { value: "unknown" as const, basis: "compass" as const, compass } }),
  };
}

/** A record's fields with every text the publisher writes for a missing value removed. */
function withoutAbsent(value: unknown, absent: ReadonlySet<string>): unknown {
  if (typeof value === "string") return absent.has(value.trim()) ? undefined : value;
  if (Array.isArray(value)) return value.map((v) => withoutAbsent(v, absent));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) => {
      const kept = withoutAbsent(v, absent);
      return kept === undefined ? [] : [[k, kept]];
    }),
  );
}

const FEET = 0.3048;

/** The camera's elevation in metres. */
function elevationOf(fields: Record<string, unknown>, mapping: CamerasMapping) {
  const rule = mapping.elevation;
  const n = rule === undefined ? undefined : numberOf(fields, rule.field);
  if (n === undefined) return undefined;
  return rule?.unit === "ft" ? Math.round(n * FEET * 10) / 10 : n;
}

/** One record of a view: where the record places the camera, and its fields. */
interface ViewRecord {
  point: [number, number];
  pointDerived?: true;
  fields: Record<string, unknown>;
}

/** View keys in a fixed order, numbers by value (`x_2` before `x_10`), whatever the locale. */
const byKey = new Intl.Collator("en", { numeric: true }).compare;

/**
 * A feed in a generic layout (`geojson`, `json`, `csv`): its `layout` block
 * cuts the payloads into records, and its `cameras` mapping makes the
 * records sharing a camera id one camera, each record one of its views with
 * its image reading. Views are in key order, and the camera's place and own
 * fields come from its first view's record, so a publisher reordering its
 * rows changes nothing. A record without a point is skipped as malformed
 * when its position cannot be read, else as having no geometry; a placed
 * record without an id, an item that is no object and a second record of a
 * view a camera already has, as malformed. A value a map does not name
 * counts as unknown; a text the mapping lists as `absent` is no value at
 * all. The payloads of several URLs or pages are read as one
 * list.
 */
export function parseLayout(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const bodies = payloads["main"] ?? [];
  if (bodies.length === 0) return out;
  const read = feed.cameras === undefined ? undefined : readMapping(feed.cameras);
  if (read?.mapping === undefined) {
    throw new Error(`feed ${feed.id}: ${read?.issues.join("; ") ?? "no cameras mapping"}`);
  }
  const { mapping } = read;
  const kind = feed.format as CamerasLayoutFormat;
  const cameras = new Map<string, Map<string, ViewRecord>>();
  const skip = (reason: RecordSkipReason) => recordSkipped(feed.id, reason);
  const unknown = () => recordSkipped(feed.id, "unknown_value");
  const absent = new Set(mapping.absent ?? []);
  for (const body of bodies) {
    for (const row of decodeLayout(kind, body, feed.layout ?? {}, skip)) {
      if (row.point === undefined) {
        skip(row.unplaced ?? "no_geometry");
        continue;
      }
      const fields =
        absent.size === 0
          ? row.fields
          : (withoutAbsent(row.fields, absent) as Record<string, unknown>);
      const cameraId = cameraIdOf(fields, mapping);
      if (cameraId === undefined) {
        skip("malformed");
        continue;
      }
      // Keys are compared as the components will carry them.
      const key = viewKey(text(fields, mapping.viewKey) ?? "0");
      const views = cameras.get(cameraId) ?? new Map<string, ViewRecord>();
      cameras.set(cameraId, views);
      if (views.has(key)) skip("malformed");
      else
        views.set(key, {
          point: row.point,
          ...(row.pointDerived ? { pointDerived: true as const } : {}),
          fields,
        });
    }
  }
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const [cameraId, byView] of cameras) {
    const views = [...byView].sort(([a], [b]) => byKey(a, b));
    const [firstView] = views;
    if (firstView === undefined) continue;
    const { point, pointDerived, fields: first } = firstView[1];
    const roadRef = text(first, mapping.road);
    const milepost = numberOf(first, mapping.milepost);
    const road = {
      ...(roadRef === undefined ? {} : { ref: roadRef }),
      ...(milepost === undefined ? {} : { milepostFrom: milepost }),
    };
    const elevationM = elevationOf(first, mapping);
    const description = textOf(text(first, mapping.description), mapping.lang);
    const detailUrl = text(first, mapping.detailUrl);
    const refreshSec = refreshOf(first, mapping);
    out.features.push(
      cameraDraft(feed, dc, {
        cameraId,
        point,
        ...(pointDerived ? { geometryOrigin: "derived" as const } : {}),
        names: textOf(text(first, mapping.name), mapping.lang) ?? [],
        type: typeOf(first, mapping, unknown),
        ...(description === undefined ? {} : { description }),
        ...(Object.keys(road).length === 0 ? {} : { road }),
        ...(elevationM === undefined ? {} : { elevationM }),
        ...(detailUrl === undefined ? {} : { detailUrl }),
        ...(refreshSec === undefined ? {} : { refreshSec }),
        imageRedistribution: mapping.imageRedistribution,
        views: views.map(([key, { fields }]) => viewOf(key, fields, mapping, unknown)),
      }),
    );
    for (const [key, { fields }] of views) {
      const status: CameraStatus = lookup(fields, mapping.status, unknown) ?? "unknown";
      const streamUrl = text(fields, mapping.streamUrl);
      out.observations.push(
        imageReading(feed, dc, {
          cameraId,
          viewKey: key,
          status,
          point,
          ...optionalText("imageUrl", text(fields, mapping.imageUrl)),
          ...optionalText("thumbnailUrl", text(fields, mapping.thumbnailUrl)),
          ...optionalText("streamUrl", streamUrl),
          ...(streamUrl === undefined || mapping.streamType === undefined
            ? {}
            : { streamType: mapping.streamType }),
          ...optionalText("imageAt", imageAtOf(fields, mapping)),
        }),
      );
    }
  }
  return out;
}

const optionalText = <K extends string>(key: K, value: string | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;
