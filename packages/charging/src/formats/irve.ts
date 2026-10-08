import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, PAYMENT_METHODS } from "@openconditions/model";
import { colocateSites } from "../colocate.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  emi3Of,
  instantIn,
  type ParkingType,
  parsePowerKw,
  type SiteInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";
import { type DelimitedRow, readDelimited } from "./delimited.js";
import { placeAt, placeFromText, text } from "./raw.js";

const ZONE = "Europe/Paris";

const STATIC_COLUMNS = [
  "nom_operateur",
  "nom_enseigne",
  "id_station_itinerance",
  "nom_station",
  "implantation_station",
  "adresse_station",
  "coordonneesXY",
  "id_pdc_itinerance",
  "puissance_nominale",
  "prise_type_ef",
  "prise_type_2",
  "prise_type_combo_ccs",
  "prise_type_chademo",
  "prise_type_autre",
  "gratuit",
  "paiement_cb",
  "paiement_autre",
  "tarification",
  "condition_acces",
  "reservation",
  "horaires",
  "cable_t2_attache",
  "consolidated_longitude",
  "consolidated_latitude",
  "consolidated_code_postal",
  "consolidated_commune",
] as const;

const STATUS_COLUMNS = ["id_pdc_itinerance", "etat_pdc", "occupation_pdc", "horodatage"] as const;

const isTrue = (value: string | undefined) => value?.toLowerCase() === "true";

/** A placeholder the publishers write where a station has no itinerance id. */
const NO_ID = new Set(["", "non concerné", "non concerne", "n/a"]);
const usable = (value: string | undefined): string | undefined => {
  const t = text(value);
  return t === undefined || NO_ID.has(t.toLowerCase()) ? undefined : t;
};

/** `[lon, lat]` from `"[2.36, 49.87]"`, else the consolidated columns. */
function pointOf(row: DelimitedRow): [number, number] | undefined {
  const m = (row["coordonneesXY"] ?? "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  const written =
    m?.[1] === undefined || m[2] === undefined ? undefined : placeAt(Number(m[2]), Number(m[1]));
  return written ?? placeFromText(row["consolidated_latitude"], row["consolidated_longitude"]);
}

const DAYS: Readonly<Record<string, number>> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };
const HOURS_TOKEN =
  /\s*(?:(Mo|Tu|We|Th|Fr|Sa|Su)[a-z]*|(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})|([-,;]))\s*/giy;
const padded = (clock: string) => (clock.length === 4 ? `0${clock}` : clock);

/**
 * `horaires` as OSM hours when it reads as weekdays with time spans (`Mo-Fr
 * 08:00-12:00,Mo-Fr 14:00-18:00`, `Mo 00:00-23:59, Tu …`, English day names);
 * undefined for anything else, including a span that ends where it starts.
 */
function hoursOf(raw: string | undefined): string | undefined {
  const value = text(raw);
  if (value === undefined) return undefined;
  if (value === "24/7") return "24/7";
  const periods: WeeklyPeriod[] = [];
  let days: number[] = [];
  let spans: [string, string][] = [];
  let last: number | undefined;
  let range = false;
  const close = (): boolean => {
    if (days.length === 0 && spans.length === 0) return true;
    if (days.length === 0 || spans.length === 0) return false;
    for (const day of days) {
      for (const [from, to] of spans) periods.push({ day, from, to });
    }
    return true;
  };
  HOURS_TOKEN.lastIndex = 0;
  let consumed = 0;
  while (consumed < value.length) {
    const m = HOURS_TOKEN.exec(value);
    if (m === null || m.index !== consumed) return undefined;
    consumed = HOURS_TOKEN.lastIndex;
    if (m[1] !== undefined) {
      const day = DAYS[m[1].toLowerCase()];
      if (day === undefined) return undefined;
      if (range && last !== undefined) {
        for (let d = last; ; d = (d % 7) + 1) {
          if (!days.includes(d)) days.push(d);
          if (d === day) break;
        }
      } else {
        if (spans.length > 0) {
          if (!close()) return undefined;
          days = [];
          spans = [];
        }
        if (!days.includes(day)) days.push(day);
      }
      last = day;
      range = false;
    } else if (m[2] !== undefined && m[3] !== undefined) {
      const from = padded(m[2]);
      const to = padded(m[3]);
      if (from === to) return undefined;
      spans.push([from, to]);
      range = false;
    } else if (m[4] === "-") {
      if (last === undefined || spans.length > 0) return undefined;
      range = true;
    }
  }
  if (range || !close()) return undefined;
  return osmOpeningHours(periods);
}

