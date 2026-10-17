import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import {
  CHARGING_BAY_DIRECTIONS,
  CHARGING_BAY_VEHICLE_TYPES,
  CONNECTOR_POWER_TYPES,
  CONNECTOR_STANDARDS,
  EVSE_BAY_POSITIONS,
  EVSE_PARKING_RESTRICTIONS,
  OCPI_EVSE_STATUSES,
  OCPI_FACILITIES,
  OCPI_IMAGE_CATEGORIES,
  OCPI_PARKING_TYPES,
} from "@openconditions/model-charging";
import {
  connectorPowerKw,
  decodeOcpiList,
  isRecord,
  normaliseLocation,
  normaliseTariff,
  type OcpdbSource,
  OcpiDecodeError,
  type OcpiEvse,
  type OcpiImage,
  type OcpiLocation,
  type OcpiOpeningTimes,
  type OcpiParking,
  type OcpiTariff,
  ocpdbAssociations,
  ocpdbSources,
  text,
} from "@openconditions/ocpi";
import { colocateSites } from "../colocate.js";
import { ocpiEnergyMix } from "../energy-mix.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours } from "../hours.js";
import { own, type Upstream } from "../records.js";
import {
  type BayInput,
  type BayPosition,
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  emi3Of,
  type ImageCategory,
  type ImageInput,
  instantIn,
  type Lifecycle,
  type ParkingType,
  type PowerType,
  type SiteInput,
  type StatusScheduleInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader } from "../status.js";
import { tariffDraft, tariffKeys, tariffUnreadValues, unreadableTariff } from "../tariff.js";

/** The live state a status payload gives an EVSE, by uid. */
export interface EvseState {
  status: string;
  /**
   * When the source last changed the status, as published (naive local time
   * is the publisher's): the reading's time, and its age limit.
   */
  at?: string;
}

/** What the OCPI mapping reads: the locations and what the other roles add to them. */
export interface OcpiInput {
  locations: OcpiLocation[];
  /**
   * Locations the decoder could not read and did not record a skip reason
   * for; `parseOcpi` records each under its reason and passes none.
   */
  rejected: number;
  /** Live states by EVSE uid, overriding the locations' own. */
  statuses: ReadonlyMap<string, EvseState>;
  tariffs: readonly OcpiTariff[];
  /** OCPDB: the tariff ids of each EVSE uid, which its connectors' own ids do not resolve to. */
  associations?: ReadonlyMap<string, string[]>;
  /** OCPDB: the upstream sources a location's `source` names. */
  sources?: ReadonlyMap<string, OcpdbSource>;
}

/** Publishers that write local time without a zone, and the zone they mean. */
const PUBLISHER_ZONES: Readonly<Record<string, string>> = { lt: "Europe/Vilnius" };

const STANDARDS = new Map<string, string>(CONNECTOR_STANDARDS.map((s) => [s.toUpperCase(), s]));
const POWER_TYPES: ReadonlySet<string> = new Set(CONNECTOR_POWER_TYPES);

/** States that say nothing live: a register's row, or a point not yet built. */
const NOT_LIVE = new Set(["STATIC", "PLANNED"]);

/** An EVSE state the mapping reads: one of OCPI's, or OCPDB's `STATIC`. */
const knownState = (status: string) => {
  const code = status.toUpperCase();
  return NOT_LIVE.has(code) || typeof own(OCPI_EVSE_STATUSES, code) === "string";
};

/** OCPI's parking restrictions, 2.3.0's included, as the EVSE model names them. */
const PARKING_RESTRICTIONS: ReadonlySet<string> = new Set(
  EVSE_PARKING_RESTRICTIONS.map((r) => r.toUpperCase()),
);

const BAY_VEHICLE_TYPES: ReadonlySet<string> = new Set(
  CHARGING_BAY_VEHICLE_TYPES.map((t) => t.toUpperCase()),
);
const BAY_DIRECTIONS: ReadonlySet<string> = new Set(
  CHARGING_BAY_DIRECTIONS.map((d) => d.toUpperCase()),
);
const BAY_POSITIONS: ReadonlySet<string> = new Set(EVSE_BAY_POSITIONS.map((p) => p.toUpperCase()));

