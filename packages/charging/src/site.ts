import type { ParseContext, RecordDraft } from "@openconditions/ingest-framework";
import {
  type AUDIENCES,
  type AUTHENTICATION_METHODS,
  type ExternalId,
  type IMAGE_CATEGORIES,
  type LIFECYCLES,
  observationId,
  type PAYMENT_METHODS,
  zonedWallClockToInstant,
} from "@openconditions/model";
import {
  type CHARGING_PARKING_TYPES,
  type CONNECTOR_POWER_TYPES,
  CONNECTOR_STANDARDS,
  type EVSE_BAY_POSITIONS,
  EVSE_PARKING_RESTRICTIONS,
  type EVSE_STATUSES,
} from "@openconditions/model-charging";
import { normaliseEmi3 } from "@openconditions/ocpi";
import { z } from "zod";
import { alpha2 } from "./countries.js";
import { type EnergyMixInput, energyMixDraft } from "./energy-mix.js";
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
export type ImageCategory = (typeof IMAGE_CATEGORIES)[number];
export type BayPosition = (typeof EVSE_BAY_POSITIONS)[number];
/** The connector model's charging modes: IEC 61851-1's four and CHAdeMO's. */
const CHARGING_MODES = ["mode1", "mode2", "mode3", "mode4", "chademo"] as const;
export type ChargingMode = (typeof CHARGING_MODES)[number];
const MODES: ReadonlySet<string> = new Set(CHARGING_MODES);

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
  /** IEC 61851-1 charging modes (`mode3`), or `chademo`. */
  chargingModes?: ChargingMode[];
  /** The operator's terms and conditions for the plug. */
  termsUrl?: string;
  /** The source's ids of the tariffs that apply here; they become the offers' ids. */
  tariffIds?: string[];
}

/** A text in one language; `und` when the source does not say which. */
export interface TextInput {
  lang: string;
  text: string;
}

/** A link to an image as the source publishes it. */
export interface ImageInput {
  url: string;
  category: ImageCategory;
  thumbnail?: string;
  format?: string;
  width?: number;
  height?: number;
}

/** A planned status of a charge point over a period, as the operator publishes it. */
export interface StatusScheduleInput {
  /** UTC instants. */
  start: string;
  end?: string;
  status: EvseStatus;
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
  wheelchairAccessible?: boolean;
  /** `[lon, lat]` of the charge point itself. */
  position?: [number, number];
  floorLevel?: string;
  /** What is printed on the charge point to tell it apart. */
  physicalReference?: string;
  directions?: TextInput[];
  statusSchedule?: StatusScheduleInput[];
  /** The bays (by `BayInput.key`) a vehicle charging here stands in. */
  bays?: { key: string; position?: BayPosition }[];
  acceptedServiceProviders?: string[];
  manufacturer?: string;
  images?: ImageInput[];
  connectors: ConnectorInput[];
}

/** A parking place a vehicle stands in while it charges. */
export interface BayInput {
  /** The source's id of the bay, unique within the site. */
  key: string;
  physicalReference?: string;
  images?: ImageInput[];
  /** The `charging_bay` details, as the model holds them. */
  details: Record<string, unknown>;
}

/** An organisation as the source names it, with what it publishes of how to reach it. */
export interface OrganisationInput {
  name: string;
  website?: string;
  wikidata?: string;
  phone?: string;
  email?: string;
  /** Its ids in registers (`siren`). */
  ids?: ExternalId[];
}

