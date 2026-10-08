import type { ParseContext, RecordDraft } from "@openconditions/ingest-framework";
import {
  type AUDIENCES,
  type AUTHENTICATION_METHODS,
  type ExternalId,
  type LIFECYCLES,
  observationId,
  type PAYMENT_METHODS,
  zonedWallClockToInstant,
} from "@openconditions/model";
import {
  type CHARGING_PARKING_TYPES,
  type CONNECTOR_POWER_TYPES,
  CONNECTOR_STANDARDS,
  type EVSE_STATUSES,
} from "@openconditions/model-charging";
import { normaliseEmi3 } from "@openconditions/ocpi";
import { alpha2 } from "./countries.js";
import {
  type ChargingFeed,
  clean,
  freshness,
  pointLocation,
  provenance,
  siteId,
  UNLOCATED,
  type Upstream,
  utcInstant,
  webUrl,
} from "./records.js";
import { tariffOfferId } from "./tariff.js";

export { type ChargingFeed, siteId, utcInstant } from "./records.js";

export type PowerType = (typeof CONNECTOR_POWER_TYPES)[number];
export type Lifecycle = (typeof LIFECYCLES)[number];
export type EvseStatus = (typeof EVSE_STATUSES)[number];
export type ParkingType = (typeof CHARGING_PARKING_TYPES)[number];

/** One plug or socket of a charge point. */
export interface ConnectorInput {
  /** The source's id of the connector, unique within its charge point. */
  id: string;
  /** A `connector_standard` value; one the model does not know is `UNKNOWN`. */
  standard: string;
  format?: "socket" | "cable";
  powerType?: PowerType;
  /** Set when the source says AC or DC; else derived from `powerType`. */
  current?: "ac" | "dc";
  maxPowerKw?: number;
  maxVoltage?: number;
  maxAmperage?: number;
  /** The source's ids of the tariffs that apply here; they become the offers' ids. */
  tariffIds?: string[];
}

/** One charge point, or `quantity` identical ones the source does not tell apart. */
export interface EvseInput {
  /** The component key: the OCPI uid, else the eMI3 id, else the source's own point id. */
  key: string;
  /** The eMI3 id as published. */
  evseId?: string;
  uid?: string;
  quantity?: number;
  lifecycle?: Lifecycle;
  capabilities?: string[];
  parkingRestrictions?: string[];
  connectors: ConnectorInput[];
}

export interface SiteAddress {
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
  /** ISO 3166-1 alpha-2 or alpha-3; else the feed's region. */
  country?: string;
  text?: string;
}

export interface SiteInput {
  /** The source's own id of the site. */
  stationId: string;
  /**
   * Who issued `stationId`: the feed (default), or `<feedId>/<upstream>` for
   * an aggregator that names its upstream source, so two upstream sources of
   * one aggregator may still link.
   */
  providerAuthority?: string;
  /** False when the site carries no `provider` id: its source's ids are external ids already. */
  providerId?: false;
  /** `[lon, lat]`. */
  point: [number, number];
  name?: string;
  /** The language of the source's texts (BCP 47); `und` when unknown. */
  lang?: string;
  /** Ids beside the provider id that linking matches on (`ocpi:location`, `osm:node`). */
  externalIds?: ExternalId[];
  operator?: { name: string; website?: string; wikidata?: string };
  owner?: { name: string };
  brand?: string;
  website?: string;
  address?: SiteAddress;
  /** Opening hours in the OSM `opening_hours` grammar. */
  openingHoursOsm?: string;
  /** Opening hours as the publisher wrote them. */
  openingHoursText?: string;
  twentyFourSeven?: boolean;
  /** Who may charge, only as the source states it. */
  audience?: (typeof AUDIENCES)[number];
  payment?: (typeof PAYMENT_METHODS)[number][];
  authentication?: (typeof AUTHENTICATION_METHODS)[number][];
  lifecycle?: Lifecycle;
  parkingType?: ParkingType;
  /** A tariff as the publisher wrote it, where it is not broken into priced elements. */
  tariffText?: string;
  notes?: string;
  amenities?: string[];
  /** The upstream publishers an aggregator took the site from. */
  upstream?: Upstream;
  evses: EvseInput[];
}

/** What a reading takes from the poll. */
export type ReadingContext = Pick<ParseContext, "fetchedAt">;

/** ISO country, operator, `E`, the outlet id: an eMI3 EVSE id once its separators are gone. */
const EMI3 = /^[A-Z]{2}[A-Z0-9]{3}E[A-Z0-9]{1,31}$/;