/** The images of a record whose category OCPI defines; another category is counted in `unread`. */
function imagesOf(images: readonly OcpiImage[] | undefined, unread: () => void): ImageInput[] {
  return (images ?? []).flatMap((image) => {
    const category = own(OCPI_IMAGE_CATEGORIES, image.category);
    if (category === undefined) {
      unread();
      return [];
    }
    return [
      {
        url: image.url,
        category: category as ImageCategory,
        ...(image.thumbnail === undefined ? {} : { thumbnail: image.thumbnail }),
        ...(image.type === undefined ? {} : { format: image.type }),
        ...(image.width === undefined ? {} : { width: image.width }),
        ...(image.height === undefined ? {} : { height: image.height }),
      },
    ];
  });
}

/** A business's logo, which says whose logo it is by where it stands. */
const logoOf = (details: OcpiLocation["operator"], category: ImageCategory): ImageInput[] =>
  details?.logo === undefined
    ? []
    : [
        {
          url: details.logo.url,
          category,
          ...(details.logo.thumbnail === undefined ? {} : { thumbnail: details.logo.thumbnail }),
          ...(details.logo.type === undefined ? {} : { format: details.logo.type }),
          ...(details.logo.width === undefined ? {} : { width: details.logo.width }),
          ...(details.logo.height === undefined ? {} : { height: details.logo.height }),
        },
      ];

const displayTexts = (list: readonly { language: string; text: string }[] | undefined) =>
  (list ?? []).map((t) => ({ lang: t.language === "" ? "und" : t.language, text: t.text }));

/** A length OCPI gives in centimetres, in metres. */
const centimetres = (cm: number | undefined) =>
  cm === undefined ? undefined : { value: cm / 100, unit: "m" };

/**
 * A 2.3.0 parking place as a charging bay: lengths in metres, the weight in
 * kilograms, the time limit in minutes. A vehicle type or direction OCPI does
 * not define is left out and counted in `unread`.
 */
function bayOf(place: OcpiParking, unread: () => void): BayInput {
  const vehicleTypes = (place.vehicle_types ?? []).flatMap((t) => {
    if (BAY_VEHICLE_TYPES.has(t)) return [t.toLowerCase()];
    unread();
    return [];
  });
  const direction = place.direction;
  if (direction !== undefined && !BAY_DIRECTIONS.has(direction)) unread();
  const quantities: Record<string, { value: number; unit: string } | undefined> = {
    maxVehicleWeight:
      place.max_vehicle_weight === undefined
        ? undefined
        : { value: place.max_vehicle_weight, unit: "kg" },
    maxVehicleHeight: centimetres(place.max_vehicle_height),
    maxVehicleLength: centimetres(place.max_vehicle_length),
    maxVehicleWidth: centimetres(place.max_vehicle_width),
    length: centimetres(place.parking_space_length),
    width: centimetres(place.parking_space_width),
    timeLimit:
      place.time_limit === undefined ? undefined : { value: place.time_limit, unit: "min" },
  };
  const flags: Record<string, boolean | undefined> = {
    restrictedToType: place.restricted_to_type,
    reservationRequired: place.reservation_required,
    dangerousGoodsAllowed: place.dangerous_goods_allowed,
    driveThrough: place.drive_through,
    roofed: place.roofed,
    lighting: place.lighting,
    refrigerationOutlet: place.refrigeration_outlet,
  };
  return {
    key: place.id,
    ...(place.physical_reference === undefined
      ? {}
      : { physicalReference: place.physical_reference }),
    images: imagesOf(place.images, unread),
    details: {
      ...(vehicleTypes.length === 0 ? {} : { vehicleTypes: [...new Set(vehicleTypes)] }),
      ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)),
      ...Object.fromEntries(Object.entries(quantities).filter(([, v]) => v !== undefined)),
      ...(direction !== undefined && BAY_DIRECTIONS.has(direction)
        ? { direction: direction.toLowerCase() }
        : {}),
      ...(place.standards === undefined ? {} : { standards: place.standards }),
      ...(place.apds_reference === undefined ? {} : { apdsReference: place.apds_reference }),
    },
  };
}