export interface SiteAddress {
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
  /** The state, province or region. */
  region?: string;
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
  operator?: OrganisationInput;
  owner?: OrganisationInput;
  suboperator?: OrganisationInput;
  brand?: string;
  website?: string;
  address?: SiteAddress;
  /** Codes of the administrative areas the site lies in (`insee`). */
  geocodes?: { scheme: string; code: string }[];
  /** Opening hours in the OSM `opening_hours` grammar. */
  openingHoursOsm?: string;
  /** Opening hours as the publisher wrote them. */
  openingHoursText?: string;
  twentyFourSeven?: boolean;
  /** Periods, UTC instants, the site opens or closes beside its regular hours. */
  openingExceptions?: { start: string; end: string; open: boolean }[];
  /**
   * Whether a vehicle plugged in keeps charging while the site is closed;
   * held with the opening hours, since without them no period is closed.
   */
  chargingWhenClosed?: boolean;
  /** The IANA zone the opening hours are in. */
  timeZone?: string;
  /** Who may charge, only as the source states it. */
  audience?: (typeof AUDIENCES)[number];
  payment?: (typeof PAYMENT_METHODS)[number][];
  authentication?: (typeof AUTHENTICATION_METHODS)[number][];
  /** Whether a driver may book a charge point ahead. */
  reservation?: boolean;
  lifecycle?: Lifecycle;
  parkingType?: ParkingType;
  roofed?: boolean;
  /** Whether a driver may charge paying for the session alone, without a contract. */
  adHocCharging?: boolean;
  hotline?: string;
  /** `[lon, lat]` of the entrance, where the site lies within a larger facility. */
  entrance?: [number, number];
  directions?: TextInput[];
  /** Points beside the site a driver needs: an entrance, a car park's access. */
  relatedLocations?: { point: [number, number]; name?: TextInput[] }[];
  energyMix?: EnergyMixInput;
  calibrationLaw?: string;
  dynamicInfoAvailable?: "true" | "false" | "auto";
  hubOperatorId?: string;
  images?: ImageInput[];
  /** A tariff as the publisher wrote it, where it is not broken into priced elements. */
  tariffText?: string;
  notes?: string;
  amenities?: string[];
  /** The upstream publishers an aggregator took the site from. */
  upstream?: Upstream;
  evses: EvseInput[];
  bays?: BayInput[];
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
    region: clean(address.region),
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
const PARKING_RESTRICTIONS: ReadonlySet<string> = new Set(EVSE_PARKING_RESTRICTIONS);

const positive = (n: number | undefined) =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;

/** Texts as the model holds them, the blank ones left out; undefined for none. */
function texts(list: readonly TextInput[] | undefined) {
  const out = (list ?? []).flatMap((t) => {
    const text = clean(t.text);
    return text === undefined ? [] : [{ lang: clean(t.lang)?.toLowerCase() || "und", text }];
  });
  return out.length === 0 ? undefined : out;
}

/** Image links as the model holds them: web URLs only, each once. */
function imagesOf(list: readonly ImageInput[] | undefined) {
  const seen = new Set<string>();
  const out = (list ?? []).flatMap((image) => {
    const url = webUrl(image.url);
    if (url === undefined || seen.has(url)) return [];
    seen.add(url);
    const thumbnail = webUrl(image.thumbnail);
    const format = clean(image.format)?.toLowerCase();
    const size = (n: number | undefined) =>
      n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
    const width = size(image.width);
    const height = size(image.height);
    return [
      {
        url,
        category: image.category,
        ...(thumbnail === undefined ? {} : { thumbnail }),
        ...(format === undefined ? {} : { format }),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      },
    ];
  });
  return out.length === 0 ? undefined : out;
}

const pointGeometry = (point: [number, number]) => ({
  type: "Point",
  coordinates: [point[0], point[1]],
});

/** An organisation as the model holds it, in `role`; undefined without a name. */
function organisation(org: OrganisationInput | undefined, role: string, lang: string) {
  const name = clean(org?.name);
  if (org === undefined || name === undefined) return undefined;
  const website = webUrl(org.website);
  const wikidata = clean(org.wikidata);
  const phone = clean(org.phone);
  const email = clean(org.email);
  const ids = [
    ...(wikidata === undefined ? [] : [{ scheme: "wikidata", id: wikidata }]),
    ...(org.ids ?? []).map((e) => ({ ...e })),
  ];
  return {
    role,
    name: [{ lang, text: name }],
    ...(ids.length === 0 ? {} : { ids }),
    ...(website === undefined ? {} : { website }),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined || !EMAIL.safeParse(email).success ? {} : { email }),
  };
}

/** What the model takes for an e-mail address. */
const EMAIL = z.email();

/** A bay's component key: `bay:<key>`, apart from every charge point's. */
export const bayKey = (key: string) => `bay:${key.trim().replace(/[#/]/g, "_")}`;

const currentOf = (c: ConnectorInput): "ac" | "dc" | undefined =>
  c.current ?? (c.powerType === undefined ? undefined : c.powerType === "DC" ? "dc" : "ac");

const POINT_ORDER = new Intl.Collator("en", { numeric: true });

/** Charge points by their EVSE id (else their key), so a register listing them in another order states the same site. */
function byEvse(a: EvseInput, b: EvseInput): number {
  const [ka, kb] = [evseKey(a.key), evseKey(b.key)];
  return (
    POINT_ORDER.compare(clean(a.evseId) ?? ka, clean(b.evseId) ?? kb) || POINT_ORDER.compare(ka, kb)
  );
}

