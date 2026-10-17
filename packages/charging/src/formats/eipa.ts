import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { AUTHENTICATION_METHODS, PAYMENT_METHODS } from "@openconditions/model";
import { CONNECTOR_STANDARDS } from "@openconditions/model-charging";
import type { OcpiTariff } from "@openconditions/ocpi";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import { own } from "../records.js";
import {
  type ChargingMode,
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  emi3Of,
  type ImageCategory,
  type ImageInput,
  instantIn,
  type PowerType,
  parsePowerKw,
  type SiteInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";
import { tariffDraft } from "../tariff.js";
import { isRecord, placeAt, type Raw, text, unplacedReason } from "./raw.js";

const ZONE = "Europe/Warsaw";

const STANDARDS: ReadonlySet<string> = new Set(CONNECTOR_STANDARDS);

/** The rows of a reader file: `{ data: [...] }`, or the list itself. */
function rowsOf(bodies: readonly Buffer[] | undefined): Raw[] {
  return (bodies ?? []).flatMap((body) => {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const rows = isRecord(doc) ? doc["data"] : doc;
    return Array.isArray(rows) ? rows.filter(isRecord) : [];
  });
}

const idOf = (value: unknown): string | undefined => text(value);

/** One of the dictionary's tables (`connector_interface`, `charging_mode`): names by id. */
function dictionaryTable(dictionary: Raw[], table: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const tables of dictionary) {
    const list = tables[table];
    if (!Array.isArray(list)) continue;
    for (const entry of list.filter(isRecord)) {
      const id = idOf(entry["id"]);
      const name = text(entry["name"]);
      if (id !== undefined && name !== undefined) names.set(id, name);
    }
  }
  return names;
}

const CABLE_SUFFIX = /^(.*?)(?:_[FM])?_(NO)?CABLE$/;

/**
 * The interfaces whose names are no OCPI standard's: the Type 3A socket
 * (`IEC-62196-T3A-F`) and China's GB/T parts 2 (AC) and 3 (DC).
 */
const RENAMED: Readonly<Record<string, string>> = {
  IEC_62196_T3A_F: "IEC_62196_T3A",
  CHINA_PART2: "GBT_AC",
  CHINA_PART3: "GBT_DC",
};

/**
 * An interface name (`IEC-62196-T2-F-CABLE`) as a connector standard and,
 * where the name says it, whether the plug is a socket or a cable.
 */
function plugOf(name: string | undefined): { standard: string; format?: "socket" | "cable" } {
  if (name === undefined) return { standard: "UNKNOWN" };
  const underscored = name.replace(/-/g, "_").toUpperCase();
  const suffix = underscored.match(CABLE_SUFFIX);
  const written = suffix?.[1] ?? underscored;
  const base = own(RENAMED, written) ?? written;
  const format = suffix === null ? undefined : suffix[2] === undefined ? "cable" : "socket";
  return {
    standard: STANDARDS.has(base) ? base : "UNKNOWN",
    ...(format === undefined ? {} : { format }),
  };
}

/** A charging mode name (`Mode3-AC-3p`, `Mode4-DC`) as its IEC 61851-1 mode and power type. */
function modeOf(name: string | undefined): { mode?: ChargingMode; powerType?: PowerType } {
  const m = name?.match(/^Mode([1-4])-(AC-([13])p|DC)$/i);
  if (m === null || m === undefined) return {};
  const powerType: PowerType =
    m[3] === undefined ? "DC" : m[3] === "1" ? "AC_1_PHASE" : "AC_3_PHASE";
  return { mode: `mode${m[1]}` as ChargingMode, powerType };
}

interface Dynamic {
  availability?: number;
  occupancy?: number;
  ts?: string;
  prices: { price: number; unit: string; literal?: string }[];
}