/** OCPI 2.3.0 `ConnectorCapability` values: ISO 15118-2 and -20 Plug & Charge. */
const PLUG_AND_CHARGE: ReadonlySet<string> = new Set([
  "ISO_15118_2_PLUG_AND_CHARGE",
  "ISO_15118_20_PLUG_AND_CHARGE",
]);

/** OCPDB writes its sources' licences in words (`CC BY 4.0`, `CC-0`). */
function licenseId(written: string): string {
  const t = written.trim();
  if (/^CC[- ]?0\b/i.test(t)) return "CC0-1.0";
  const by = t.match(/^CC[- ]BY(?:[- ](SA))?[- ](\d\.\d)$/i);
  if (by !== null) return `CC-BY-${by[1] === undefined ? "" : "SA-"}${by[2]}`;
  return t;
}

function upstreamOf(
  uid: string,
  sources: ReadonlyMap<string, OcpdbSource> | undefined,
  recordId?: string,
): Upstream {
  const source = sources?.get(uid);
  return [
    {
      publisher: source?.contributor ?? source?.name ?? uid,
      ...(recordId === undefined ? {} : { recordId }),
      ...(source?.license === undefined ? {} : { license: licenseId(source.license) }),
    },
  ];
}

/**
 * A location's id within the feed: party-qualified (`NL*CKE*238`) where the
 * location names its party, since two parties may use one id.
 */
const stationIdOf = (loc: OcpiLocation) =>
  loc.country_code !== undefined && loc.party_id !== undefined
    ? `${loc.country_code}*${loc.party_id}*${loc.id}`
    : loc.id;

function hoursOf(times: OcpiOpeningTimes | undefined): string | undefined {
  if (times === undefined) return undefined;
  if (times.twentyfourseven) return "24/7";
  return osmOpeningHours(
    (times.regular_hours ?? []).map((h) => ({
      day: h.weekday,
      from: h.period_begin,
      to: h.period_end,
    })),
  );
}

/**
 * The tariff a connector of `loc` names by `id`: the only one with that id,
 * else the one of the location's own party (two parties may publish one id).
 */
function tariffResolver(tariffs: readonly OcpiTariff[]) {
  const byId = new Map<string, OcpiTariff[]>();
  for (const tariff of tariffs) byId.set(tariff.id, [...(byId.get(tariff.id) ?? []), tariff]);
  return (id: string, loc: OcpiLocation): OcpiTariff | undefined => {
    const candidates = byId.get(id) ?? [];
    if (candidates.length === 1) return candidates[0];
    return candidates.find(
      (t) =>
        t.party_id === loc.party_id &&
        (t.country_code === undefined || t.country_code === loc.country_code),
    );
  };
}

/**
 * A connector as the model holds it. A standard, format or power type OCPI
 * does not define is left out (an unknown standard is `UNKNOWN`) and counted
 * in `unread`; one the publisher did not set is not.
 */
function connectorOf(
  connector: OcpiEvse["connectors"][number],
  tariffIds: string[],
  unread: () => void,
): ConnectorInput {
  const format = connector.format?.toLowerCase();
  const powerType = connector.power_type?.toUpperCase();
  const power = connectorPowerKw(connector);
  const standard = STANDARDS.get(connector.standard?.toUpperCase() ?? "");
  if (connector.standard !== undefined && standard === undefined) unread();
  if (format !== undefined && format !== "socket" && format !== "cable") unread();
  if (powerType !== undefined && !POWER_TYPES.has(powerType)) unread();
  return {
    id: connector.id,
    standard: standard ?? "UNKNOWN",
    ...(format === "socket" || format === "cable" ? { format } : {}),
    ...(powerType !== undefined && POWER_TYPES.has(powerType)
      ? { powerType: powerType as PowerType }
      : {}),
    ...(power === undefined ? {} : { maxPowerKw: power }),
    ...(connector.max_voltage === undefined ? {} : { maxVoltage: connector.max_voltage }),
    ...(connector.max_amperage === undefined ? {} : { maxAmperage: connector.max_amperage }),
    ...(connector.terms_and_conditions === undefined
      ? {}
      : { termsUrl: connector.terms_and_conditions }),
    ...(tariffIds.length === 0 ? {} : { tariffIds }),
  };
}