/**
 * The EVSE components and, below each, its connectors keyed
 * `<evseKey>/<connectorId>`, in the order of their ids. A repeated key keeps
 * the first.
 */
function evseComponents(
  feed: ChargingFeed,
  stationId: string,
  evses: readonly EvseInput[],
  listedBays: ReadonlySet<string>,
): RecordDraft[] {
  const seen = new Set<string>(listedBays);
  const out: RecordDraft[] = [];
  for (const evse of [...evses].sort(byEvse)) {
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
    const floorLevel = clean(evse.floorLevel);
    const physicalReference = clean(evse.physicalReference);
    const images = imagesOf(evse.images);
    const directions = texts(evse.directions);
    const schedule = (evse.statusSchedule ?? []).filter(
      (s) => s.end === undefined || Date.parse(s.end) > Date.parse(s.start),
    );
    // A bay the site does not list is no bay to name.
    const bays = [
      ...new Map(
        (evse.bays ?? [])
          .filter((b) => listedBays.has(bayKey(b.key)))
          .map((b) => [
            b.key,
            { key: bayKey(b.key), ...(b.position === undefined ? {} : { position: b.position }) },
          ]),
      ).values(),
    ];
    const providers = [
      ...new Set((evse.acceptedServiceProviders ?? []).flatMap((p) => clean(p) ?? [])),
    ];
    const manufacturer = clean(evse.manufacturer);
    out.push({
      key,
      kind: "evse",
      ...(evse.position === undefined ? {} : { position: pointGeometry(evse.position) }),
      ...(physicalReference === undefined ? {} : { physicalReference }),
      ...(floorLevel === undefined ? {} : { floorLevel }),
      ...(emi3 === "" ? {} : { externalIds: [{ scheme: "emi3:evse", id: emi3 }] }),
      ...(evse.lifecycle === undefined ? {} : { lifecycle: evse.lifecycle }),
      ...(images === undefined ? {} : { images }),
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
        ...(evse.wheelchairAccessible === undefined
          ? {}
          : { wheelchairAccessible: evse.wheelchairAccessible }),
        ...(directions === undefined ? {} : { directions }),
        ...(bays.length === 0 ? {} : { bays }),
        ...(providers.length === 0 ? {} : { acceptedServiceProviders: providers }),
        ...(manufacturer === undefined ? {} : { manufacturer }),
        ...(schedule.length === 0 ? {} : { statusSchedule: schedule.map((s) => ({ ...s })) }),
      },
    });
    for (const connector of [...evse.connectors].sort((a, b) => POINT_ORDER.compare(a.id, b.id))) {
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
      const modes = [...new Set(connector.chargingModes ?? [])].filter((m) => MODES.has(m));
      const termsUrl = webUrl(connector.termsUrl);
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
          ...(modes.length === 0 ? {} : { chargingModes: modes }),
          ...(termsUrl === undefined ? {} : { termsUrl }),
          ...(tariffRefs.length === 0 ? {} : { tariffRefs }),
        },
      });
    }
  }
  return out;
}