function dynamicOf(rows: Raw[]): Map<string, Dynamic> {
  const byPoint = new Map<string, Dynamic>();
  for (const row of rows) {
    const id = idOf(row["point_id"]);
    if (id === undefined) continue;
    const status = isRecord(row["status"]) ? row["status"] : {};
    const prices = (Array.isArray(row["prices"]) ? row["prices"] : [])
      .filter(isRecord)
      .flatMap((p) => {
        const price = Number(text(p["price"])?.replace(",", "."));
        const unit = text(p["unit"]);
        if (!Number.isFinite(price) || price < 0 || unit === undefined) return [];
        const literal = text(p["literal"]);
        return [{ price, unit, ...(literal === undefined ? {} : { literal }) }];
      });
    const availability = Number(status["availability"]);
    const occupancy = Number(status["status"]);
    const ts = text(status["ts"]);
    byPoint.set(id, {
      ...(Number.isFinite(availability) && status["availability"] !== null ? { availability } : {}),
      ...(Number.isFinite(occupancy) && status["status"] !== null ? { occupancy } : {}),
      ...(ts === undefined ? {} : { ts }),
      prices,
    });
  }
  return byPoint;
}

/**
 * A point "niedostępne" (not available operationally) is inoperative, which
 * says nothing of it being broken; an available point is free or occupied.
 */
function statusOf(d: Dynamic): EvseStatus {
  if (d.availability === 0) return "inoperative";
  if (d.occupancy === 1) return "available";
  if (d.occupancy === 0) return "occupied";
  return "unknown";
}

/** An operating point's occupancy written as a code the reader does not list. */
const unlistedOccupancy = (d: Dynamic) =>
  d.availability !== 0 && d.occupancy !== undefined && d.occupancy !== 0 && d.occupancy !== 1;

const trimmed = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * The prices a point asks of drivers without a contract, as an OCPI tariff so
 * it becomes an ad-hoc offer: kilowatt-hours are an energy price, and minutes
 * a time price, which the model holds per hour. Gas and unknown units are not
 * charging prices. Undefined when no price remains.
 */
function adHocTariff(d: Dynamic | undefined): OcpiTariff | undefined {
  const energy = d?.prices.find((p) => p.unit.toLowerCase() === "kwh");
  const minute = d?.prices.find((p) => p.unit.toLowerCase() === "min");
  if (energy === undefined && minute === undefined) return undefined;
  const perHour = minute === undefined ? undefined : Math.round(minute.price * 60 * 1e6) / 1e6;
  const literals = [
    ...new Set([energy?.literal, minute?.literal].filter((l): l is string => l !== undefined)),
  ];
  return {
    id: `adhoc${energy === undefined ? "" : `-e${trimmed(energy.price)}`}${perHour === undefined ? "" : `-t${trimmed(perHour)}`}`,
    currency: "PLN",
    type: "AD_HOC_PAYMENT",
    tax_included: "N/A",
    elements: [
      {
        price_components: [
          ...(energy === undefined ? [] : [{ type: "ENERGY", price: energy.price }]),
          ...(perHour === undefined ? [] : [{ type: "TIME", price: perHour }]),
        ],
      },
    ],
    ...(literals.length === 0
      ? {}
      : { tariff_alt_text: [{ language: "pl", text: literals.join("; ") }] }),
  };
}

/**
 * The dictionary's `station_authentication_method`: unlimited access; the
 * RFID cards (Mifare Classic and DESFire, Calypso, a phone's active RFID
 * chip); a PIN pad; an app; ISO 15118 by cable or wirelessly, plug and
 * charge; a voice call or text message, a charge started remotely. "Brak
 * dostępu", no access, is a station not open to the public, and a prepaid
 * card a means of payment (`PREPAID`).
 */
const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number] | null>> = {
  "0": "none",
  "1": null,
  "2": "rfid",
  "4": "rfid",
  "8": "rfid",
  "16": "pin",
  "32": "app",
  "64": "rfid",
  "128": "plug_and_charge",
  "256": "plug_and_charge",
  "512": "remote",
  "1024": "remote",
  "8192": null,
};
const NO_ACCESS = "1";
const PREPAID = "8192";

/**
 * The dictionary's `station_payment_method`: unspecified; free; a contract
 * with the operator; a payment card; cash; a prepaid card; a fleet card, a
 * bank transfer and online payment, means the model names no further.
 */