/**
 * The planned statuses of an EVSE, its period read in the location's zone;
 * a status OCPI does not define is left out and counted in `unread`.
 */
function scheduleOf(evse: OcpiEvse, zone: string, unread: () => void): StatusScheduleInput[] {
  return (evse.status_schedule ?? []).flatMap((s) => {
    const status = own(OCPI_EVSE_STATUSES, s.status);
    const start = instantIn(zone, s.period_begin);
    const end = s.period_end === undefined ? undefined : instantIn(zone, s.period_end);
    if (typeof status !== "string") unread();
    if (typeof status !== "string" || start === undefined) return [];
    return [{ start, ...(end === undefined ? {} : { end }), status: status as EvseStatus }];
  });
}

/** A tariff with its validity read in the publisher's zone, as the offer carries it in UTC. */
const zonedTariff = (tariff: OcpiTariff, zone: string): OcpiTariff => {
  const start = instantIn(zone, tariff.start_date_time);
  const end = instantIn(zone, tariff.end_date_time);
  const { start_date_time: _start, end_date_time: _end, ...rest } = tariff;
  return {
    ...rest,
    ...(start === undefined ? {} : { start_date_time: start }),
    ...(end === undefined ? {} : { end_date_time: end }),
  };
};

/**
 * OCPI locations as charging sites: an EVSE per charge point (removed ones
 * left out, and a location whose points are all removed with them), its
 * connectors below it, the site's tariffs as offers its connectors name, and
 * a status reading per EVSE whose state is live, read as of its
 * `status_last_updated` (else `last_updated`; else the fetch). A
 * register's `STATIC` row and a `PLANNED` point have no live state: the
 * first is no reading, the second the EVSE's lifecycle; a status its source
 * last changed more than 30 days back is no reading either. Aggregated rows
 * (OCPDB) credit the upstream source they name, which also qualifies their
 * provider id. One operator's locations within 15 m are one site. The status
 * index names every EVSE that is neither removed nor planned by its uid. A
 * tariff with restrictions that cannot be read is no offer and no connector's
 * tariff, and is skipped once as `malformed`. An enumerated value OCPI does
 * not define, or the model has no place for, is left out and skipped as
 * `unknown_value`, a tariff's once however many sites name it.
 */
