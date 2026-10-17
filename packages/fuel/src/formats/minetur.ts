import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { zonedWallClockToInstant } from "@openconditions/model";
import type { FuelGrade } from "../grades.js";
import { type Interval, interval, osmOpeningHours } from "../hours.js";
import {
  type FuelFeed,
  type ProductInput,
  priceDraft,
  stationDraft,
  stationPosition,
  utcInstant,
} from "../station.js";

/**
 * The price column of each grade, in the order a station's products are
 * listed. Every column is a grade of its own, so no price is dropped: premium
 * 95 E5, 98 octane E10 and compressed and liquefied biomethane are priced
 * beside the standard grades.
 */
const GRADE_COLUMNS: readonly (readonly [string, FuelGrade])[] = [
  ["Precio Gasolina 95 E5", "e5"],
  ["Precio Gasolina 95 E10", "e10"],
  ["Precio Gasolina 98 E5", "sp98"],
  ["Precio Gasolina 98 E10", "sp98_e10"],
  ["Precio Gasoleo A", "diesel"],
  ["Precio Gasoleo Premium", "diesel_premium"],
  ["Precio Gasoleo B", "agricultural_diesel"],
  ["Precio Diésel Renovable", "hvo100"],
  ["Precio Biodiesel", "b100"],
  ["Precio Bioetanol", "ethanol"],
  ["Precio Gases licuados del petróleo", "lpg"],
  ["Precio Gas Natural Comprimido", "cng"],
  ["Precio Gas Natural Licuado", "lng"],
  ["Precio Hidrogeno", "h2_700"],
  ["Precio Adblue", "adblue"],
  ["Precio Metanol", "methanol"],
  ["Precio Amoniaco", "ammonia"],
  ["Precio Gasolina 95 E25", "e25"],
  ["Precio Gasolina 95 E85", "e85"],
  ["Precio Gasolina Renovable", "renewable_petrol"],
  ["Precio Biogas Natural Comprimido", "cng_bio"],
  ["Precio Biogas Natural Licuado", "lng_bio"],
  ["Precio Gasolina 95 E5 Premium", "e5_premium"],
];

const PRICE_COLUMNS: ReadonlySet<string> = new Set(GRADE_COLUMNS.map(([column]) => column));

/** INE province code (`IDProvincia`) → ISO 3166-2:ES province code. */
const PROVINCES: Readonly<Record<string, string>> = {
  "01": "VI",
  "02": "AB",
  "03": "A",
  "04": "AL",
  "05": "AV",
  "06": "BA",
  "07": "PM",
  "08": "B",
  "09": "BU",
  "10": "CC",
  "11": "CA",
  "12": "CS",
  "13": "CR",
  "14": "CO",
  "15": "C",
  "16": "CU",
  "17": "GI",
  "18": "GR",
  "19": "GU",
  "20": "SS",
  "21": "H",
  "22": "HU",
  "23": "J",
  "24": "LE",
  "25": "L",
  "26": "LO",
  "27": "LU",
  "28": "M",
  "29": "MA",
  "30": "MU",
  "31": "NA",
  "32": "OR",
  "33": "O",
  "34": "P",
  "35": "GC",
  "36": "PO",
  "37": "SA",
  "38": "TF",
  "39": "S",
  "40": "SG",
  "41": "SE",
  "42": "SO",
  "43": "T",
  "44": "TE",
  "45": "TO",
  "46": "V",
  "47": "VA",
  "48": "BI",
  "49": "ZA",
  "50": "Z",
  "51": "CE",
  "52": "ML",
};

type Station = Record<string, unknown>;

/** A decimal-comma string as its decimal-point spelling; undefined when it is not one. */
function decimalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(text) ? text : undefined;
}

/** A decimal-comma coordinate: undefined when empty or absent, NaN when unreadable. */
function coordinate(value: unknown): number | undefined {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return undefined;
  }
  const text = decimalText(value);
  return text === undefined ? Number.NaN : Number(text);
}

const FECHA = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/;

/**
 * `Fecha` (`dd/mm/yyyy H:MM:SS`, Madrid local time) as a UTC instant. The
 * hour has no leading zero before ten in the morning (`0:09:09`).
 */
function publicationTime(fecha: unknown): string {
  const m = typeof fecha === "string" ? fecha.trim().match(FECHA) : null;
  const two = (n: string | undefined) => (n ?? "").padStart(2, "0");
  const at = m
    ? zonedWallClockToInstant(
        "Europe/Madrid",
        `${m[3]}-${two(m[2])}-${two(m[1])}T${two(m[4])}:${m[5]}:${m[6]}`,
      )
    : null;
  if (at === null) throw new Error(`MINETUR: unreadable Fecha ${JSON.stringify(fecha)}`);
  return utcInstant(at);
}

const text = (value: unknown): string | undefined => {
  const t = typeof value === "string" ? value.trim() : undefined;
  return t ? t : undefined;
};

/** The ministry's weekday letters, Monday (`L`, lunes) to Sunday (`D`, domingo). */
const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"] as const;

const HORARIO_RULE = /^([LMXJVSD])(?:-([LMXJVSD]))?:\s*(.+)$/;

/**
 * `Horario` in the OSM grammar: rules of a weekday or a range of them (`L-V`)
 * with `24H` or intervals joined by `y` (`L-V: 08:00-14:00 y 16:00-20:00; S:
 * 09:00-14:00`). A weekday no rule names is closed. A schedule of Monday
 * alone (`L: 24H`, which the large brands' all-day stations publish) cannot
 * be told from a station that opens only on Mondays, so it is not read, nor
 * is one whose rules cannot be parsed; both are counted as values not read.
 */
