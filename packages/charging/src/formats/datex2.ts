import {
  type DatexEnergyConnector,
  type DatexEnergyOpeningHours,
  type DatexEnergyRate,
  type DatexEnergySite,
  type DatexEnergyStatus,
  parseDatexEnergyStatus,
  parseDatexEnergyTable,
  parseXmlDocument,
} from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
  type StatusSubject,
} from "@openconditions/ingest-framework";
import type { AUTHENTICATION_METHODS } from "@openconditions/model";
import {
  DATEX2_CONNECTOR_FORMATS,
  DATEX2_CONNECTOR_STANDARDS,
  DATEX2_REFILL_POINT_STATUSES,
} from "@openconditions/model-charging";
import type { OcpiTariff } from "@openconditions/ocpi";
import { colocateSites } from "../colocate.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours } from "../hours.js";
import { detached } from "../records.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  instantIn,
  type PowerType,
  type SiteInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";
import { tariffDraft, tariffKeys } from "../tariff.js";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * The OCPI dimension a rate line prices: a session fee is flat; a price per
 * unit under a per-delivery-unit policy is per kilowatt-hour, the unit an
 * electric charging point delivers when it states none. A price per unit of
 * charging time names no time unit in DATEX, so it is not read.
 */
function dimensionOf(policy: string | undefined, line: DatexEnergyRate["lines"][number]) {
  if (line.type === "flatRate") return "FLAT";
  if (line.type === "perUnit" && policy === "pricePerDeliveryUnit") {
    return line.unit === undefined || line.unit === "kWh" ? "ENERGY" : undefined;
  }
  return undefined;
}

const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number]>> = {
  rfid: "rfid",
  apps: "app",
  creditCard: "credit_card",
  debitCard: "debit_card",
  nfc: "nfc",
  plugAndCharge: "plug_and_charge",
};

/** The power a charging mode names: `mode3AC3p` is three-phase AC, `mode4DC` DC. */
function powerTypeOf(mode: string | undefined): PowerType | undefined {
  if (mode === undefined) return undefined;
  if (/DC$/i.test(mode) || mode === "chademo") return "DC";
  if (/AC3p$/i.test(mode)) return "AC_3_PHASE";
  if (/AC1p$/i.test(mode)) return "AC_1_PHASE";
  return undefined;
}

function connectorOf(c: DatexEnergyConnector, i: number, tariffIds: string[]): ConnectorInput {
  const standard = DATEX2_CONNECTOR_STANDARDS[c.type];
  const format = c.format === undefined ? undefined : DATEX2_CONNECTOR_FORMATS[c.format];
  const powerType = powerTypeOf(c.chargingMode);
  return {
    id: String(i + 1),
    standard: typeof standard === "string" ? standard : "UNKNOWN",
    ...(format === "socket" || format === "cable" ? { format } : {}),
    ...(powerType === undefined ? {} : { powerType }),
    ...(c.maxPowerW === undefined ? {} : { maxPowerKw: Math.round(c.maxPowerW) / 1000 }),
    ...(c.voltage === undefined ? {} : { maxVoltage: c.voltage }),
    ...(c.maxCurrentA === undefined ? {} : { maxAmperage: c.maxCurrentA }),
    ...(tariffIds.length === 0 ? {} : { tariffIds }),
  };
}

function hoursOf(hours: DatexEnergyOpeningHours | undefined): string | undefined {
  if (hours === undefined) return undefined;
  if (hours.twentyFourSeven) return "24/7";
  return osmOpeningHours(
    hours.periods.flatMap((p) =>
      p.days.map((day) => ({ day: WEEKDAYS.indexOf(day) + 1, from: p.from, to: p.to })),
    ),
  );
}

/**
 * A rate table as the OCPI tariff it is: one priced element of its lines,
 * each priced by its own line type. A table with a line that cannot be
 * priced (a minimum, a maximum, a time price) is no tariff: part of a price
 * is a wrong price.
 */
function tariffOf(id: string, rate: DatexEnergyRate): OcpiTariff | undefined {
  const components = rate.lines.map((line) => {
    const type = dimensionOf(rate.pricingPolicy, line);
    return type === undefined ? undefined : { type, price: line.value };
  });
  if (components.length === 0 || components.some((c) => c === undefined)) return undefined;
  return {
    id,
    currency: rate.currency,
    elements: [{ price_components: components as { type: string; price: number }[] }],
  };
}