interface Station {
  input: SiteInput;
  evses: EvseInput[];
}

const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  "accès libre": "public",
  "accès réservé": "restricted",
};

const PARKING: Readonly<Record<string, ParkingType>> = {
  voirie: "on_street",
  "station dédiée à la recharge rapide": "other",
};

function connectorsOf(row: DelimitedRow): ConnectorInput[] {
  const kw = parsePowerKw(row["puissance_nominale"]);
  const cable =
    row["cable_t2_attache"] === undefined || row["cable_t2_attache"] === ""
      ? undefined
      : isTrue(row["cable_t2_attache"])
        ? ("cable" as const)
        : ("socket" as const);
  const plugs: (ConnectorInput & { on: boolean })[] = [
    {
      on: isTrue(row["prise_type_ef"]),
      id: "ef",
      standard: "DOMESTIC_E",
      format: "socket",
      current: "ac",
    },
    {
      on: isTrue(row["prise_type_2"]),
      id: "2",
      standard: "IEC_62196_T2",
      current: "ac",
      ...(cable === undefined ? {} : { format: cable }),
    },
    {
      on: isTrue(row["prise_type_combo_ccs"]),
      id: "combo_ccs",
      standard: "IEC_62196_T2_COMBO",
      format: "cable",
      powerType: "DC",
    },
    {
      on: isTrue(row["prise_type_chademo"]),
      id: "chademo",
      standard: "CHADEMO",
      format: "cable",
      powerType: "DC",
    },
    { on: isTrue(row["prise_type_autre"]), id: "autre", standard: "UNKNOWN" },
  ];
  const present = plugs.filter((p) => p.on);
  // The point's nominal power is its main plug's: a domestic socket beside
  // other plugs is not rated by it.
  return present.map(({ on: _on, ...plug }) =>
    kw === undefined || (plug.standard === "DOMESTIC_E" && present.length > 1)
      ? plug
      : { ...plug, maxPowerKw: kw },
  );
}

function stationOf(row: DelimitedRow, stationId: string, point: [number, number]): Station {
  const operator = text(row["nom_operateur"]);
  const hoursText = text(row["horaires"]);
  const osm = hoursOf(hoursText);
  const payment: (typeof PAYMENT_METHODS)[number][] = [
    ...(isTrue(row["gratuit"]) ? (["free"] as const) : []),
    ...(isTrue(row["paiement_cb"]) ? (["credit_card"] as const) : []),
    ...(isTrue(row["paiement_autre"]) ? (["other"] as const) : []),
  ];
  const audience = AUDIENCE[(row["condition_acces"] ?? "").toLowerCase()];
  const parkingType = PARKING[(row["implantation_station"] ?? "").toLowerCase()];
  const evses: EvseInput[] = [];
  return {
    evses,
    input: {
      stationId,
      point,
      lang: "fr",
      name: text(row["nom_station"]),
      ...(operator === undefined ? {} : { operator: { name: operator } }),
      brand: row["nom_enseigne"],
      address: {
        text: row["adresse_station"],
        postalCode: row["consolidated_code_postal"],
        city: row["consolidated_commune"],
      },
      ...(osm === undefined ? {} : { openingHoursOsm: osm }),
      ...(osm === undefined && hoursText !== undefined ? { openingHoursText: hoursText } : {}),
      tariffText: row["tarification"],
      ...(audience === undefined ? {} : { audience }),
      ...(payment.length === 0 ? {} : { payment }),
      ...(parkingType === undefined ? {} : { parkingType }),
      evses,
    },
  };
}

