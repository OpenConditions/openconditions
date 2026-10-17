import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, PAYMENT_METHODS } from "@openconditions/model";
import { colocateSites } from "../colocate.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import { own } from "../records.js";
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
  "nom_amenageur",
  "siren_amenageur",
  "contact_amenageur",
  "nom_operateur",
  "contact_operateur",
  "telephone_operateur",
  "nom_enseigne",
  "id_station_itinerance",
  "nom_station",
  "implantation_station",
  "adresse_station",
  "code_insee_commune",
  "coordonneesXY",
  "id_pdc_itinerance",
  "id_pdc_local",
  "puissance_nominale",
  "prise_type_ef",
  "prise_type_2",
  "prise_type_combo_ccs",
  "prise_type_chademo",
  "prise_type_autre",
  "gratuit",
  "paiement_acte",
  "paiement_cb",
  "paiement_autre",
  "tarification",
  "condition_acces",
  "reservation",
  "horaires",
  "accessibilite_pmr",
  "station_deux_roues",
  "observations",
  "cable_t2_attache",
  "consolidated_longitude",
  "consolidated_latitude",
  "consolidated_code_postal",
  "consolidated_commune",
] as const;

/** The plugs the dynamic schema gives a state of, each by its `etat_prise_type_*` column. */
const PLUG_STATES = ["2", "combo_ccs", "chademo", "ef"] as const;

const STATUS_COLUMNS = [
  "id_pdc_itinerance",
  "etat_pdc",
  "occupation_pdc",
  "horodatage",
  ...PLUG_STATES.map((plug) => `etat_prise_type_${plug}`),
] as const;

/** Table Schema's boolean values, which the IRVE schema keeps. */
const TRUE_VALUES = new Set(["true", "True", "TRUE", "1"]);
const FALSE_VALUES = new Set(["false", "False", "FALSE", "0"]);

/**
 * A boolean column's value, undefined where the publisher left it empty. A
 * value that is no Table Schema boolean is left unread and counted.
 */
function booleanOf(feedId: string, raw: string | undefined): boolean | undefined {
  const value = raw ?? "";
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  if (value !== "") recordSkipped(feedId, "unknown_value");
  return undefined;
}

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

/**
 * `implantation_station`. A public car park ("en ouvrage, en enclos") and a
 * private one open to the public are both car parks the schema does not say
 * are built over; a fast-charging station is first a place to charge, not to
 * park.
 */
const PARKING: Readonly<Record<string, ParkingType>> = {
  voirie: "on_street",
  "parking public": "parking_lot",
  "parking privé à usage public": "parking_lot",
  "parking privé réservé à la clientèle": "parking_lot",
  "station dédiée à la recharge rapide": "other",
};

/** A car park "réservé à la clientèle, aux usagers" (a hotel, a shop) holds its bays for customers. */
const CUSTOMERS_ONLY = "parking privé réservé à la clientèle";

/**
 * `accessibilite_pmr`: whether a person of reduced mobility can use the
 * point, and whether its bay is signed and reserved for them. Unknown
 * accessibility says neither.
 */
const ACCESSIBILITY: Readonly<Record<string, { accessible?: boolean; reserved?: true }>> = {
  "réservé pmr": { accessible: true, reserved: true },
  "accessible mais non réservé pmr": { accessible: true },
  "non accessible": { accessible: false },
  "accessibilité inconnue": {},
};

/** The schema's SIREN and INSEE commune code patterns. */
const SIREN = /^\d{9}$/;
const INSEE = /^([013-9]\d|2[AB1-9])\d{3}$/;

/** A mapped value of an enumerated column; a value the schema does not list is counted. */
function enumerated<T>(
  feedId: string,
  table: Readonly<Record<string, T>>,
  raw: string | undefined,
): T | undefined {
  const value = (raw ?? "").toLowerCase();
  if (value === "") return undefined;
  if (!Object.hasOwn(table, value)) {
    recordSkipped(feedId, "unknown_value");
    return undefined;
  }
  return table[value];
}

/** The bays a point's row restricts to: the car park's customers, disabled drivers, two-wheelers. */
function restrictionsOf(
  feedId: string,
  row: DelimitedRow,
  access: { reserved?: true } | undefined,
): string[] {
  const implantation = (row["implantation_station"] ?? "").toLowerCase();
  return [
    ...(implantation === CUSTOMERS_ONLY ? ["customers"] : []),
    ...(access?.reserved === true ? ["disabled"] : []),
    ...(booleanOf(feedId, row["station_deux_roues"]) === true ? ["motorcycles"] : []),
  ];
}

