import {
  type Cell,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { AUDIENCES } from "@openconditions/model";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import {
  type ConnectorInput,
  type EvseInput,
  type Lifecycle,
  type PowerType,
  type SiteInput,
  siteDraft,
} from "../site.js";
import { isRecord, placeAt, positiveInteger, positiveNumber, type Raw, text } from "./raw.js";

interface Plug {
  standard: string;
  format?: "socket" | "cable";
}

/**
 * Open Charge Map's `ConnectionType` ids. NEMA 5-15 is OCPI's household
 * type B; a type whose formal name is SAE J3400 (27, "NACS / Tesla
 * Supercharger") is NACS, whatever its id. A plug whose standard the model
 * cannot name exactly (an IEC 60309 socket of unstated amperage, Avcon,
 * inductive, wireless, a battery swap) is `UNKNOWN`.
 */
const CONNECTION_TYPES: Readonly<Record<string, Plug>> = {
  "1": { standard: "IEC_62196_T1" },
  "2": { standard: "CHADEMO" },
  "3": { standard: "DOMESTIC_G" },
  "8": { standard: "TESLA_R" },
  "9": { standard: "NEMA_5_20" },
  "10": { standard: "NEMA_14_30" },
  "11": { standard: "NEMA_14_50" },
  "13": { standard: "DOMESTIC_C" },
  "22": { standard: "DOMESTIC_B" },
  "23": { standard: "DOMESTIC_E" },
  "25": { standard: "IEC_62196_T2", format: "socket" },
  "26": { standard: "IEC_62196_T3C" },
  "27": { standard: "SAE_J3400" },
  "28": { standard: "DOMESTIC_F" },
  "29": { standard: "DOMESTIC_I" },
  "30": { standard: "TESLA_S" },
  "32": { standard: "IEC_62196_T1_COMBO" },
  "33": { standard: "IEC_62196_T2_COMBO" },
  "36": { standard: "IEC_62196_T3A" },
  "1036": { standard: "IEC_62196_T2", format: "cable" },
  "1037": { standard: "DOMESTIC_J" },
  "1038": { standard: "GBT_AC", format: "socket" },
  "1039": { standard: "GBT_AC", format: "cable" },
  "1040": { standard: "GBT_DC" },
  "1043": { standard: "DOMESTIC_M" },
  "1044": { standard: "CHAOJI" },
};

/** `CurrentType`: 10 AC single-phase, 20 AC three-phase, 30 DC. */
const POWER_TYPES: Readonly<Record<string, PowerType>> = {
  "10": "AC_1_PHASE",
  "20": "AC_3_PHASE",
  "30": "DC",
};

/** `UsageType`: who may charge. */
const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  "1": "public",
  "2": "private",
  "3": "restricted",
  "4": "public",
  "5": "public",
  "6": "customers",
  // "Public - Notice Required": public, after telling the site.
  "7": "public",
};

/** The id of the status type that marks a record as another's duplicate. */
const DUPLICATE = "210";

/**
 * A `StatusType` as a lifecycle: an operational one is in service, the rest
 * by id. Open Charge Map's status is maintained by its users, never a
 * reading.
 */
function lifecycleOf(status: unknown): Lifecycle | undefined {
  if (!isRecord(status)) return undefined;
  if (status["IsOperational"] === true) return "operational";
  if (status["IsOperational"] !== false) return undefined;
  switch (text(status["ID"])) {
    case "150":
      return "planned";
    case "200":
    case DUPLICATE:
      return "decommissioned";
    default:
      return "temporarily_closed";
  }
}

const record = (value: unknown): Raw => (isRecord(value) ? value : {});

/** The operator, unless it is a private person or one of Open Charge Map's placeholders. */
function operatorOf(poi: Raw): SiteInput["operator"] {
  const info = record(poi["OperatorInfo"]);
  const name = text(info["Title"]);
  if (name === undefined || info["IsPrivateIndividual"] === true || name.startsWith("(")) {
    return undefined;
  }
  const website = text(info["WebsiteURL"]);
  return { name, ...(website === undefined ? {} : { website }) };
}

function accessOf(poi: Raw): Pick<SiteInput, "audience" | "payment"> {
  const usage = record(poi["UsageType"]);
  const audience = AUDIENCE[text(usage["ID"]) ?? ""];
  return {
    ...(audience === undefined ? {} : { audience }),
    ...(usage["IsMembershipRequired"] === true ? { payment: ["membership" as const] } : {}),
  };
}

