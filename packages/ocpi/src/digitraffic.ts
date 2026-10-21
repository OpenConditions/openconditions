import { isRecord, normaliseLocation, normaliseTariff, OcpiDecodeError, text } from "./decode.js";
import type { OcpiLocation, OcpiTariff } from "./types.js";

export interface DigitrafficStatus {
  evseId: string;
  status: string;
  /** The operator's own timestamp, else the time Digitraffic last changed the record. */
  at?: string;
}

type Raw = Record<string, unknown>;

function snakeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!isRecord(value)) return value;
  const out: Raw = {};
  for (const [key, entry] of Object.entries(value)) out[snakeKey(key)] = snakeKeys(entry);
  return out;
}

function body(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch (error) {
    throw new OcpiDecodeError(`not JSON: ${(error as Error).message}`);
  }
}

function listIn(payload: Buffer, key: string): unknown[] {
  const parsed = body(payload);
  const list = isRecord(parsed) ? parsed[key] : undefined;
  if (!Array.isArray(list)) throw new OcpiDecodeError(`the payload carries no ${key} list`);
  return list;
}

function point(geometry: unknown): { latitude: number; longitude: number } | undefined {
  if (!isRecord(geometry) || !Array.isArray(geometry.coordinates)) return undefined;
  const [longitude, latitude] = geometry.coordinates;
  return typeof latitude === "number" && typeof longitude === "number"
    ? { latitude, longitude }
    : undefined;
}

function connectors(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((connector, index) => {
    const wire = snakeKeys(connector);
    return isRecord(wire) ? { ...wire, id: String(index + 1) } : wire;
  });
}

function evse(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  return {
    uid: raw.id,
    evse_id: raw.id,
    capabilities: raw.capabilities,
    floor_level: raw.floorLevel,
    coordinates: point(raw.geometry),
    physical_reference: raw.physicalReference,
    directions: raw.directions,
    parking_restrictions: raw.parkingRestrictions,
    parking: snakeKeys(raw.parking),
    accepted_service_providers: raw.acceptedServiceProviders,
    connectors: connectors(raw.connectors),
  };
}

/** Digitraffic's energy mix, its `environmentalImpact` OCPI's `environ_impact`. */
function energyMix(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { environmentalImpact, ...rest } = value;
  return { ...(snakeKeys(rest) as Raw), environ_impact: snakeKeys(environmentalImpact) };
}

/**
 * One Digitraffic GeoJSON feature as the OCPI location it describes. The
 * payload has no EVSE statuses (they come from the statuses endpoint) and no
 * connector ids, so a connector's id is its 1-based position on its EVSE.
 */
export function digitrafficLocation(feature: unknown): OcpiLocation {
  if (!isRecord(feature) || !isRecord(feature.properties)) {
    throw new OcpiDecodeError("a Digitraffic feature has no properties");
  }
  const properties = feature.properties;
  const operator = isRecord(properties.operator) ? properties.operator : {};
  const details = isRecord(operator.details) ? operator.details : {};
  const address = isRecord(properties.address) ? properties.address : {};
  return normaliseLocation({
    country_code: operator.countryCode,
    party_id: operator.partyId,
    id: properties.id,
    name: properties.name,
    address: address.street,
    city: address.city,
    postal_code: address.postalCode,
    country: address.countryCode,
    coordinates: point(feature.geometry),
    parking_type: properties.parkingType,
    evses: Array.isArray(properties.evses) ? properties.evses.map(evse) : [],
    parking_places: snakeKeys(properties.parkingPlaces),
    directions: properties.directions,
    operator:
      details.name === undefined
        ? undefined
        : { name: details.name, website: details.website, logo: details.logo },
    // Opening times are local to Finland, and the location names no zone.
    time_zone: "Europe/Helsinki",
    opening_times: snakeKeys(properties.openingTimes),
    charging_when_closed: properties.chargingWhenClosed,
    energy_mix: energyMix(properties.energyMix),
    help_phone: properties.helpPhone,
    last_updated: text(properties.modifiedAt),
  });
}

/**
 * The locations of a Digitraffic `locations/all` payload: the feature
 * collection (as a buffer or parsed) or its `features` array.
 */
export function fromDigitraffic(features: unknown): OcpiLocation[] {
  const parsed = Buffer.isBuffer(features) ? body(features) : features;
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.features : undefined;
  if (!Array.isArray(list)) throw new OcpiDecodeError("the payload carries no features list");
  return list.map(digitrafficLocation);
}

/**
 * The EVSE statuses of a `locations/statuses/all` payload; an entry without
 * an EVSE id or a status is passed to `malformed`.
 */
export function digitrafficStatuses(
  payload: Buffer,
  malformed: () => void = () => {},
): DigitrafficStatus[] {
  const statuses: DigitrafficStatus[] = [];
  for (const entry of listIn(payload, "statuses")) {
    const evseId = isRecord(entry) ? text(entry.evseId) : undefined;
    const status = isRecord(entry) ? text(entry.status)?.toUpperCase() : undefined;
    if (!isRecord(entry) || evseId === undefined || status === undefined) {
      malformed();
      continue;
    }
    const at = text(entry.lastUpdatedAt) ?? text(entry.modifiedAt);
    statuses.push(at === undefined ? { evseId, status } : { evseId, status, at });
  }
  return statuses;
}

/**
 * The tariffs of one page of the `tariffs` endpoint, with their real
 * `tariffAltText`; a tariff the decoder refuses is passed to `malformed`
 * rather than failing the page.
 */
export function digitrafficTariffs(
  payload: Buffer,
  malformed: () => void = () => {},
): OcpiTariff[] {
  const tariffs: OcpiTariff[] = [];
  for (const tariff of listIn(payload, "tariffs")) {
    try {
      tariffs.push(normaliseTariff(snakeKeys(tariff)));
    } catch (error) {
      if (!(error instanceof OcpiDecodeError)) throw error;
      malformed();
    }
  }
  return tariffs;
}
