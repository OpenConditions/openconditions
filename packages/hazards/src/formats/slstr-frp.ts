import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  type RecordSkipReason,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { freshness, pointLocation, provenance, utcInstant, withObservationId } from "../records.js";

/** A detection stays current as long as a FIRMS one: the longest age range a map offers, three days. */
const DETECTION_WINDOW_MS = 72 * 3_600_000;

/** The columns every row needs. */
const REQUIRED = ["lat", "lon", "day", "time", "FRP", "satellite"];

/** The product's confidence classes, `confidence_class(lower=0;nominal=1;higher=2)`, in FIRMS's VIIRS words. */
const CONFIDENCE_CLASSES = ["low", "nominal", "high"] as const;

/**
 * A column's name without the unit or legend the product writes after it:
 * `FRP(MW)` is `FRP`, `confidence_class(lower=0;nominal=1;higher=2)` is
 * `confidence_class`.
 */
const columnName = (header: string): string => header.trim().replace(/\(.*\)$/, "");

/**
 * The column index of the product's header row, the first line that is no
 * `#` metadata; undefined for a body that is no SLSTR FRP file.
 */
function readHeader(
  lines: readonly string[],
): { at: number; index: Map<string, number> } | undefined {
  const at = lines.findIndex((line) => line.trim() !== "" && !line.startsWith("#"));
  if (at < 0) return undefined;
  const index = new Map(
    (lines[at] as string).split(",").map((name, i) => [columnName(name), i] as const),
  );
  return REQUIRED.every((name) => index.has(name)) ? { at, index } : undefined;
}

const number = (value: string): number | undefined => {
  if (value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** `day` (`YYYY-MM-DD`) and `time` (`HH:MM:SS`) as a UTC instant, or undefined when either is no time. */
function acquiredAt(day: string, time: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return undefined;
  const at = new Date(`${day}T${time}Z`);
  // A date or time that rolls over (February 30th, 24:00:00) parses to another one.
  return Number.isNaN(at.getTime()) || utcInstant(at) !== `${day}T${time}Z` ? undefined : at;
}

/** The product's class as the supplier's code and its percentage as a fraction; either may be missing. */
function qualityOf(classCell: string, percentCell: string): Record<string, unknown> | undefined {
  const code = /^[012]$/.test(classCell) ? CONFIDENCE_CLASSES[Number(classCell)] : undefined;
  const percent = number(percentCell);
  // The product writes a tenth of a percent, which a plain division blurs (78.3 / 100).
  const fraction =
    percent !== undefined && percent >= 0 && percent <= 100
      ? Number((percent / 100).toFixed(4))
      : undefined;
  if (code === undefined && fraction === undefined) return undefined;
  return {
    ...(code === undefined ? {} : { supplierCode: code }),
    ...(fraction === undefined ? {} : { confidence: fraction }),
  };
}

/**
 * A row's reading, or why it has none: `no_geometry` when it gives no
 * position at all, `malformed` when its position is unreadable or out of
 * range, or its time, radiated power or satellite is.
 */
function readRow(
  cells: readonly string[],
  index: ReadonlyMap<string, number>,
  feed: HazardsCatalogFeed,
  fetchedAt: string,
): RecordDraft | RecordSkipReason {
  const cell = (name: string): string => cells[index.get(name) ?? -1]?.trim() ?? "";
  if (cell("lat") === "" && cell("lon") === "") return "no_geometry";
  const latitude = number(cell("lat"));
  const longitude = number(cell("lon"));
  if (
    latitude === undefined ||
    longitude === undefined ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return "malformed";
  }
  const at = acquiredAt(cell("day"), cell("time"));
  const frp = number(cell("FRP"));
  const satellite = cell("satellite");
  if (at === undefined || frp === undefined || frp < 0 || satellite === "") return "malformed";

  const brightness = number(cell("MWIR_BT"));
  const uncertainty = number(cell("FRPerr"));
  const scan = number(cell("actrack"));
  const track = number(cell("altrack"));
  const daynight = { D: "day", N: "night" }[cell("D/N")];
  const channel = cell("used_channel");
  const quality = qualityOf(cell("confidence_class"), cell("confidence"));
  const draft = {
    class: "observation",
    kind: "observation",
    property: "fire.frp",
    temporality: "live",
    location: pointLocation([longitude, latitude], "low_res"),
    provenance: provenance(
      feed,
      `${satellite}:${cell("lat")},${cell("lon")}:${cell("day")}T${cell("time")}`,
    ),
    freshness: freshness(fetchedAt, utcInstant(new Date(at.getTime() + DETECTION_WINDOW_MS))),
    subject: { kind: "location" },
    result: { type: "quantity", value: frp, unit: "MW" },
    phenomenonTime: { instant: utcInstant(at) },
    aggregation: "instantaneous",
    ...(quality === undefined ? {} : { quality }),
    extras: {
      instrument: "slstr",
      satellite,
      ...(brightness === undefined ? {} : { brightnessK: brightness }),
      ...(daynight === undefined ? {} : { daynight }),
      ...(scan === undefined ? {} : { scan }),
      ...(track === undefined ? {} : { track }),
      ...(uncertainty === undefined || uncertainty < 0 ? {} : { frpUncertaintyMW: uncertainty }),
      ...(channel === "" ? {} : { channel }),
    },
  };
  return withObservationId(feed, draft);
}

/**
 * The `slstr-frp` format: EUMETSAT's near-real-time Sentinel-3 SLSTR fire
 * radiative power, one `fire.frp` reading per detected pixel, located at the
 * pixel centre, like a FIRMS one. Each payload of the `fires` role is one
 * granule's `FRP_MWIR1km_standard.csv` (three minutes of one satellite's
 * swath): `#` metadata lines, then a header row and a row per fire. The
 * `granules` role is the listing the granules were read from and holds no
 * fire. The product's confidence class is the reading's `supplierCode` (low,
 * nominal, high, as FIRMS writes VIIRS's), its percentage the `confidence`;
 * the class decides, and a percentage may be high in the lowest class (a
 * gas flare). A pixel two polls restate has the same id and is written once.
 * A row with no position is skipped as `no_geometry`, one with a bad
 * position, time or radiated power as `malformed`, and so is a granule that
 * holds no FRP file (its fires cannot be told apart, so it counts once),
 * never the poll, unless no granule does.
 */
export function parseSlstrFrp(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  const bodies = payloads["fires"] ?? [];
  let unreadable = 0;
  for (const body of bodies) {
    const lines = body.toString("utf8").split(/\r?\n/);
    const header = readHeader(lines);
    if (header === undefined) {
      unreadable++;
      continue;
    }
    for (const line of lines.slice(header.at + 1)) {
      if (line.trim() === "" || line.startsWith("#")) continue;
      const draft = readRow(line.split(","), header.index, feed, ctx.fetchedAt);
      if (typeof draft === "string") {
        recordSkipped(feed.id, draft);
      } else if (!seen.has(String(draft["id"]))) {
        seen.add(String(draft["id"]));
        out.observations.push(draft);
      }
    }
  }
  if (bodies.length > 0 && unreadable === bodies.length) {
    throw new Error(`none of the ${bodies.length} granules is an SLSTR FRP file`);
  }
  recordSkipped(feed.id, "malformed", unreadable);
  return out;
}