function connectorsOf(feedId: string, row: DelimitedRow): ConnectorInput[] {
  const kw = parsePowerKw(row["puissance_nominale"]);
  const attached = booleanOf(feedId, row["cable_t2_attache"]);
  const cable =
    attached === undefined ? undefined : attached ? ("cable" as const) : ("socket" as const);
  const has = (column: string) => booleanOf(feedId, row[column]) === true;
  const plugs: (ConnectorInput & { on: boolean })[] = [
    {
      on: has("prise_type_ef"),
      id: "ef",
      standard: "DOMESTIC_E",
      format: "socket",
      current: "ac",
    },
    {
      on: has("prise_type_2"),
      id: "2",
      standard: "IEC_62196_T2",
      current: "ac",
      ...(cable === undefined ? {} : { format: cable }),
    },
    {
      on: has("prise_type_combo_ccs"),
      id: "combo_ccs",
      standard: "IEC_62196_T2_COMBO",
      format: "cable",
      powerType: "DC",
    },
    {
      on: has("prise_type_chademo"),
      id: "chademo",
      standard: "CHADEMO",
      format: "cable",
      powerType: "DC",
    },
    { on: has("prise_type_autre"), id: "autre", standard: "UNKNOWN" },
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

function stationOf(
  feedId: string,
  row: DelimitedRow,
  stationId: string,
  point: [number, number],
): Station {
  const operator = text(row["nom_operateur"]);
  const owner = text(row["nom_amenageur"]);
  const siren = text(row["siren_amenageur"]);
  const insee = text(row["code_insee_commune"]);
  const hoursText = text(row["horaires"]);
  const osm = hoursOf(hoursText);
  const payment: (typeof PAYMENT_METHODS)[number][] = [
    ...(booleanOf(feedId, row["gratuit"]) === true ? (["free"] as const) : []),
    ...(booleanOf(feedId, row["paiement_cb"]) === true ? (["credit_card"] as const) : []),
    ...(booleanOf(feedId, row["paiement_autre"]) === true ? (["other"] as const) : []),
  ];
  const audience = enumerated(feedId, AUDIENCE, row["condition_acces"]);
  const parkingType = enumerated(feedId, PARKING, row["implantation_station"]);
  const adHoc = booleanOf(feedId, row["paiement_acte"]);
  const evses: EvseInput[] = [];
  return {
    evses,
    input: {
      stationId,
      point,
      lang: "fr",
      name: text(row["nom_station"]),
      ...(operator === undefined
        ? {}
        : {
            operator: {
              name: operator,
              ...(text(row["contact_operateur"]) === undefined
                ? {}
                : { email: text(row["contact_operateur"]) }),
              ...(text(row["telephone_operateur"]) === undefined
                ? {}
                : { phone: text(row["telephone_operateur"]) }),
            },
          }),
      ...(owner === undefined
        ? {}
        : {
            owner: {
              name: owner,
              ...(text(row["contact_amenageur"]) === undefined
                ? {}
                : { email: text(row["contact_amenageur"]) }),
              ...(siren === undefined || !SIREN.test(siren)
                ? {}
                : { ids: [{ scheme: "siren", id: siren }] }),
            },
          }),
      brand: row["nom_enseigne"],
      address: {
        text: row["adresse_station"],
        postalCode: row["consolidated_code_postal"],
        city: row["consolidated_commune"],
      },
      ...(insee === undefined || !INSEE.test(insee)
        ? {}
        : { geocodes: [{ scheme: "insee", code: insee }] }),
      ...(adHoc === undefined ? {} : { adHocCharging: adHoc }),
      ...(osm === undefined ? {} : { openingHoursOsm: osm }),
      ...(osm === undefined && hoursText !== undefined ? { openingHoursText: hoursText } : {}),
      tariffText: row["tarification"],
      notes: row["observations"],
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

const STATES = new Set(["en_service", "hors_service", "inconnu"]);

/**
 * A point out of service is out of order; otherwise, its working state in
 * service or unknown, its occupancy says what it is doing.
 */
function statusOf(feedId: string, row: DelimitedRow): EvseStatus {
  const state = row["etat_pdc"] ?? "";
  if (state !== "" && !STATES.has(state)) recordSkipped(feedId, "unknown_value");
  if (state === "hors_service") return "out_of_order";
  const occupancy = row["occupation_pdc"] ?? "";
  const status = own(STATUSES, occupancy);
  if (occupancy !== "" && occupancy !== "inconnu" && status === undefined) {
    recordSkipped(feedId, "unknown_value");
  }
  return status ?? "unknown";
}

/**
 * A plug's status from its `etat_prise_type_*`: one out of service is out of
 * order; a working one does what its point does, the point charging one
 * vehicle at a time; one whose state is unknown is unknown unless its whole
 * point is out of order. Undefined where the column is empty, which the
 * schema reserves for a point without that plug.
 */
function plugStatusOf(
  feedId: string,
  raw: string | undefined,
  point: EvseStatus,
): EvseStatus | undefined {
  switch (raw ?? "") {
    case "":
      return undefined;
    case "hors_service":
      return "out_of_order";
    case "fonctionnel":
      return point;
    case "inconnu":
      return point === "out_of_order" ? "out_of_order" : "unknown";
    default:
      recordSkipped(feedId, "unknown_value");
      return undefined;
  }
}

/**
 * France's national IRVE base: the static consolidation, one row per charge
 * point (PDC), and the dynamic one, a status per PDC. The static file is read
 * record by record keeping only the mapped columns, since it is far larger
 * than the rest of the catalogue and its other columns are never used. A
 * station the publisher gave no id ("Non concerné") is grouped by position,
 * a point outside roaming is keyed by its operator's own id within its
 * station, and one operator's stations within 15 m are one site. A row with
 * neither point id, or of a point already claimed by another station, is
 * malformed, and one without a position has no geometry.
 */
export function parseIrve(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const stations = new Map<string, Station>();
  const pdcs: StatusIndexDraft = new Map();
  for (const body of payloads["main"] ?? []) {
    readDelimited(body, { delimiter: ",", columns: STATIC_COLUMNS }, (row) => {
      const pdc = usable(row["id_pdc_itinerance"]);
      const local = text(row["id_pdc_local"]);
      const key = pdc ?? local;
      if (key === undefined) {
        recordSkipped(feed.id, "malformed");
        return;
      }
      const point = pointOf(row);
      if (point === undefined) {
        recordSkipped(feed.id, "no_geometry");
        return;
      }
      const stationId =
        usable(row["id_station_itinerance"]) ?? `${point[1].toFixed(5)},${point[0].toFixed(5)}`;
      const known = pdc === undefined ? undefined : pdcs.get(pdc)?.[0];
      if (known !== undefined) {
        // The consolidation repeats a PDC under its station; a PDC claimed by two stations is a conflict.
        if (known.stationId !== stationId) recordSkipped(feed.id, "malformed");
        return;
      }
      let station = stations.get(stationId);
      if (station === undefined) {
        station = stationOf(feed.id, row, stationId, point);
        stations.set(stationId, station);
      }
      // A point outside roaming has its operator's id only, unique within its station.
      if (pdc === undefined && station.evses.some((e) => e.key === key)) return;
      const evseId = emi3Of(pdc);
      const access = enumerated(feed.id, ACCESSIBILITY, row["accessibilite_pmr"]);
      const restrictions = restrictionsOf(feed.id, row, access);
      const connectors = connectorsOf(feed.id, row);
      station.evses.push({
        key,
        ...(evseId === undefined ? {} : { evseId }),
        ...(local === undefined ? {} : { uid: local }),
        ...(booleanOf(feed.id, row["reservation"]) === true
          ? { capabilities: ["RESERVABLE"] }
          : {}),
        ...(restrictions.length === 0 ? {} : { parkingRestrictions: restrictions }),
        ...(access?.accessible === undefined ? {} : { wheelchairAccessible: access.accessible }),
        connectors,
      });
      // The dynamic file names a point by its itinerance id alone.
      if (pdc === undefined) return;
      const subject = { stationId, evseKey: pdc, point: station.input.point };
      indexStatus(pdcs, pdc, subject);
      for (const { id } of connectors) {
        if ((PLUG_STATES as readonly string[]).includes(id)) {
          indexStatus(pdcs, pdc, { ...subject, connectorId: id });
        }
      }
    });
  }
  for (const station of stations.values()) {
    out.features.push(siteDraft(feed, station.input, ctx.fetchedAt));
  }
  out.statusIndex = pdcs;
  colocateSites(out);
  out.observations = parseIrveStatus(feed, payloads, ctx, pdcs).observations;
  return out;
}

/**
 * The dynamic consolidation: one reading per indexed PDC, of its newest
 * status (the first where times tie or do not read), as of its `horodatage`,
 * and none when that lies more than 30 days back; beside it one per plug the
 * row gives a state of. A row without a PDC id is malformed; one of a PDC the
 * index does not hold is rejected.
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
      if (id === undefined) {
        recordSkipped(feed.id, "malformed");
        return;
      }
      if (!index.has(id)) {
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
    const point = statusOf(feed.id, row);
    const plugs = new Map(
      PLUG_STATES.map((plug) => [
        plug as string,
        plugStatusOf(feed.id, row[`etat_prise_type_${plug}`], point),
      ]),
    );
    for (const subject of subjectsOf(index, id)) {
      const status = subject.connectorId === undefined ? point : plugs.get(subject.connectorId);
      if (status !== undefined) reader.read(subject, status, changedAt);
    }
  }
  return reader.output();
}