function openingHoursOf(horario: string | undefined, feedId: string): string | undefined {
  if (horario === undefined) return undefined;
  const week: (Interval[] | undefined)[] = WEEKDAYS.map(() => undefined);
  const unread = () => {
    recordSkipped(feedId, "unknown_value");
    return undefined;
  };
  for (const rule of horario.split(";")) {
    const m = rule.trim().match(HORARIO_RULE);
    if (!m) return unread();
    const first = WEEKDAYS.indexOf(m[1] as (typeof WEEKDAYS)[number]);
    const last = m[2] === undefined ? first : WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]);
    if (last < first) return unread();
    const spec = (m[3] ?? "").trim();
    const intervals: Interval[] = [];
    if (spec === "24H") {
      intervals.push({ opens: "00:00", closes: "24:00" });
    } else {
      for (const span of spec.split(/\s+y\s+/)) {
        const [opens, closes, ...rest] = span.split("-");
        const read =
          opens !== undefined && closes !== undefined && rest.length === 0
            ? interval(opens, closes)
            : undefined;
        if (read === undefined) return unread();
        intervals.push(read);
      }
    }
    for (let d = first; d <= last; d++) {
      if (week[d] !== undefined) return unread();
      week[d] = intervals;
    }
  }
  if (week.filter((d) => d !== undefined).length === 1 && week[0] !== undefined) return unread();
  return osmOpeningHours(week.map((d) => d ?? []));
}

/**
 * `Tipo Venta`: P sold to the public, R only to a restricted clientele (a
 * cooperative's members, a fleet). Another value is counted as not read.
 */
function audienceOf(
  tipoVenta: string | undefined,
  feedId: string,
): "public" | "restricted" | "unknown" {
  if (tipoVenta === "P") return "public";
  if (tipoVenta === "R") return "restricted";
  if (tipoVenta !== undefined) recordSkipped(feedId, "unknown_value");
  return "unknown";
}

/** The grades a station prices: each column with a positive price. */
function pricedGrades(station: Station): { grade: FuelGrade; amount: string }[] {
  return GRADE_COLUMNS.flatMap(([column, grade]) => {
    const amount = decimalText(station[column]);
    return amount !== undefined && Number(amount) > 0 ? [{ grade, amount }] : [];
  });
}

/**
 * The price columns of grades the ministry added after the ones mapped here
 * that hold a price for the station: prices the station is published without.
 */
function unknownPricedColumns(station: Station): number {
  return Object.keys(station).filter((column) => {
    if (!column.startsWith("Precio ") || PRICE_COLUMNS.has(column)) return false;
    const amount = decimalText(station[column]);
    return amount !== undefined && Number(amount) > 0;
  }).length;
}

/**
 * The Spanish ministry's file of every station and every grade's price
 * (`EstacionesTerrestres`): decimal commas, an empty string for a grade the
 * station does not sell, and one publication time for the whole file. The
 * file lists every grade, so the station's products are complete. `Horario`
 * gives the opening hours and `Tipo Venta` who may buy. `Margen`, the side of
 * the road the station is on, has no counterpart without the road's direction.
 */
export function parseMinetur(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  for (const payload of payloads["main"] ?? []) {
    const file = JSON.parse(payload.toString("utf8").replace(/^﻿/, "")) as {
      Fecha?: unknown;
      ListaEESSPrecio?: unknown;
      ResultadoConsulta?: unknown;
    };
    if (file.ResultadoConsulta !== "OK" || !Array.isArray(file.ListaEESSPrecio)) {
      throw new Error(
        `MINETUR: no station list (ResultadoConsulta ${String(file.ResultadoConsulta)})`,
      );
    }
    const at = publicationTime(file.Fecha);
    for (const station of file.ListaEESSPrecio as Station[]) {
      const stationId = text(station["IDEESS"]);
      if (stationId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const position = stationPosition(
        coordinate(station["Longitud (WGS84)"]),
        coordinate(station["Latitud"]),
      );
      if ("skip" in position) {
        recordSkipped(feed.id, position.skip);
        continue;
      }
      recordSkipped(feed.id, "unknown_value", unknownPricedColumns(station));
      const priced = pricedGrades(station);
      const sign = text(station["Rótulo"]);
      const province = PROVINCES[text(station["IDProvincia"]) ?? ""];
      const products: ProductInput[] = priced.map(({ grade }) => ({ key: grade, grade }));
      const openingHours = openingHoursOf(text(station["Horario"]), feed.id);
      const feature = stationDraft(feed, {
        stationId,
        ...position,
        fetchedAt: ctx.fetchedAt,
        ...(sign ? { name: { lang: "es", text: sign }, brand: sign } : {}),
        address: {
          ...(text(station["Dirección"]) ? { street: text(station["Dirección"]) } : {}),
          ...(text(station["C.P."]) ? { postalCode: text(station["C.P."]) } : {}),
          ...(text(station["Municipio"]) ? { city: text(station["Municipio"]) } : {}),
          country: "ES",
        },
        admin: {
          country: "ES",
          ...(province ? { geocodes: [{ scheme: "iso3166-2", code: `ES-${province}` }] } : {}),
        },
        ...(openingHours === undefined ? {} : { openingHours }),
        audience: audienceOf(text(station["Tipo Venta"]), feed.id),
        productsComplete: true,
        products,
      });
      out.features.push(feature);
      for (const { grade, amount } of priced) {
        out.observations.push(
          priceDraft(feature, { componentKey: grade, amount, currency: "EUR", at }),
        );
      }
    }
  }
  return out;
}