export function mapOcpi(
  feed: ChargingCatalogFeed,
  input: OcpiInput,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const resolve = tariffResolver(input.tariffs);
  const index: StatusIndexDraft = new Map();
  const seen = new Set<string>();
  const unreadable = new Set<OcpiTariff>();
  const inspected = new Set<OcpiTariff>();
  let unknown = 0;
  const unread = () => {
    unknown++;
  };
  for (const loc of input.locations) {
    if (loc.publish === false) continue;
    const stationId = stationIdOf(loc);
    if (seen.has(stationId)) continue;
    seen.add(stationId);
    const zone = PUBLISHER_ZONES[feed.region] ?? loc.time_zone ?? "UTC";
    const point: [number, number] = [loc.coordinates.longitude, loc.coordinates.latitude];

    const upstream =
      loc.source === undefined ? undefined : upstreamOf(loc.source, input.sources, loc.original_id);
    const evses: (OcpiEvse & { state?: EvseState })[] = [];
    for (const evse of loc.evses) {
      const own = ownState(evse);
      if (own !== undefined && !knownState(own.status)) unread();
      const state = input.statuses.get(evse.uid) ?? own;
      if (state?.status.toUpperCase() === "REMOVED") continue;
      evses.push(state === undefined ? evse : { ...evse, state });
      // A point being built takes its live state from the next full parse.
      if (state?.status.toUpperCase() === "PLANNED") continue;
      const read = own !== undefined && readable(own, zone, ctx.fetchedAt) ? own : undefined;
      indexStatus(index, evse.uid, {
        stationId,
        evseKey: evse.uid,
        point,
        timeZone: zone,
        ...(upstream === undefined ? {} : { upstream: structuredClone(upstream) }),
        ...(read === undefined
          ? {}
          : {
              snapshotStatus: read.status,
              ...(read.at === undefined ? {} : { snapshotAt: read.at }),
            }),
      });
    }
    // Every charge point taken away: the location is gone, as one not to be published.
    if (loc.evses.length > 0 && evses.length === 0) continue;

    // The site's tariffs, and per EVSE the ids its connectors name.
    const tariffs = new Map<string, OcpiTariff>();
    const named = (evse: OcpiEvse, connector: OcpiEvse["connectors"][number]) => {
      const ids = input.associations
        ? (input.associations.get(evse.uid) ?? [])
        : (connector.tariff_ids ?? []);
      return ids.flatMap((id) => {
        const tariff = resolve(id, loc);
        if (tariff === undefined) return [];
        tariffs.set(tariff.id, tariff);
        return [tariff.id];
      });
    };
    const evseInputs: EvseInput[] = evses.map((evse) => {
      const restrictions = (evse.parking_restrictions ?? []).flatMap((r) => {
        if (PARKING_RESTRICTIONS.has(r.toUpperCase())) return [r.toLowerCase()];
        unread();
        return [];
      });
      const bays = (evse.parking ?? []).map((p) => {
        const position = p.evse_position;
        if (position !== undefined && !BAY_POSITIONS.has(position)) unread();
        return {
          key: p.parking_id,
          ...(position !== undefined && BAY_POSITIONS.has(position)
            ? { position: position.toLowerCase() as BayPosition }
            : {}),
        };
      });
      const schedule = scheduleOf(evse, zone, unread);
      const images = imagesOf(evse.images, unread);
      const directions = displayTexts(evse.directions);
      return {
        key: evse.uid,
        ...(emi3Of(evse.evse_id) === undefined ? {} : { evseId: evse.evse_id }),
        ...(evse.uid === evse.evse_id ? {} : { uid: evse.uid }),
        ...(evse.state?.status.toUpperCase() === "PLANNED"
          ? { lifecycle: "planned" as Lifecycle }
          : {}),
        ...(evse.capabilities === undefined ? {} : { capabilities: evse.capabilities }),
        ...(restrictions.length === 0 ? {} : { parkingRestrictions: restrictions }),
        ...(evse.coordinates === undefined
          ? {}
          : { position: [evse.coordinates.longitude, evse.coordinates.latitude] }),
        ...(evse.floor_level === undefined ? {} : { floorLevel: evse.floor_level }),
        ...(evse.physical_reference === undefined
          ? {}
          : { physicalReference: evse.physical_reference }),
        ...(directions.length === 0 ? {} : { directions }),
        ...(schedule.length === 0 ? {} : { statusSchedule: schedule }),
        ...(bays.length === 0 ? {} : { bays }),
        ...(evse.accepted_service_providers === undefined
          ? {}
          : { acceptedServiceProviders: evse.accepted_service_providers }),
        ...(images.length === 0 ? {} : { images }),
        connectors: evse.connectors.map((c) => connectorOf(c, named(evse, c), unread)),
      };
    });
    // ISO 15118 Plug & Charge on any connector is a way to start charging at the site.
    const connectorCapabilities = evses.flatMap((e) =>
      e.connectors.flatMap((c) => c.capabilities ?? []),
    );
    const plugAndCharge = connectorCapabilities.some((c) => PLUG_AND_CHARGE.has(c));
    for (const capability of connectorCapabilities) if (!PLUG_AND_CHARGE.has(capability)) unread();

    const keys = tariffKeys(tariffs.keys());
    const offered = new Set<string>();
    for (const tariff of tariffs.values()) {
      if (!inspected.has(tariff)) {
        inspected.add(tariff);
        unknown += tariffUnreadValues(tariff);
      }
      if (unreadableTariff(tariff)) {
        unreadable.add(tariff);
        continue;
      }
      const offer = tariffDraft(feed, stationId, zonedTariff(tariff, zone), {
        fetchedAt: ctx.fetchedAt,
        point,
        key: keys.get(tariff.id) ?? tariff.id,
        ...(tariff.source === undefined
          ? {}
          : { upstream: upstreamOf(tariff.source, input.sources) }),
      });
      if (offer === undefined) continue;
      offered.add(tariff.id);
      out.offers.push(offer);
    }
    for (const evse of evseInputs) {
      for (const connector of evse.connectors) {
        const ids = (connector.tariffIds ?? []).flatMap((id) =>
          offered.has(id) ? [keys.get(id) ?? id] : [],
        );
        if (ids.length === 0) delete connector.tariffIds;
        else connector.tariffIds = ids;
      }
    }

    const operator = loc.operator;
    const amenities = (loc.facilities ?? []).flatMap((f) => {
      const amenity = own(OCPI_FACILITIES, f.toUpperCase());
      if (typeof amenity === "string") return [amenity];
      unread();
      return [];
    });
    const parkingType = own(OCPI_PARKING_TYPES, loc.parking_type?.toUpperCase());
    if (loc.parking_type !== undefined && parkingType === undefined) unread();
    const hours = hoursOf(loc.opening_times);
    // Exceptional periods are UTC, though a publisher writing naive local time means its own.
    const exceptions = [
      ...(loc.opening_times?.exceptional_openings ?? []).map((p) => ({ ...p, open: true })),
      ...(loc.opening_times?.exceptional_closings ?? []).map((p) => ({ ...p, open: false })),
    ].flatMap((p) => {
      const start = instantIn(PUBLISHER_ZONES[feed.region] ?? "UTC", p.period_begin);
      const end = instantIn(PUBLISHER_ZONES[feed.region] ?? "UTC", p.period_end);
      return start === undefined || end === undefined ? [] : [{ start, end, open: p.open }];
    });
    const images = [
      ...imagesOf(loc.images, unread),
      ...logoOf(loc.operator, "operator_logo"),
      ...logoOf(loc.owner, "owner_logo"),
      // The image categories name no suboperator's logo; it is another image of the site.
      ...logoOf(loc.suboperator, "other"),
    ];
    const bays = (loc.parking_places ?? []).map((p) => bayOf(p, unread));
    const energyMix = ocpiEnergyMix(loc.energy_mix, unread);
    const directions = displayTexts(loc.directions);
    const relatedLocations = (loc.related_locations ?? []).map((r) => ({
      point: [r.longitude, r.latitude] as [number, number],
      ...(r.name === undefined ? {} : { name: displayTexts([r.name]) }),
    }));
    const lifecycle: Lifecycle | undefined =
      evses.length > 0 && evseInputs.every((e) => e.lifecycle === "planned")
        ? "planned"
        : undefined;
    const site: SiteInput = {
      stationId,
      ...(upstream === undefined
        ? {}
        : { providerAuthority: `${feed.id}/${loc.source}`, upstream }),
      // A row relayed from the BNetzA register keeps the register's device id.
      ...(loc.source === "bnetza_api" && loc.original_id !== undefined
        ? { externalIds: [{ scheme: "bnetza", id: loc.original_id }] }
        : {}),
      point,
      ...(loc.name === undefined ? {} : { name: loc.name }),
      ...(operator === undefined
        ? {}
        : {
            operator: {
              name: operator.name,
              ...(operator.website === undefined ? {} : { website: operator.website }),
            },
          }),
      ...(loc.owner === undefined
        ? {}
        : {
            owner: {
              name: loc.owner.name,
              ...(loc.owner.website === undefined ? {} : { website: loc.owner.website }),
            },
          }),
      ...(loc.suboperator === undefined
        ? {}
        : {
            suboperator: {
              name: loc.suboperator.name,
              ...(loc.suboperator.website === undefined
                ? {}
                : { website: loc.suboperator.website }),
            },
          }),
      address: {
        street: loc.address,
        postalCode: loc.postal_code,
        city: loc.city,
        region: loc.state,
        country: loc.country ?? loc.country_code,
      },
      ...(hours === undefined ? {} : { openingHoursOsm: hours }),
      ...(exceptions.length === 0 ? {} : { openingExceptions: exceptions }),
      ...(loc.charging_when_closed === undefined
        ? {}
        : { chargingWhenClosed: loc.charging_when_closed }),
      ...(loc.time_zone === undefined ? {} : { timeZone: loc.time_zone }),
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(plugAndCharge ? { authentication: ["plug_and_charge" as const] } : {}),
      ...(parkingType === undefined ? {} : { parkingType: parkingType as ParkingType }),
      ...(amenities.length === 0 ? {} : { amenities }),
      ...(images.length === 0 ? {} : { images }),
      ...(energyMix === undefined ? {} : { energyMix }),
      ...(loc.help_phone === undefined ? {} : { hotline: loc.help_phone }),
      ...(directions.length === 0 ? {} : { directions }),
      ...(relatedLocations.length === 0 ? {} : { relatedLocations }),
      evses: evseInputs,
      ...(bays.length === 0 ? {} : { bays }),
    };
    out.features.push(siteDraft(feed, site, ctx.fetchedAt));
  }
  out.rejected = input.rejected;
  recordSkipped(feed.id, "malformed", unreadable.size);
  recordSkipped(feed.id, "unknown_value", unknown);
  out.statusIndex = index;
  colocateSites(out);
  out.observations = ocpiStatusReadings(feed, input.statuses, index, ctx).observations;
  return out;
}