const PAYMENTS: Readonly<Record<string, readonly (typeof PAYMENT_METHODS)[number][]>> = {
  "0": [],
  "1": ["free"],
  "2": ["membership"],
  "4": ["credit_card", "debit_card"],
  "8": ["cash"],
  "16": ["prepaid_card"],
  "32": ["other"],
  "64": ["other"],
  "128": ["other"],
};

/** A pool's or station's photos (`images`: `uri`, `thumbnail_uri`). */
function imagesOf(row: Raw, category: ImageCategory): ImageInput[] {
  return (Array.isArray(row["images"]) ? row["images"] : []).filter(isRecord).flatMap((image) => {
    const url = text(image["uri"]);
    const thumbnail = text(image["thumbnail_uri"]);
    return url === undefined
      ? []
      : [{ url, category, ...(thumbnail === undefined ? {} : { thumbnail }) }];
  });
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((v) => idOf(v) ?? []) : [];

function hoursOf(pool: Raw): string | undefined {
  const periods: WeeklyPeriod[] = (
    Array.isArray(pool["operating_hours"]) ? pool["operating_hours"] : []
  )
    .filter(isRecord)
    .flatMap((h) => {
      const day = Number(h["weekday"]);
      const from = text(h["from_time"]);
      const to = text(h["to_time"]);
      return from === undefined || to === undefined ? [] : [{ day, from, to }];
    });
  return osmOpeningHours(periods);
}

/**
 * The EIPA reader files: pools (sites) with their stations (type E for
 * electric), a station's points (the charge points, each interface a
 * connector), the operator and dictionary tables, and `dynamic.json` with
 * each point's availability and ad-hoc prices. Prices are the point's, so
 * they become offers on the site that its connectors reference. A pool or a
 * point without an id is malformed, a pool none of whose rows places it is
 * counted as such, and an interface the dictionary names outside the
 * connector standards is left unread and counted.
 */
export function parseEipa(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const pools = rowsOf(payloads["pools"]);
  const stations = rowsOf(payloads["stations"]).filter(
    (s) => text(s["type"])?.toUpperCase() === "E",
  );
  const points = rowsOf(payloads["points"]);
  const operators = new Map<string, Raw>();
  for (const o of rowsOf(payloads["operators"])) {
    const id = idOf(o["id"]);
    if (id !== undefined) operators.set(id, o);
  }
  const dictionary = rowsOf(payloads["dictionary"]);
  const interfaces = dictionaryTable(dictionary, "connector_interface");
  const modes = dictionaryTable(dictionary, "charging_mode");
  const dynamic = dynamicOf(rowsOf(payloads["status"]));
  const unread = () => recordSkipped(feed.id, "unknown_value");

  const stationsOf = new Map<string, Raw[]>();
  for (const station of stations) {
    const pool = idOf(station["pool_id"]);
    if (pool !== undefined) stationsOf.set(pool, [...(stationsOf.get(pool) ?? []), station]);
  }
  const pointsOf = new Map<string, Raw[]>();
  for (const point of points) {
    const station = idOf(point["station_id"]);
    if (station !== undefined) pointsOf.set(station, [...(pointsOf.get(station) ?? []), point]);
  }

  const index: StatusIndexDraft = new Map();
  const seen = new Set<string>();
  for (const pool of pools) {
    const poolId = idOf(pool["id"]);
    if (poolId === undefined) {
      recordSkipped(feed.id, "malformed");
      continue;
    }
    const poolStations = stationsOf.get(poolId);
    if (poolStations === undefined || seen.has(poolId)) continue;
    seen.add(poolId);
    const fallback = poolStations.find(
      (s) => placeAt(Number(s["latitude"]), Number(s["longitude"])) !== undefined,
    );
    const point =
      placeAt(Number(pool["latitude"]), Number(pool["longitude"])) ??
      (fallback === undefined
        ? undefined
        : placeAt(Number(fallback["latitude"]), Number(fallback["longitude"])));
    if (point === undefined) {
      const written = [pool, ...poolStations].some(
        (row) => unplacedReason(row["latitude"], row["longitude"]) === "malformed",
      );
      recordSkipped(feed.id, written ? "malformed" : "no_geometry");
      continue;
    }

    // The pool's own operator fields, where the operator gave them for the pool, else the operator's.
    const operator = operators.get(idOf(pool["operator_id"]) ?? "");
    const operatorField = (field: string) =>
      text(pool[`operator_${field}`]) ?? text(operator?.[field]);
    const operatorName = operatorField("name");
    const operatorCode = text(operator?.["code"]);

    const evses: EvseInput[] = [];
    const tariffs = new Map<string, OcpiTariff>();
    for (const station of poolStations) {
      const stationPoint = placeAt(Number(station["latitude"]), Number(station["longitude"]));
      const stationImages = imagesOf(station, "equipment");
      for (const p of pointsOf.get(idOf(station["id"]) ?? "") ?? []) {
        const pointId = idOf(p["id"]);
        if (pointId === undefined) {
          recordSkipped(feed.id, "malformed");
          continue;
        }
        const code = text(p["code"]);
        // The register writes its eMI3 ids with hyphens; the standard separator is `*`.
        const evseId = emi3Of(code?.replace(/-/g, "*"));
        const key = evseId ?? pointId;
        const d = dynamic.get(pointId);
        for (const price of d?.prices ?? []) {
          if (!["kwh", "min"].includes(price.unit.toLowerCase())) unread();
        }
        const tariff = adHocTariff(d);
        if (tariff !== undefined) tariffs.set(tariff.id, tariff);
        // The point's charging modes, and its power type where every mode names the same.
        const solutions = (Array.isArray(p["charging_solutions"]) ? p["charging_solutions"] : [])
          .filter(isRecord)
          .map((s) => {
            const id = idOf(s["mode"]);
            const name = id === undefined ? undefined : modes.get(id);
            const mode = modeOf(name);
            if (id !== undefined && mode.mode === undefined) unread();
            return mode;
          });
        const chargingModes = [
          ...new Set(solutions.flatMap((s) => (s.mode === undefined ? [] : [s.mode]))),
        ];
        const powerTypes = [...new Set(solutions.flatMap((s) => s.powerType ?? []))];
        const powerType = powerTypes.length === 1 ? powerTypes[0] : undefined;
        const connectors: ConnectorInput[] = (Array.isArray(p["connectors"]) ? p["connectors"] : [])
          .filter(isRecord)
          .flatMap((entry, k) => {
            const kw = parsePowerKw(entry["power"]);
            const attached =
              typeof entry["cable_attached"] === "boolean" ? entry["cable_attached"] : undefined;
            return list(entry["interfaces"]).map((interfaceId): ConnectorInput => {
              const name = interfaces.get(interfaceId);
              const plug = plugOf(name);
              if (name !== undefined && plug.standard === "UNKNOWN") unread();
              const format =
                plug.format ?? (attached === undefined ? undefined : attached ? "cable" : "socket");
              return {
                id: `${k + 1}.${interfaceId}`,
                standard: plug.standard,
                ...(format === undefined ? {} : { format }),
                ...(powerType === undefined ? {} : { powerType }),
                ...(kw === undefined ? {} : { maxPowerKw: kw }),
                ...(chargingModes.length === 0 ? {} : { chargingModes }),
                ...(tariff === undefined ? {} : { tariffIds: [tariff.id] }),
              };
            });
          });
        evses.push({
          key,
          ...(evseId === undefined ? {} : { evseId }),
          ...(stationPoint === undefined ? {} : { position: stationPoint }),
          ...(stationImages.length === 0 ? {} : { images: stationImages }),
          connectors,
        });
        indexStatus(index, pointId, { stationId: poolId, evseKey: key, point });
      }
    }

    const methods = poolStations.flatMap((s) => list(s["authentication_methods"]));
    const authentication = [
      ...new Set(
        methods.flatMap((a) => {
          const method = own(AUTHENTICATION, a);
          if (method === undefined) unread();
          return method ?? [];
        }),
      ),
    ];
    const payment = [
      ...new Set([
        ...poolStations.flatMap((s) =>
          list(s["payment_methods"]).flatMap((m) => {
            const means = own(PAYMENTS, m);
            if (means === undefined) unread();
            return means ?? [];
          }),
        ),
        ...(methods.includes(PREPAID) ? (["prepaid_card"] as const) : []),
      ]),
    ];
    const osm = hoursOf(pool);
    const closures = (Array.isArray(pool["closing_hours"]) ? pool["closing_hours"] : [])
      .filter(isRecord)
      .flatMap((c) => {
        const start = instantIn(ZONE, c["from_time"]);
        const end = instantIn(ZONE, c["to_time"]);
        return start === undefined || end === undefined ? [] : [{ start, end, open: false }];
      });
    const accessibility = text(pool["accessibility"]);
    const province = poolStations
      .map((s) => (isRecord(s["location"]) ? text(s["location"]["province"]) : undefined))
      .find((p) => p !== undefined);
    const images = imagesOf(pool, "site");
    const website = operatorField("website");
    const phone = operatorField("phone");
    const email = operatorField("email");
    const input: SiteInput = {
      stationId: poolId,
      point,
      lang: "pl",
      name: text(pool["name"]),
      ...(operatorName === undefined
        ? {}
        : {
            operator: {
              name: operatorName,
              ...(website === undefined ? {} : { website }),
              ...(phone === undefined ? {} : { phone }),
              ...(email === undefined ? {} : { email }),
              ...(operatorCode === undefined
                ? {}
                : { ids: [{ scheme: "cpo", id: operatorCode, authority: feed.id }] }),
            },
          }),
      address: {
        street: text(pool["street"]),
        houseNumber: [text(pool["house_number"]), text(pool["house_number_addition"])]
          .filter((v) => v !== undefined)
          .join(""),
        postalCode: text(pool["postal_code"]),
        city: text(pool["city"]),
        region: province,
      },
      ...(accessibility === undefined ? {} : { directions: [{ lang: "pl", text: accessibility }] }),
      ...(osm === undefined ? {} : { openingHoursOsm: osm }),
      ...(closures.length === 0 ? {} : { openingExceptions: closures }),
      ...(methods.includes(NO_ACCESS) ? { audience: "private" as const } : {}),
      ...(authentication.length === 0 ? {} : { authentication }),
      ...(payment.length === 0 ? {} : { payment }),
      ...(images.length === 0 ? {} : { images }),
      evses,
    };
    out.features.push(siteDraft(feed, input, ctx.fetchedAt));
    for (const tariff of tariffs.values()) {
      const offer = tariffDraft(feed, poolId, tariff, {
        fetchedAt: ctx.fetchedAt,
        point,
        key: tariff.id,
      });
      if (offer !== undefined) out.offers.push(offer);
    }
  }
  out.statusIndex = index;
  out.observations = eipaStatusReadings(feed, dynamic, index, ctx).observations;
  return out;
}

/**
 * A reading per indexed point of `dynamic.json`, as of its status time (`ts`),
 * and none when that lies more than 30 days back; a point the index does not
 * hold is rejected, and an occupancy code the reader does not list is read
 * as unknown and counted. Its prices are the full parse's: they change offers.
 */
function eipaStatusReadings(
  feed: ChargingCatalogFeed,
  dynamic: ReadonlyMap<string, Dynamic>,
  index: StatusIndex,
  ctx: ParseContext,
): StatusOutput {
  const reader = statusReader(feed, ctx);
  for (const [pointId, d] of dynamic) {
    const subjects = subjectsOf(index, pointId);
    if (subjects.length === 0) {
      reader.reject();
      continue;
    }
    const at = instantIn(ZONE, d.ts);
    if (!statusIsLive(at, ctx.fetchedAt)) continue;
    if (unlistedOccupancy(d)) recordSkipped(feed.id, "unknown_value");
    for (const subject of subjects) reader.read(subject, statusOf(d), at);
  }
  return reader.output();
}

/** The status-only reading of the reader's `dynamic.json`. */
export function parseEipaStatus(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  return eipaStatusReadings(feed, dynamicOf(rowsOf(payloads["status"])), index, ctx);
}