/** `occupe` says the point is in use, not that it delivers energy. */
const STATUSES: Readonly<Record<string, EvseStatus>> = {
  libre: "available",
  occupe: "occupied",
  reserve: "reserved",
};

/** A point out of service is out of order; otherwise its occupancy says what it is doing. */
function statusOf(row: DelimitedRow): EvseStatus {
  if (row["etat_pdc"] === "hors_service") return "out_of_order";
  return STATUSES[row["occupation_pdc"] ?? ""] ?? "unknown";
}

/**
 * France's national IRVE base: the static consolidation, one row per charge
 * point (PDC), and the dynamic one, a status per PDC. The static file is read
 * record by record keeping only the mapped columns, since it is far larger
 * than the rest of the catalogue and its other columns are never used. A
 * station the publisher gave no id ("Non concerné") is grouped by position,
 * and one operator's stations within 15 m are one site.
 */
export function parseIrve(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const stations = new Map<string, Station>();
  const pdcs: StatusIndexDraft = new Map();
  let rejected = 0;
  for (const body of payloads["main"] ?? []) {
    readDelimited(body, { delimiter: ",", columns: STATIC_COLUMNS }, (row) => {
      const pdc = usable(row["id_pdc_itinerance"]);
      const point = pointOf(row);
      if (pdc === undefined || point === undefined) {
        rejected++;
        return;
      }
      const stationId =
        usable(row["id_station_itinerance"]) ?? `${point[1].toFixed(5)},${point[0].toFixed(5)}`;
      const known = pdcs.get(pdc)?.[0];
      if (known !== undefined) {
        // The consolidation repeats a PDC under its station; a PDC claimed by two stations is a conflict.
        if (known.stationId !== stationId) rejected++;
        return;
      }
      let station = stations.get(stationId);
      if (station === undefined) {
        station = stationOf(row, stationId, point);
        stations.set(stationId, station);
      }
      const evseId = emi3Of(pdc);
      station.evses.push({
        key: pdc,
        ...(evseId === undefined ? {} : { evseId }),
        ...(isTrue(row["reservation"]) ? { capabilities: ["RESERVABLE"] } : {}),
        connectors: connectorsOf(row),
      });
      indexStatus(pdcs, pdc, { stationId, evseKey: pdc, point: station.input.point });
    });
  }
  for (const station of stations.values()) {
    out.features.push(siteDraft(feed, station.input, ctx.fetchedAt));
  }
  out.rejected = rejected;
  out.statusIndex = pdcs;
  colocateSites(out);
  out.observations = parseIrveStatus(feed, payloads, ctx, pdcs).observations;
  return out;
}

/**
 * The dynamic consolidation: one reading per indexed PDC, of its newest
 * status (the first where times tie or do not read), as of its `horodatage`,
 * and none when that lies more than 30 days back. A row of a PDC the index
 * does not hold is rejected.
 */
export function parseIrveStatus(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  const reader = statusReader(feed, ctx);
  const latest = new Map<string, { row: DelimitedRow; changedAt: string | undefined }>();
  for (const body of payloads["status"] ?? []) {
    readDelimited(body, { delimiter: ",", columns: STATUS_COLUMNS }, (row) => {
      const id = text(row["id_pdc_itinerance"]);
      if (id === undefined || !index.has(id)) {
        reader.reject();
        return;
      }
      const changedAt = instantIn(ZONE, row["horodatage"]);
      const held = latest.get(id);
      const newer =
        held === undefined ||
        (changedAt !== undefined &&
          (held.changedAt === undefined || Date.parse(changedAt) > Date.parse(held.changedAt)));
      if (newer) latest.set(id, { row, changedAt });
    });
  }
  for (const [id, { row, changedAt }] of latest) {
    if (!statusIsLive(changedAt, ctx.fetchedAt)) continue;
    for (const subject of subjectsOf(index, id)) reader.read(subject, statusOf(row), changedAt);
  }
  return reader.output();
}