/** The state an EVSE's location gives it itself, when it gives one. */
const ownState = (evse: OcpiEvse): EvseState | undefined =>
  evse.status === undefined
    ? undefined
    : { status: evse.status, at: evse.status_last_updated ?? evse.last_updated };

/** The reading's status of a live state still read at `fetchedAt`; undefined for none. */
function liveStatus(state: EvseState, zone: string, fetchedAt: string): EvseStatus | undefined {
  const code = state.status.toUpperCase();
  if (NOT_LIVE.has(code)) return undefined;
  const status = own(OCPI_EVSE_STATUSES, code);
  if (typeof status !== "string" || status === "removed") return undefined;
  if (!statusIsLive(instantIn(zone, state.at), fetchedAt)) return undefined;
  return status as EvseStatus;
}

const readable = (state: EvseState, zone: string, fetchedAt: string) =>
  liveStatus(state, zone, fetchedAt) !== undefined;

/**
 * A status reading per indexed EVSE whose live state is read: the status
 * role's by uid, else the state its location gave it, as of the time the
 * state carries (the fetch without one). A
 * register's `STATIC` row, a `PLANNED` or `REMOVED` point and a status last
 * changed more than 30 days back are no reading; a status of a uid the index
 * does not hold is rejected, and one OCPI does not define is skipped as
 * `unknown_value`.
 */