/** A site serves only bicycles when every vehicle type it names is one. */
const bicyclesOnly = (site: DatexEnergySite) =>
  site.vehicleTypes !== undefined &&
  site.vehicleTypes.length > 0 &&
  site.vehicleTypes.every((t) => t === "bicycle");

/**
 * A DATEX II v3 energy infrastructure table (`main`) and, optionally, its
 * status publication (`status`): a site per energy infrastructure site, an
 * EVSE per refill point with its connectors, an offer per rate table that
 * the point's connectors name, and a reading per refill point status, as of
 * the fetch. A refill point's id may be unique only within its station
 * (Lithuania numbers them), so a status is joined on site, station and point.
 * A planned point has no live state but its lifecycle; a removed one is no
 * charge point, and a site of removed points no site; a status last changed
 * more than 30 days back is no reading. DATEX does not say whether a rate
 * includes VAT, so its offers do not either. One operator's sites within
 * 15 m are one site.
 */
export function parseDatex2(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const main = payloads["main"] ?? [];
  if (main.length === 0) return out;
  const sites = main.flatMap((body) => parseDatexEnergyTable(parseXmlDocument(body)));
  // A status names its refill point by site, station and point, or by the
  // bare point id where that is unique in the table.
  const points = new Map<string, number>();
  for (const station of sites.flatMap((s) => s.stations)) {
    for (const refill of station.points) points.set(refill.id, (points.get(refill.id) ?? 0) + 1);
  }
  const unique = (pointId: string) => points.get(pointId) === 1;
  const statuses = statusesOf(payloads["status"] ?? []);
  const statusOf = (siteId: string, stationId: string, pointId: string) =>
    statuses.get(pointKey(siteId, stationId, pointId)) ??
    (unique(pointId) ? statuses.get(pointKey(undefined, undefined, pointId)) : undefined);
  const index: StatusIndexDraft = new Map();
  const seen = new Set<string>();
  let rejected = 0;
  for (const site of sites) {
    if (bicyclesOnly(site)) continue;
    if (site.point === undefined) {
      rejected++;
      continue;
    }
    if (seen.has(site.id)) continue;
    seen.add(site.id);
    const point = site.point;
    const stationId = site.id;
    const evseKeys = new Set<string>();
    const tariffs = new Map<string, OcpiTariff>();
    const evses: EvseInput[] = [];
    const subjects: [keys: string[], subject: StatusSubject][] = [];
    let listed = 0;
    for (const station of site.stations) {
      for (const refill of station.points) {
        listed++;
        const status = statusOf(site.id, station.id, refill.id);
        const value =
          status === undefined ? undefined : DATEX2_REFILL_POINT_STATUSES[status.status];
        // A point taken away is no charge point any more.
        if (value === "removed") continue;
        let key = refill.emi3 ?? refill.id;
        if (evseKeys.has(key)) key = `${station.id}-${refill.id}`;
        evseKeys.add(key);
        const tariffIds = refill.rates.flatMap((rate, i) => {
          const tariff = tariffOf(rate.id ?? `${key}-${i + 1}`, rate);
          if (tariff === undefined) return [];
          tariffs.set(tariff.id, tariff);
          return [tariff.id];
        });
        evses.push({
          key,
          ...(refill.emi3 === undefined ? {} : { evseId: refill.emi3 }),
          ...(value === "planned" ? { lifecycle: "planned" as const } : {}),
          connectors: refill.connectors.map((c, i) => connectorOf(c, i, tariffIds)),
        });
        // A point not yet built takes its live state from the next full parse.
        if (value === "planned") continue;
        // The document's own strings would keep it alive as long as the index.
        subjects.push([
          [
            detached(pointKey(site.id, station.id, refill.id)),
            ...(unique(refill.id) ? [detached(pointKey(undefined, undefined, refill.id))] : []),
          ],
          { stationId: detached(stationId), evseKey: detached(key), point },
        ]);
      }
    }
    // Every charge point taken away: the site is gone.
    if (listed > 0 && evses.length === 0) continue;
    for (const [keys, subject] of subjects) {
      for (const k of keys) indexStatus(index, k, subject);
    }
    const keys = tariffKeys(tariffs.keys());
    const offered = new Set<string>();
    for (const tariff of tariffs.values()) {
      const offer = tariffDraft(feed, stationId, tariff, {
        fetchedAt: ctx.fetchedAt,
        point,
        key: keys.get(tariff.id) ?? tariff.id,
      });
      if (offer === undefined) continue;
      const { priceIncludesVat: _unstated, ...stated } = offer;
      out.offers.push(stated);
      offered.add(tariff.id);
    }
    for (const evse of evses) {
      for (const connector of evse.connectors) {
        const ids = (connector.tariffIds ?? []).flatMap((id) =>
          offered.has(id) ? [keys.get(id) ?? id] : [],
        );
        if (ids.length === 0) delete connector.tariffIds;
        else connector.tariffIds = ids;
      }
    }
    const name = site.names[0];
    const authentication = [
      ...new Set(
        site.stations.flatMap((s) =>
          s.authMethods.flatMap((m) => {
            const method = AUTHENTICATION[m];
            return method === undefined ? [] : [method];
          }),
        ),
      ),
    ];
    const hours = hoursOf(site.openingHours);
    const input: SiteInput = {
      stationId,
      point,
      ...(name === undefined ? {} : { name: name.value, lang: name.lang }),
      ...(site.operator?.name === undefined ? {} : { operator: { name: site.operator.name } }),
      ...(site.address === undefined ? {} : { address: site.address }),
      ...(hours === undefined ? {} : { openingHoursOsm: hours }),
      ...(authentication.length === 0 ? {} : { authentication }),
      evses,
    };
    out.features.push(siteDraft(feed, input, ctx.fetchedAt));
  }
  out.rejected = rejected;
  out.statusIndex = index;
  colocateSites(out);
  out.observations = datexStatusReadings(feed, statuses, index, ctx).observations;
  return out;
}

