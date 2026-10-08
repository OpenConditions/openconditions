import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { AUTHENTICATION_METHODS, PAYMENT_METHODS } from "@openconditions/model";
import { CONNECTOR_STANDARDS } from "@openconditions/model-charging";
import type { OcpiTariff } from "@openconditions/ocpi";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  emi3Of,
  instantIn,
  parsePowerKw,
  type SiteInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";
import { tariffDraft } from "../tariff.js";
import { isRecord, placeAt, type Raw, text } from "./raw.js";

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

/** The dictionary's `connector_interface` names by id. */
function interfacesOf(dictionary: Raw[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const table of dictionary) {
    const list = table["connector_interface"];
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
 * An interface name (`IEC-62196-T2-F-CABLE`) as a connector standard and,
 * where the name says it, whether the plug is a socket or a cable.
 */
function plugOf(name: string | undefined): { standard: string; format?: "socket" | "cable" } {
  if (name === undefined) return { standard: "UNKNOWN" };
  const underscored = name.replace(/-/g, "_").toUpperCase();
  const suffix = underscored.match(CABLE_SUFFIX);
  const base = suffix?.[1] ?? underscored;
  const format = suffix === null ? undefined : suffix[2] === undefined ? "cable" : "socket";
  return {
    standard: STANDARDS.has(base) ? base : "UNKNOWN",
    ...(format === undefined ? {} : { format }),
  };
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

/** Not operating is out of order; an operating point is free or occupied. */
function statusOf(d: Dynamic): EvseStatus {
  if (d.availability === 0) return "out_of_order";
  if (d.occupancy === 1) return "available";
  if (d.occupancy === 0) return "occupied";
  return "unknown";
}

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

const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number]>> = {
  "0": "none",
  "2": "rfid",
};

const PAYMENTS: Readonly<Record<string, readonly (typeof PAYMENT_METHODS)[number][]>> = {
  "1": ["free"],
  "2": ["membership"],
  "4": ["credit_card", "debit_card"],
  "8": ["app"],
};

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
 * they become offers on the site that its connectors reference.
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
  const interfaces = interfacesOf(rowsOf(payloads["dictionary"]));
  const dynamic = dynamicOf(rowsOf(payloads["status"]));

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
  let rejected = 0;
  const seen = new Set<string>();
  for (const pool of pools) {
    const poolId = idOf(pool["id"]);
    const own = poolId === undefined ? undefined : stationsOf.get(poolId);
    if (poolId === undefined || own === undefined || seen.has(poolId)) continue;
    seen.add(poolId);
    const fallback = own.find(
      (s) => placeAt(Number(s["latitude"]), Number(s["longitude"])) !== undefined,
    );
    const point =
      placeAt(Number(pool["latitude"]), Number(pool["longitude"])) ??
      (fallback === undefined
        ? undefined
        : placeAt(Number(fallback["latitude"]), Number(fallback["longitude"])));
    if (point === undefined) {
      rejected++;
      continue;
    }

    const operator = operators.get(idOf(pool["operator_id"]) ?? "");
    const operatorName = text(pool["operator_name"]) ?? text(operator?.["name"]);
    const operatorSite = text(pool["operator_website"]) ?? text(operator?.["website"]);

    const evses: EvseInput[] = [];
    const tariffs = new Map<string, OcpiTariff>();
    for (const station of own) {
      for (const p of pointsOf.get(idOf(station["id"]) ?? "") ?? []) {
        const pointId = idOf(p["id"]);
        if (pointId === undefined) continue;
        const code = text(p["code"]);
        // The register writes its eMI3 ids with hyphens; the standard separator is `*`.
        const evseId = emi3Of(code?.replace(/-/g, "*"));
        const key = evseId ?? pointId;
        const d = dynamic.get(pointId);
        const tariff = adHocTariff(d);
        if (tariff !== undefined) tariffs.set(tariff.id, tariff);
        const connectors: ConnectorInput[] = (Array.isArray(p["connectors"]) ? p["connectors"] : [])
          .filter(isRecord)
          .flatMap((entry, k) => {
            const kw = parsePowerKw(entry["power"]);
            const attached =
              typeof entry["cable_attached"] === "boolean" ? entry["cable_attached"] : undefined;
            return list(entry["interfaces"]).map((interfaceId): ConnectorInput => {
              const plug = plugOf(interfaces.get(interfaceId));
              const format =
                plug.format ?? (attached === undefined ? undefined : attached ? "cable" : "socket");
              return {
                id: `${k + 1}.${interfaceId}`,
                standard: plug.standard,
                ...(format === undefined ? {} : { format }),
                ...(kw === undefined ? {} : { maxPowerKw: kw }),
                ...(tariff === undefined ? {} : { tariffIds: [tariff.id] }),
              };
            });
          });
        evses.push({ key, ...(evseId === undefined ? {} : { evseId }), connectors });
        indexStatus(index, pointId, { stationId: poolId, evseKey: key, point });
      }
    }

    const authentication = [
      ...new Set(
        own.flatMap((s) =>
          list(s["authentication_methods"]).flatMap((a) => AUTHENTICATION[a] ?? []),
        ),
      ),
    ];
    const payment = [
      ...new Set(own.flatMap((s) => list(s["payment_methods"]).flatMap((m) => PAYMENTS[m] ?? []))),
    ];
    const osm = hoursOf(pool);
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
              ...(operatorSite === undefined ? {} : { website: operatorSite }),
            },
          }),
      address: {
        street: text(pool["street"]),
        houseNumber: [text(pool["house_number"]), text(pool["house_number_addition"])]
          .filter((v) => v !== undefined)
          .join(""),
        postalCode: text(pool["postal_code"]),
        city: text(pool["city"]),
      },
      ...(osm === undefined ? {} : { openingHoursOsm: osm }),
      ...(authentication.length === 0 ? {} : { authentication }),
      ...(payment.length === 0 ? {} : { payment }),
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
  out.rejected = rejected;
  out.statusIndex = index;
  out.observations = eipaStatusReadings(feed, dynamic, index, ctx).observations;
  return out;
}

/**
 * A reading per indexed point of `dynamic.json`, as of its status time (`ts`),
 * and none when that lies more than 30 days back; a point the index does not
 * hold is rejected. Its prices are the full parse's: they change offers.
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
