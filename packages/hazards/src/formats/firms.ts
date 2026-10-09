import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { freshness, pointLocation, provenance, utcInstant, withObservationId } from "../records.js";

/** A detection stays current for the longest age range a map offers, three days. */
const DETECTION_WINDOW_MS = 72 * 3_600_000;

type Instrument = "viirs" | "modis";

/** The columns every row needs, whichever instrument wrote the file. */
const REQUIRED = [
  "latitude",
  "longitude",
  "acq_date",
  "acq_time",
  "satellite",
  "confidence",
  "frp",
];

interface Header {
  instrument: Instrument;
  index: ReadonlyMap<string, number>;
}

/**
 * The instrument family a file's header names: VIIRS writes its channel I4
 * brightness as `bright_ti4` and the background as `bright_ti5`, MODIS
 * writes `brightness` and `bright_t31`. A header without the columns every
 * row needs is not a FIRMS active-fire file, which fails the parse.
 */
function readHeader(line: string): Header {
  const index = new Map(line.split(",").map((name, i) => [name.trim(), i] as const));
  const missing = REQUIRED.filter((name) => !index.has(name));
  const instrument = index.has("bright_ti4")
    ? "viirs"
    : index.has("brightness")
      ? "modis"
      : undefined;
  if (missing.length > 0 || instrument === undefined) {
    throw new Error(
      `FIRMS answered no active-fire file: its header lacks ${[...missing, ...(instrument === undefined ? ["bright_ti4|brightness"] : [])].join(", ")}`,
    );
  }
  return { instrument, index };
}

const number = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** `acq_date` and the zero-padded or bare `HHMM` of `acq_time` as a UTC instant, or undefined when either is no time. */
function acquiredAt(date: string, time: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,4}$/.test(time)) return undefined;
  const hhmm = time.padStart(4, "0");
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2));
  if (hours > 23 || minutes > 59) return undefined;
  const at = new Date(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
  // A date that rolls over (February 30th) parses to another day.
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== date ? undefined : at;
}

const VIIRS_CONFIDENCE = new Set(["low", "nominal", "high", "l", "n", "h"]);

/** The quality a row's confidence gives: VIIRS words as the supplier's code, MODIS percentages as a fraction. */
function qualityOf(instrument: Instrument, raw: string): Record<string, unknown> | undefined {
  const value = raw.trim().toLowerCase();
  if (instrument === "viirs") {
    return VIIRS_CONFIDENCE.has(value) ? { supplierCode: value } : undefined;
  }
  const percent = number(value);
  return percent !== undefined && percent >= 0 && percent <= 100
    ? { confidence: percent / 100 }
    : undefined;
}

function readRow(
  cells: readonly string[],
  header: Header,
  feed: HazardsCatalogFeed,
  fetchedAt: string,
): RecordDraft | undefined {
  const cell = (name: string): string => cells[header.index.get(name) ?? -1]?.trim() ?? "";
  const latitude = number(cell("latitude"));
  const longitude = number(cell("longitude"));
  if (
    latitude === undefined ||
    longitude === undefined ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return undefined;
  }
  const at = acquiredAt(cell("acq_date"), cell("acq_time"));
  const frp = number(cell("frp"));
  const satellite = cell("satellite");
  if (at === undefined || frp === undefined || frp < 0 || satellite === "") return undefined;

  const { instrument } = header;
  const brightness = number(cell(instrument === "viirs" ? "bright_ti4" : "brightness"));
  const background = number(cell(instrument === "viirs" ? "bright_ti5" : "bright_t31"));
  const scan = number(cell("scan"));
  const track = number(cell("track"));
  const daynight = { D: "day", N: "night" }[cell("daynight")];
  const version = cell("version");
  const quality = qualityOf(instrument, cell("confidence"));
  const instant = utcInstant(at);
  const draft = {
    class: "observation",
    kind: "observation",
    property: "fire.frp",
    temporality: "live",
    location: pointLocation(
      [longitude, latitude],
      instrument === "viirs" ? "medium_res" : "low_res",
    ),
    provenance: provenance(
      feed,
      `${satellite}:${latitude},${longitude}:${cell("acq_date")}T${cell("acq_time").padStart(4, "0")}`,
    ),
    freshness: freshness(fetchedAt, utcInstant(new Date(at.getTime() + DETECTION_WINDOW_MS))),
    subject: { kind: "location" },
    result: { type: "quantity", value: frp, unit: "MW" },
    phenomenonTime: { instant },
    aggregation: "instantaneous",
    ...(quality === undefined ? {} : { quality }),
    extras: {
      instrument,
      satellite,
      ...(brightness === undefined ? {} : { brightnessK: brightness }),
      ...(background === undefined ? {} : { backgroundK: background }),
      ...(daynight === undefined ? {} : { daynight }),
      ...(scan === undefined ? {} : { scan }),
      ...(track === undefined ? {} : { track }),
      ...(version === "" ? {} : { version }),
    },
  };
  return withObservationId(feed, draft);
}

/**
 * The `firms` format: NASA FIRMS's keyless active-fire files, one `fire.frp`
 * reading per detected pixel, located at the pixel centre. Each file of the
 * `main` role is one satellite's last 24 hours; a pixel the next hourly file
 * restates has the same id and is written once. A row with a bad position,
 * time or radiated power is rejected and counted, never the file. A file
 * with only its header holds no detection; the pipeline refuses such a poll
 * for a global feed, which keeps the last publication. A body that is no
 * active-fire file (an error page) fails the parse.
 */
export function parseFirms(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  let rejected = 0;
  for (const body of payloads["main"] ?? []) {
    const lines = body.toString("utf8").split(/\r?\n/);
    const header = readHeader(lines[0] ?? "");
    for (const line of lines.slice(1)) {
      if (line.trim() === "") continue;
      const draft = readRow(line.split(","), header, feed, ctx.fetchedAt);
      if (draft === undefined) {
        rejected++;
      } else if (!seen.has(String(draft["id"]))) {
        seen.add(String(draft["id"]));
        out.observations.push(draft);
      }
    }
  }
  if (rejected > 0) out.rejected = rejected;
  return out;
}