/** The `charging_bay` components, keyed `bay:<key>`, in the order of their keys. A repeated key keeps the first. */
function bayComponents(bays: readonly BayInput[]): RecordDraft[] {
  const seen = new Set<string>();
  const out: RecordDraft[] = [];
  for (const bay of [...bays].sort((a, b) => POINT_ORDER.compare(a.key, b.key))) {
    const key = bayKey(bay.key);
    if (bay.key.trim() === "" || seen.has(key)) continue;
    seen.add(key);
    const physicalReference = clean(bay.physicalReference);
    const images = imagesOf(bay.images);
    out.push({
      key,
      kind: "charging_bay",
      ...(physicalReference === undefined ? {} : { physicalReference }),
      ...(images === undefined ? {} : { images }),
      details: { kind: "charging_bay", v: 1, ...structuredClone(bay.details) },
    });
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
  const bays = bayComponents(input.bays ?? []);
  const components = [
    ...evseComponents(
      feed,
      input.stationId,
      input.evses,
      new Set(bays.map((b) => b.key as string)),
    ),
    ...bays,
  ];
  const name = text(input.name);
  const description = text(input.notes);
  const operator = organisation(input.operator, "operator", lang);
  const owner = organisation(input.owner, "owner", lang);
  const suboperator = organisation(input.suboperator, "suboperator", lang);
  const openingHoursOsm =
    clean(input.openingHoursOsm) ?? (input.twentyFourSeven === true ? "24/7" : undefined);
  const exceptions = (input.openingExceptions ?? []).filter(
    (e) => Date.parse(e.end) > Date.parse(e.start),
  );
  const timeZone = clean(input.timeZone);
  const payment = [...new Set(input.payment ?? [])];
  const authentication = [...new Set(input.authentication ?? [])];
  const access =
    input.audience !== undefined ||
    payment.length > 0 ||
    authentication.length > 0 ||
    input.reservation !== undefined
      ? {
          audience: input.audience ?? "unknown",
          ...(payment.length === 0 ? {} : { payment }),
          ...(authentication.length === 0 ? {} : { authentication }),
          ...(input.reservation === undefined ? {} : { reservation: input.reservation }),
        }
      : undefined;
  const amenities = [...new Set((input.amenities ?? []).filter((a) => a.trim() !== ""))];
  const images = imagesOf(input.images);
  const brand = clean(input.brand);
  const website = webUrl(input.website);
  const tariffText = text(input.tariffText);
  const openingHoursText = text(input.openingHoursText);
  const hotline = clean(input.hotline);
  const directions = texts(input.directions);
  const relatedLocations = (input.relatedLocations ?? []).map((r) => {
    const named = texts(r.name);
    return { ...(named === undefined ? {} : { name: named }), point: pointGeometry(r.point) };
  });
  const energyMix = energyMixDraft(input.energyMix);
  const calibrationLaw = clean(input.calibrationLaw);
  const hubOperatorId = clean(input.hubOperatorId);
  const geocodes = (input.geocodes ?? []).filter((g) => clean(g.code) !== undefined);
  return {
    id: siteId(feed, input.stationId),
    class: "feature",
    kind: "charging_site",
    temporality: "static",
    lifecycle: input.lifecycle ?? "operational",
    location: {
      ...pointLocation(input.point),
      ...(address === undefined ? {} : { address }),
      ...(country === undefined
        ? {}
        : {
            admin: {
              country,
              ...(geocodes.length === 0 ? {} : { geocodes: geocodes.map((g) => ({ ...g })) }),
            },
          }),
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
    ...(operator === undefined ? {} : { operator }),
    ...(owner === undefined ? {} : { owner }),
    ...(openingHoursOsm === undefined
      ? {}
      : {
          openingHours: {
            osm: openingHoursOsm,
            ...(openingHoursOsm === "24/7" ? { twentyFourSeven: true } : {}),
            ...(exceptions.length === 0 ? {} : { exceptions: exceptions.map((e) => ({ ...e })) }),
            ...(input.chargingWhenClosed === undefined
              ? {}
              : { chargingWhenClosed: input.chargingWhenClosed }),
            ...(timeZone === undefined ? {} : { timezone: timeZone }),
          },
        }),
    ...(access === undefined ? {} : { access }),
    ...(amenities.length === 0 ? {} : { amenities }),
    ...(images === undefined ? {} : { images }),
    ...(components.length === 0 ? {} : { components }),
    details: {
      kind: "charging_site",
      v: 1,
      ...(input.parkingType === undefined ? {} : { parkingType: input.parkingType }),
      ...(input.roofed === undefined ? {} : { roofed: input.roofed }),
      ...(energyMix === undefined ? {} : { energyMix }),
      ...(suboperator === undefined ? {} : { suboperator }),
      ...(hotline === undefined ? {} : { hotline }),
      ...(input.adHocCharging === undefined ? {} : { adHocCharging: input.adHocCharging }),
      ...(input.entrance === undefined ? {} : { entrance: pointGeometry(input.entrance) }),
      ...(directions === undefined ? {} : { directions }),
      ...(relatedLocations.length === 0 ? {} : { relatedLocations }),
      ...(calibrationLaw === undefined ? {} : { calibrationLaw }),
      ...(input.dynamicInfoAvailable === undefined
        ? {}
        : { dynamicInfoAvailable: input.dynamicInfoAvailable }),
      ...(hubOperatorId === undefined ? {} : { hubOperatorId }),
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
  r: {
    stationId: string;
    status: EvseStatus;
    at?: string;
    point?: [number, number];
    upstream?: Upstream;
  },
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
    provenance: provenance(feed, r.stationId, r.upstream),
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
    upstream?: Upstream;
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
    upstream?: Upstream;
    at?: string;
    point?: [number, number];
  },
  ctx: ReadingContext,
): RecordDraft {
  const key = connectorKey(r.evseKey, r.connectorId);
  return statusReading(feed, r, "charging.connector_status", key, ctx);
}