/** `id` as published when it is an eMI3 EVSE id; a source's own point id is not. */
export const emi3Of = (id: string | undefined): string | undefined =>
  id !== undefined && EMI3.test(normaliseEmi3(id)) ? id : undefined;

/** A status its source last changed longer ago than this no longer reads as live. */
const MAX_STATUS_AGE_SEC = 30 * 86400;

/**
 * Whether a status the source last changed at `changedAt` (a UTC instant)
 * is still read at the poll: unless its own time lies more than 30 days
 * back, when it is register data rather than a live state. A status without
 * a readable time is read.
 */
export function statusIsLive(changedAt: string | undefined, fetchedAt: string): boolean {
  const changed = changedAt === undefined ? Number.NaN : Date.parse(changedAt);
  if (!Number.isFinite(changed)) return true;
  return Date.parse(fetchedAt) - changed <= MAX_STATUS_AGE_SEC * 1000;
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/;

/**
 * The UTC instant of a publisher's timestamp. A time with an offset (`Z`,
 * `+01:00`, or `+0100` as some feeds write it) is taken as given; a time
 * without one is wall-clock time in the publisher's `timeZone`, fractional
 * seconds kept. A space may stand for the `T`. Undefined when unreadable.
 */
export function instantIn(timeZone: string, value: unknown): string | undefined {
  const t = typeof value === "string" ? value.trim() : "";
  const iso = t
    .replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso)) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? utcInstant(new Date(ms)) : undefined;
  }
  const m = iso.match(WALL_CLOCK);
  const at = m?.[1] === undefined ? null : zonedWallClockToInstant(timeZone, m[1]);
  if (at === null) return undefined;
  const fraction = m?.[2] === undefined ? 0 : Math.round(Number(`0${m[2]}`) * 1000);
  return utcInstant(new Date(at.getTime() + fraction));
}

/**
 * A power in kW from a number or a text with its unit (`"11000 W"`,
 * `"22 kW"`, `"22,0"`); a bare value is in `bareUnit`. Undefined unless it is
 * a positive number.
 */
export function parsePowerKw(value: unknown, bareUnit: "kW" | "W" = "kW"): number | undefined {
  let amount: number;
  let unit: string = bareUnit;
  if (typeof value === "number") amount = value;
  else if (typeof value === "string") {
    const m = value.match(/^\s*(\d+(?:[.,]\d+)?)\s*(kw|w)?\s*$/i);
    if (m?.[1] === undefined) return undefined;
    amount = Number(m[1].replace(",", "."));
    if (m[2] !== undefined) unit = m[2].toLowerCase() === "kw" ? "kW" : "W";
  } else return undefined;
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return unit === "W" ? Math.round(amount) / 1000 : amount;
}

/** The country a feed's region names; none for `eu` and `global`. */
function countryOf(feed: ChargingFeed): string | undefined {
  return /^[a-z]{2}$/.test(feed.region) && feed.region !== "eu"
    ? feed.region.toUpperCase()
    : undefined;
}

function addressOf(address: SiteAddress | undefined, country: string | undefined) {
  if (country === undefined || address === undefined) return undefined;
  const parts = {
    street: clean(address.street),
    houseNumber: clean(address.houseNumber),
    postalCode: clean(address.postalCode),
    city: clean(address.city),
    text: clean(address.text),
  };
  const written = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
  return Object.keys(written).length === 0 ? undefined : { ...written, country };
}

/**
 * A charge point's component key as the model holds it: `#` separates a
 * subject from its component and `/` a charge point from its connector, so
 * neither stays in it.
 */