export function ocpiStatusReadings(
  feed: ChargingCatalogFeed,
  statuses: ReadonlyMap<string, EvseState>,
  index: StatusIndex,
  ctx: ParseContext,
): StatusOutput {
  const reader = statusReader(feed, ctx);
  for (const [uid, subjects] of index) {
    const role = statuses.get(uid);
    for (const subject of subjects) {
      const state =
        role ??
        (subject.snapshotStatus === undefined
          ? undefined
          : {
              status: subject.snapshotStatus,
              ...(subject.snapshotAt === undefined ? {} : { at: subject.snapshotAt }),
            });
      if (state === undefined) continue;
      const zone = subject.timeZone ?? "UTC";
      const status = liveStatus(state, zone, ctx.fetchedAt);
      if (status !== undefined) reader.read(subject, status, instantIn(zone, state.at));
    }
  }
  for (const uid of statuses.keys()) if (!index.has(uid)) reader.reject();
  recordSkipped(
    feed.id,
    "unknown_value",
    [...statuses.values()].filter((s) => !knownState(s.status)).length,
  );
  return reader.output();
}

/** The status-only reading of an OCPI feed's `status` role. */
export function parseOcpiStatus(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  return ocpiStatusReadings(feed, liveStatesOf(feed.id, payloads), index, ctx);
}

