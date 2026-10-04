import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { zonedWallClockToInstant } from "@openconditions/model";
import type { FuelGrade } from "../grades.js";
import {
  type FuelFeed,
  type ProductInput,
  placeable,
  priceDraft,
  stationDraft,
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

/** A decimal-comma number; NaN when empty, unreadable or not a string. */
function decimal(value: unknown): number {
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

/** The grades a station prices: each column with a positive price. */
function pricedGrades(station: Station): { grade: FuelGrade; amount: string }[] {
  return GRADE_COLUMNS.flatMap(([column, grade]) => {
    const amount = decimalText(station[column]);
    return amount !== undefined && Number(amount) > 0 ? [{ grade, amount }] : [];
  });
}

/**
 * The Spanish ministry's file of every station and every grade's price
 * (`EstacionesTerrestres`): decimal commas, an empty string for a grade the
 * station does not sell, and one publication time for the whole file. The
 * file lists every grade, so the station's products are complete.
 */
export function parseMinetur(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
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
      const lon = decimal(station["Longitud (WGS84)"]);
      const lat = decimal(station["Latitud"]);
      if (stationId === undefined || !placeable(lon, lat)) {
        rejected++;
        continue;
      }
      const priced = pricedGrades(station);
      const sign = text(station["Rótulo"]);
      const province = PROVINCES[text(station["IDProvincia"]) ?? ""];
      const products: ProductInput[] = priced.map(({ grade }) => ({ key: grade, grade }));
      const feature = stationDraft(feed, {
        stationId,
        lon,
        lat,
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
        // `Tipo Venta` R: sold only to a restricted clientele (a cooperative's members, a fleet).
        audience: text(station["Tipo Venta"]) === "R" ? "restricted" : "public",
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
  out.rejected = rejected;
  return out;
}