export const evseKey = (key: string) => key.trim().replace(/[#/]/g, "_");

/** A connector's component key: `<evseKey>/<connectorId>`, the parts as the model holds them. */
export const connectorKey = (evse: string, connectorId: string) =>
  `${evseKey(evse)}/${connectorId.trim().replace(/#/g, "_")}`;

const STANDARDS: ReadonlySet<string> = new Set(CONNECTOR_STANDARDS);
const PARKING_RESTRICTIONS: ReadonlySet<string> = new Set([
  "ev_only",
  "plugged",
  "disabled",
  "customers",
  "motorcycles",
]);

const positive = (n: number | undefined) =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;

const currentOf = (c: ConnectorInput): "ac" | "dc" | undefined =>
  c.current ?? (c.powerType === undefined ? undefined : c.powerType === "DC" ? "dc" : "ac");

/**
 * The EVSE components and, below each, its connectors keyed
 * `<evseKey>/<connectorId>`. A repeated key keeps the first.
 */
function evseComponents(
  feed: ChargingFeed,
  stationId: string,
  evses: readonly EvseInput[],
): RecordDraft[] {
  const seen = new Set<string>();
  const out: RecordDraft[] = [];
  for (const evse of evses) {
    const key = evseKey(evse.key);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    // Every format's EVSE id passes the one eMI3 check: component linking matches on it.
    const evseId = emi3Of(clean(evse.evseId));
    const emi3 = evseId === undefined ? "" : normaliseEmi3(evseId);
    const quantity = evse.quantity;
    const capabilities = [...new Set((evse.capabilities ?? []).filter((c) => c.trim() !== ""))];
    const restrictions = [
      ...new Set((evse.parkingRestrictions ?? []).filter((r) => PARKING_RESTRICTIONS.has(r))),
    ];
    out.push({
      key,
      kind: "evse",
      ...(evse.lifecycle === undefined ? {} : { lifecycle: evse.lifecycle }),
      ...(emi3 === "" ? {} : { externalIds: [{ scheme: "emi3:evse", id: emi3 }] }),
      details: {
        kind: "evse",
        v: 1,
        ...(evseId === undefined ? {} : { evseId }),
        ...(clean(evse.uid) === undefined ? {} : { uid: clean(evse.uid) }),
        ...(quantity !== undefined && Number.isInteger(quantity) && quantity >= 2
          ? { quantity }
          : {}),
        ...(capabilities.length === 0 ? {} : { capabilities }),
        ...(restrictions.length === 0 ? {} : { parkingRestrictions: restrictions }),
      },
    });
    for (const connector of evse.connectors) {
      if (connector.id.trim() === "") continue;
      const childKey = connectorKey(key, connector.id);
      if (seen.has(childKey)) continue;
      seen.add(childKey);
      const current = currentOf(connector);
      const tariffRefs = [
        ...new Set((connector.tariffIds ?? []).map((t) => tariffOfferId(feed, stationId, t))),
      ];
      const power = positive(connector.maxPowerKw);
      const voltage = positive(connector.maxVoltage);
      const amperage = positive(connector.maxAmperage);
      out.push({
        key: childKey,
        parentKey: key,
        kind: "connector",
        details: {
          kind: "connector",
          v: 1,
          standard: STANDARDS.has(connector.standard) ? connector.standard : "UNKNOWN",
          ...(connector.format === undefined ? {} : { format: connector.format }),
          ...(connector.powerType === undefined ? {} : { powerType: connector.powerType }),
          ...(current === undefined ? {} : { current }),
          ...(voltage === undefined ? {} : { maxVoltage: voltage }),
          ...(amperage === undefined ? {} : { maxAmperage: amperage }),
          ...(power === undefined ? {} : { maxPowerKw: power }),
          ...(tariffRefs.length === 0 ? {} : { tariffRefs }),
        },
      });
    }
  }
  return out;
}

/**
 * A `charging_site` feature with its charge points and their connectors as
 * components. It carries its provider id unless the input says otherwise, so
 * two sites of one source never link; a site without a stated lifecycle is
 * operational.
 */
export function siteDraft(feed: ChargingFeed, input: SiteInput, fetchedAt: string): RecordDraft {
  const lang = input.lang ?? "und";
  const text = (value: string | undefined) => {
    const t = clean(value);
    return t === undefined ? undefined : [{ lang, text: t }];
  };
  const country = alpha2(input.address?.country) ?? countryOf(feed);
  const address = addressOf(input.address, country);
  const components = evseComponents(feed, input.stationId, input.evses);
  const name = text(input.name);
  const description = text(input.notes);
  const operatorName = text(input.operator?.name);
  const operatorSite = webUrl(input.operator?.website);
  const wikidata = clean(input.operator?.wikidata);
  const ownerName = text(input.owner?.name);
  const openingHoursOsm =
    clean(input.openingHoursOsm) ?? (input.twentyFourSeven === true ? "24/7" : undefined);
  const payment = [...new Set(input.payment ?? [])];
  const authentication = [...new Set(input.authentication ?? [])];
  const access =
    input.audience !== undefined || payment.length > 0 || authentication.length > 0
      ? {
          audience: input.audience ?? "unknown",
          ...(payment.length === 0 ? {} : { payment }),
          ...(authentication.length === 0 ? {} : { authentication }),
        }
      : undefined;
  const amenities = [...new Set((input.amenities ?? []).filter((a) => a.trim() !== ""))];
  const brand = clean(input.brand);
  const website = webUrl(input.website);
  const tariffText = text(input.tariffText);
  const openingHoursText = text(input.openingHoursText);
  return {
    id: siteId(feed, input.stationId),
    class: "feature",
    kind: "charging_site",
    temporality: "static",
    lifecycle: input.lifecycle ?? "operational",
    location: {
      ...pointLocation(input.point),
      ...(address === undefined ? {} : { address }),
      ...(country === undefined ? {} : { admin: { country } }),
    },
    provenance: provenance(feed, input.stationId, input.upstream),
    freshness: freshness(feed, fetchedAt),
    externalIds: [
      ...(input.providerId === false
        ? []
        : [
            {
              scheme: "provider",
              id: input.stationId,
              authority: input.providerAuthority ?? feed.id,
            },
          ]),
      ...(input.externalIds ?? []).map((e) => ({ ...e })),
    ],
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(operatorName === undefined
      ? {}
      : {
          operator: {
            role: "operator",
            name: operatorName,
            ...(wikidata === undefined ? {} : { ids: [{ scheme: "wikidata", id: wikidata }] }),
            ...(operatorSite === undefined ? {} : { website: operatorSite }),
          },
        }),
    ...(ownerName === undefined ? {} : { owner: { role: "owner", name: ownerName } }),
    ...(openingHoursOsm === undefined
      ? {}
      : {
          openingHours: {
            osm: openingHoursOsm,
            ...(openingHoursOsm === "24/7" ? { twentyFourSeven: true } : {}),
          },
        }),
    ...(access === undefined ? {} : { access }),
    ...(amenities.length === 0 ? {} : { amenities }),
    ...(components.length === 0 ? {} : { components }),
    details: {
      kind: "charging_site",
      v: 1,
      ...(input.parkingType === undefined ? {} : { parkingType: input.parkingType }),
      ...(brand === undefined ? {} : { brand }),
      ...(website === undefined ? {} : { website }),
      ...(tariffText === undefined ? {} : { tariffText }),
      ...(openingHoursText === undefined ? {} : { openingHoursText }),
    },
  };
}

/**
 * A status reading of a charge point or one of its connectors, as of `at`,
 * the time its source gives the status; as of the fetch where the source
 * gives none (or one after the fetch). It states no validity: a status is
 * written when it changes and holds while its feed polls, which the read
 * computes from the source's last successful poll.
 */
function statusReading(
  feed: ChargingFeed,
  r: { stationId: string; status: EvseStatus; at?: string; point?: [number, number] },
  property: string,
  key: string,
  ctx: ReadingContext,
): RecordDraft {
  const fetched = Date.parse(ctx.fetchedAt);
  const stated = r.at === undefined ? Number.NaN : Date.parse(r.at);
  const at = Number.isFinite(stated) ? Math.min(stated, fetched) : fetched;
  const draft = {
    class: "observation",
    kind: "observation",
    property,
    temporality: "live",
    location: r.point === undefined ? { ...UNLOCATED } : pointLocation(r.point),
    provenance: provenance(feed, r.stationId),
    freshness: freshness(feed, ctx.fetchedAt),
    subject: {
      kind: "feature",
      featureId: siteId(feed, r.stationId),
      componentKey: key,
    },
    result: { type: "category", value: r.status, vocabulary: "evse_status" },
    phenomenonTime: { instant: utcInstant(new Date(at)) },
    aggregation: "instantaneous",
  };
  return { id: observationId(feed.id, draft as never), ...draft };
}

/** `charging.evse_status`: what a charge point is doing. */
export function evseStatusDraft(
  feed: ChargingFeed,
  r: {
    stationId: string;
    evseKey: string;
    status: EvseStatus;
    /** When the source last changed the status, a UTC instant; the fetch without it. */
    at?: string;
    /** The site's `[lon, lat]`; unlocated without it. */
    point?: [number, number];
  },
  ctx: ReadingContext,
): RecordDraft {
  return statusReading(feed, r, "charging.evse_status", evseKey(r.evseKey), ctx);
}

/**
 * `charging.connector_status`: what one connector is doing, where the source
 * reports per plug. The subject is the component `siteDraft` keys from the
 * same EVSE key and connector id.
 */
export function connectorStatusDraft(
  feed: ChargingFeed,
  r: {
    stationId: string;
    evseKey: string;
    connectorId: string;
    status: EvseStatus;
    at?: string;
    point?: [number, number];
  },
  ctx: ReadingContext,
): RecordDraft {
  const key = connectorKey(r.evseKey, r.connectorId);
  return statusReading(feed, r, "charging.connector_status", key, ctx);
}