/** Reads every record of the list bodies, skipping those `read` refuses under the decoder's reason. */
function readAll<T>(feedId: string, bodies: readonly Buffer[], read: (raw: unknown) => T): T[] {
  const records: T[] = [];
  for (const body of bodies) {
    for (const raw of decodeOcpiList<unknown>(body)) {
      try {
        records.push(read(raw));
      } catch (error) {
        if (!(error instanceof OcpiDecodeError)) throw error;
        recordSkipped(feedId, error.reason);
      }
    }
  }
  return records;
}

/**
 * The live states of a poll by uid: the `status` list, then each answer of
 * `changes` since it, oldest first, so an EVSE's latest change stands.
 */
function liveStatesOf(feedId: string, payloads: FeedPayloads): Map<string, EvseState> {
  return statusesOf(feedId, [...(payloads["status"] ?? []), ...(payloads["changes"] ?? [])]);
}

/**
 * The bare EVSEs of a status endpoint (OCPDB's `evses`) as live states by
 * uid; an entry without a uid or status is skipped as `malformed`.
 */
function statusesOf(feedId: string, bodies: readonly Buffer[]): Map<string, EvseState> {
  const states = new Map<string, EvseState>();
  for (const body of bodies) {
    for (const raw of decodeOcpiList<unknown>(body)) {
      const uid = isRecord(raw) ? (text(raw["uid"]) ?? text(raw["evse_id"])) : undefined;
      const status = isRecord(raw) ? text(raw["status"])?.toUpperCase() : undefined;
      if (!isRecord(raw) || uid === undefined || status === undefined) {
        recordSkipped(feedId, "malformed");
        continue;
      }
      const at = text(raw["status_last_updated"]) ?? text(raw["last_updated"]);
      states.set(uid, at === undefined ? { status } : { status, at });
    }
  }
  return states;
}

/** The tariff ids of each EVSE across the pages of the associations endpoint. */
function associationsOf(bodies: readonly Buffer[]): Map<string, string[]> {
  const byEvse = new Map<string, string[]>();
  for (const page of bodies.map(ocpdbAssociations)) {
    for (const [uid, ids] of page) {
      byEvse.set(uid, [...new Set([...(byEvse.get(uid) ?? []), ...ids])]);
    }
  }
  return byEvse;
}

/**
 * An OCPI 2.2/2.3 feed: `main` the locations (bare list, `{data}` or
 * `{items}` pages), and optionally `status` live EVSE states by uid,
 * `tariffs`, and OCPDB's `associations` and `sources`. A location or
 * tariff the decoder refuses is skipped under its reason: `no_geometry`
 * without usable coordinates, else `malformed`.
 */
export function parseOcpi(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const main = payloads["main"] ?? [];
  if (main.length === 0) return emptyParseOutput();
  const associations = payloads["associations"];
  const sources = payloads["sources"];
  return mapOcpi(
    feed,
    {
      locations: readAll(feed.id, main, normaliseLocation),
      rejected: 0,
      statuses: liveStatesOf(feed.id, payloads),
      tariffs: readAll(feed.id, payloads["tariffs"] ?? [], normaliseTariff),
      ...(associations === undefined || associations.length === 0
        ? {}
        : { associations: associationsOf(associations) }),
      ...(sources === undefined || sources.length === 0
        ? {}
        : { sources: new Map(sources.flatMap((body) => [...ocpdbSources(body)])) }),
    },
    ctx,
  );
}
