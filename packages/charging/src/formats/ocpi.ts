import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import {
  CONNECTOR_POWER_TYPES,
  CONNECTOR_STANDARDS,
  OCPI_EVSE_STATUSES,
  OCPI_FACILITIES,
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
  type OcpiLocation,
  type OcpiOpeningTimes,
  type OcpiTariff,
  ocpdbAssociations,
  ocpdbSources,
  text,
} from "@openconditions/ocpi";
import { colocateSites } from "../colocate.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours } from "../hours.js";
import type { Upstream } from "../records.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  emi3Of,
  instantIn,
  type Lifecycle,
  type ParkingType,
  type PowerType,
  type SiteInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader } from "../status.js";
import { tariffDraft, tariffKeys } from "../tariff.js";

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
  /** Locations the decoder could not read. */
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

function connectorOf(
  connector: OcpiEvse["connectors"][number],
  tariffIds: string[],
): ConnectorInput {
  const format = connector.format?.toLowerCase();
  const powerType = connector.power_type?.toUpperCase();
  const power = connectorPowerKw(connector);
  return {
    id: connector.id,
    standard: STANDARDS.get(connector.standard?.toUpperCase() ?? "") ?? "UNKNOWN",
    ...(format === "socket" || format === "cable" ? { format } : {}),
    ...(powerType !== undefined && POWER_TYPES.has(powerType)
      ? { powerType: powerType as PowerType }
      : {}),
    ...(power === undefined ? {} : { maxPowerKw: power }),
    ...(connector.max_voltage === undefined ? {} : { maxVoltage: connector.max_voltage }),
    ...(connector.max_amperage === undefined ? {} : { maxAmperage: connector.max_amperage }),
    ...(tariffIds.length === 0 ? {} : { tariffIds }),
  };
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
 * index names every EVSE that is neither removed nor planned by its uid.
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
  for (const loc of input.locations) {
    if (loc.publish === false) continue;
    const stationId = stationIdOf(loc);
    if (seen.has(stationId)) continue;
    seen.add(stationId);
    const zone = PUBLISHER_ZONES[feed.region] ?? loc.time_zone ?? "UTC";
    const point: [number, number] = [loc.coordinates.longitude, loc.coordinates.latitude];

    const evses: (OcpiEvse & { state?: EvseState })[] = [];
    for (const evse of loc.evses) {
      const own = ownState(evse);
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
    const evseInputs: EvseInput[] = evses.map((evse) => ({
      key: evse.uid,
      ...(emi3Of(evse.evse_id) === undefined ? {} : { evseId: evse.evse_id }),
      ...(evse.uid === evse.evse_id ? {} : { uid: evse.uid }),
      ...(evse.state?.status.toUpperCase() === "PLANNED"
        ? { lifecycle: "planned" as Lifecycle }
        : {}),
      ...(evse.capabilities === undefined ? {} : { capabilities: evse.capabilities }),
      ...(evse.parking_restrictions === undefined
        ? {}
        : { parkingRestrictions: evse.parking_restrictions.map((r) => r.toLowerCase()) }),
      connectors: evse.connectors.map((c) => connectorOf(c, named(evse, c))),
    }));

    const upstream =
      loc.source === undefined ? undefined : upstreamOf(loc.source, input.sources, loc.original_id);
    const keys = tariffKeys(tariffs.keys());
    const offered = new Set<string>();
    for (const tariff of tariffs.values()) {
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

    // The feature holds one operator organisation, so a suboperator has no place.
    const operator = loc.operator;
    const amenities = (loc.facilities ?? []).flatMap((f) => {
      const amenity = OCPI_FACILITIES[f.toUpperCase()];
      return typeof amenity === "string" ? [amenity] : [];
    });
    const parkingType = OCPI_PARKING_TYPES[loc.parking_type?.toUpperCase() ?? ""];
    const hours = hoursOf(loc.opening_times);
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
      ...(loc.owner === undefined ? {} : { owner: { name: loc.owner.name } }),
      address: {
        street: loc.address,
        postalCode: loc.postal_code,
        city: loc.city,
        country: loc.country ?? loc.country_code,
      },
      ...(hours === undefined ? {} : { openingHoursOsm: hours }),
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(parkingType === undefined ? {} : { parkingType: parkingType as ParkingType }),
      ...(amenities.length === 0 ? {} : { amenities }),
      evses: evseInputs,
    };
    out.features.push(siteDraft(feed, site, ctx.fetchedAt));
  }
  out.rejected = input.rejected;
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
  const status = OCPI_EVSE_STATUSES[code];
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
 * does not hold is rejected.
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
  return reader.output();
}

/** The status-only reading of an OCPI feed's `status` role. */
export function parseOcpiStatus(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  return ocpiStatusReadings(feed, statusesOf(payloads["status"] ?? []), index, ctx);
}

/** Reads every record of the list bodies, counting those `read` refuses. */
function readAll<T>(
  bodies: readonly Buffer[],
  read: (raw: unknown) => T,
): { records: T[]; rejected: number } {
  const records: T[] = [];
  let rejected = 0;
  for (const body of bodies) {
    for (const raw of decodeOcpiList<unknown>(body)) {
      try {
        records.push(read(raw));
      } catch (error) {
        if (!(error instanceof OcpiDecodeError)) throw error;
        rejected++;
      }
    }
  }
  return { records, rejected };
}

/** The bare EVSEs of a status endpoint (OCPDB's `evses`) as live states by uid. */
function statusesOf(bodies: readonly Buffer[]): Map<string, EvseState> {
  const states = new Map<string, EvseState>();
  for (const body of bodies) {
    for (const raw of decodeOcpiList<unknown>(body)) {
      if (!isRecord(raw)) continue;
      const uid = text(raw["uid"]) ?? text(raw["evse_id"]);
      const status = text(raw["status"])?.toUpperCase();
      if (uid === undefined || status === undefined) continue;
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
 * `tariffs`, and OCPDB's `associations` and `sources`.
 */
export function parseOcpi(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const main = payloads["main"] ?? [];
  if (main.length === 0) return emptyParseOutput();
  const locations = readAll(main, normaliseLocation);
  const associations = payloads["associations"];
  const sources = payloads["sources"];
  return mapOcpi(
    feed,
    {
      locations: locations.records,
      rejected: locations.rejected,
      statuses: statusesOf(payloads["status"] ?? []),
      tariffs: readAll(payloads["tariffs"] ?? [], normaliseTariff).records,
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