/** One charge point per connection, standing for `Quantity` of them. */
function evsesOf(poi: Raw): EvseInput[] {
  return (Array.isArray(poi["Connections"]) ? poi["Connections"] : [])
    .filter(isRecord)
    .flatMap((c) => {
      const key = text(c["ID"]);
      if (key === undefined) return [];
      const type = record(c["ConnectionType"]);
      const plug = /^SAE\s*J3400$/i.test(text(type["FormalName"]) ?? "")
        ? { standard: "SAE_J3400" }
        : CONNECTION_TYPES[text(type["ID"]) ?? text(c["ConnectionTypeID"]) ?? ""];
      const powerType =
        POWER_TYPES[text(record(c["CurrentType"])["ID"]) ?? text(c["CurrentTypeID"]) ?? ""];
      const kw = positiveNumber(c["PowerKW"]);
      const volts = positiveNumber(c["Voltage"]);
      const amps = positiveNumber(c["Amps"]);
      const quantity = positiveInteger(c["Quantity"]);
      const connectionStatus = record(c["StatusType"]);
      const lifecycle =
        connectionStatus["IsOperational"] === false ? lifecycleOf(connectionStatus) : undefined;
      const connector: ConnectorInput = {
        id: "1",
        standard: plug?.standard ?? "UNKNOWN",
        ...(plug?.format === undefined ? {} : { format: plug.format }),
        ...(powerType === undefined ? {} : { powerType }),
        ...(kw === undefined ? {} : { maxPowerKw: kw }),
        ...(volts === undefined ? {} : { maxVoltage: volts }),
        ...(amps === undefined ? {} : { maxAmperage: amps }),
      };
      return [
        {
          key,
          ...(quantity === undefined ? {} : { quantity }),
          ...(lifecycle === undefined ? {} : { lifecycle }),
          connectors: [connector],
        },
      ];
    });
}

/** Half-open, so a POI on a shared edge belongs to one cell only. */
const inside = (cell: Cell, [lon, lat]: [number, number]) =>
  lon >= cell.west && lon < cell.east && lat >= cell.south && lat < cell.north;

/** The `maxresults` the main endpoint asks for: an answer that long may be cut short. */
function maxResultsOf(feed: ChargingCatalogFeed): number | undefined {
  const url = feed.endpoints["main"]?.url;
  const value = url?.match(/[?&]maxresults=(\d+)/i)?.[1];
  return value === undefined ? undefined : Number(value);
}

/**
 * Open Charge Map's POIs as full objects (`compact=false`), read per grid
 * cell: a POI is a site, each of its connections a charge point standing for
 * the connection's `Quantity`. The reference objects type the plugs, their
 * phases and who may charge. Each record credits its data provider and that
 * provider's licence as its upstream; an imported provider's ids are
 * qualified by it, so two providers' records may still link. The status types
 * are maintained by users: a lifecycle, never a reading; a duplicate listing
 * is left out. `UsageCost` stays the publisher's text. A cell keeps only the
 * POIs inside it; an answer as long as `maxresults` may have been cut short
 * and is logged.
 */
export function parseOcm(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const pois = (Array.isArray(doc) ? doc : []).filter(isRecord);
    const cap = maxResultsOf(feed);
    if (cap !== undefined && pois.length >= cap) {
      console.warn(
        `[ocm] ${feed.id}${ctx.cell === undefined ? "" : ` cell ${ctx.cell.id}`}: ${pois.length} results, the maxresults cap; POIs past it are missing`,
      );
    }
    for (const poi of pois) {
      const id = text(poi["ID"]);
      const address = record(poi["AddressInfo"]);
      const point = placeAt(Number(address["Latitude"]), Number(address["Longitude"]));
      if (id === undefined || point === undefined || seen.has(id)) {
        rejected++;
        continue;
      }
      if (ctx.cell !== undefined && !inside(ctx.cell, point)) continue;
      const status = record(poi["StatusType"]);
      if (text(status["ID"]) === DUPLICATE) continue;
      seen.add(id);

      const provider = record(poi["DataProvider"]);
      const providerId = text(provider["ID"]) ?? text(poi["DataProviderID"]);
      const publisher = text(provider["Title"]);
      const license = text(provider["License"]);
      const operator = operatorOf(poi);
      out.features.push(
        siteDraft(
          feed,
          {
            stationId: id,
            // Open Charge Map's own contributors' records are the feed's; an
            // imported record is its provider's.
            ...(providerId === undefined || providerId === "1"
              ? {}
              : { providerAuthority: `${feed.id}/${providerId}` }),
            point,
            name: text(address["Title"]),
            ...(operator === undefined ? {} : { operator }),
            website: text(address["RelatedURL"]),
            address: {
              street: text(address["AddressLine1"]),
              postalCode: text(address["Postcode"]),
              city: text(address["Town"]),
              country: text(record(address["Country"])["ISOCode"]),
            },
            ...accessOf(poi),
            lifecycle: lifecycleOf(status) ?? "unknown",
            tariffText: text(poi["UsageCost"]),
            notes: text(address["AccessComments"]),
            ...(publisher === undefined
              ? {}
              : { upstream: [{ publisher, ...(license === undefined ? {} : { license }) }] }),
            evses: evsesOf(poi),
          },
          ctx.fetchedAt,
        ),
      );
    }
  }
  out.rejected = rejected;
  return out;
}