/**
 * The key a status names its refill point by: site, station and point, or
 * the bare point id (a key of its own) where the status names no more.
 */
const pointKey = (siteId: string | undefined, stationId: string | undefined, pointId: string) =>
  siteId !== undefined && stationId !== undefined
    ? `${siteId}|${stationId}|${pointId}`
    : `|${pointId}`;

function statusesOf(bodies: readonly Buffer[]): Map<string, DatexEnergyStatus> {
  const statuses = new Map<string, DatexEnergyStatus>();
  for (const body of bodies) {
    for (const status of parseDatexEnergyStatus(parseXmlDocument(body))) {
      statuses.set(pointKey(status.siteId, status.stationId, status.refillPointId), status);
    }
  }
  return statuses;
}

/**
 * A reading per indexed refill point with a live status, as of its site
 * status's `lastUpdated`: the status naming its site, station and point, else the one naming the
 * bare point where that is unique in the table (the index holds the bare
 * key only then). A point that is removed or planned has no live state, nor
 * has a status last changed more than 30 days back; a status the index does
 * not place is rejected.
 */
function datexStatusReadings(
  feed: ChargingCatalogFeed,
  statuses: ReadonlyMap<string, DatexEnergyStatus>,
  index: StatusIndex,
  ctx: ParseContext,
): StatusOutput {
  const reader = statusReader(feed, ctx);
  const chosen = new Map<StatusSubject, DatexEnergyStatus>();
  const bare: [StatusSubject, DatexEnergyStatus][] = [];
  for (const [key, status] of statuses) {
    const subjects = subjectsOf(index, key);
    if (subjects.length === 0) reader.reject();
    for (const subject of subjects) {
      if (key.startsWith("|")) bare.push([subject, status]);
      else chosen.set(subject, status);
    }
  }
  for (const [subject, status] of bare) if (!chosen.has(subject)) chosen.set(subject, status);
  for (const [subject, status] of chosen) {
    const value = DATEX2_REFILL_POINT_STATUSES[status.status];
    if (typeof value !== "string" || value === "planned" || value === "removed") continue;
    const at = instantIn("UTC", status.at);
    if (!statusIsLive(at, ctx.fetchedAt)) continue;
    reader.read(subject, value as EvseStatus, at);
  }
  return reader.output();
}

/** The status-only reading of a DATEX II energy infrastructure status publication. */
export function parseDatex2Status(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  return datexStatusReadings(feed, statusesOf(payloads["status"] ?? []), index, ctx);
}
