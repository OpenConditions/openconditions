import {
  type Cell,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { AUDIENCES } from "@openconditions/model";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { own } from "../records.js";
import {
  type ConnectorInput,
  type EvseInput,
  emi3Of,
  type Lifecycle,
  type PowerType,
  type SiteInput,
  siteDraft,
} from "../site.js";
import {
  isRecord,
  placeAt,
  positiveInteger,
  positiveNumber,
  type Raw,
  text,
  unplacedReason,
} from "./raw.js";

interface Plug {
  standard: string;
  format?: "socket" | "cable";
}

/**
 * Open Charge Map's `ConnectionType` ids. NEMA 5-15 is OCPI's household
 * type B; a type whose formal name is SAE J3400 (27, "NACS / Tesla
 * Supercharger") is NACS, whatever its id. The IEC 60309 sockets (`IEC
 * 60309`, `CEE` and the blue commando) are the OCPI plug their current
 * names (`IEC60309`). A plug whose standard the model cannot name exactly
 * (Avcon, inductive, wireless, a battery swap) is `UNKNOWN`, and counted as
 * unread unless Open Charge Map itself says unknown (0).
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

/**
 * The IEC 60309 connection types: the 3-pin ones (34, the blue commando 4,
 * CEE 3 pin 16) are single-phase, the 5-pin ones (35, CEE 5 pin 17)
 * three-phase.
 */
const IEC60309: Readonly<Record<string, "single" | "three">> = {
  "4": "single",
  "16": "single",
  "34": "single",
  "17": "three",
  "35": "three",
};

/** The OCPI IEC 60309 plug of a phase count and current rating; unknown without one OCPI names. */
function iec60309(phases: "single" | "three", amps: number | undefined): string {
  if (amps === undefined) return "UNKNOWN";
  if (phases === "single") return amps <= 16 ? "IEC_60309_2_single_16" : "UNKNOWN";
  if (amps <= 16) return "IEC_60309_2_three_16";
  if (amps <= 32) return "IEC_60309_2_three_32";
  return "IEC_60309_2_three_64";
}

/** `CurrentType`: 10 AC single-phase, 20 AC three-phase, 30 DC. */
const POWER_TYPES: Readonly<Record<string, PowerType>> = {
  "10": "AC_1_PHASE",
  "20": "AC_3_PHASE",
  "30": "DC",
};

/** `UsageType`: who may charge; 0 is Open Charge Map's unknown. */
const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number] | null>> = {
  "0": null,
  "1": "public",
  "2": "private",
  "3": "restricted",
  "4": "public",
  "5": "public",
  "6": "customers",
  // "Public - Notice Required": public, after telling the site.
  "7": "public",
};

/** The submission status types of a published listing ("Imported and Published", "Submission Published"). */
const LIVE_SUBMISSIONS: ReadonlySet<string> = new Set(["100", "200"]);

/** The id of the status type that marks a record as another's duplicate. */
const DUPLICATE = "210";

/**
 * `StatusType` ids as lifecycles. "Temporarily Unavailable" (30) counts as
 * operational in Open Charge Map's own flag but is closed for now; "Not
 * Operational" (100) is too; a planned site is planned and a removed one
 * decommissioned. 0 is Open Charge Map's unknown. Open Charge Map's status
 * is maintained by its users, never a reading.
 */
const LIFECYCLES: Readonly<Record<string, Lifecycle | null>> = {
  "0": null,
  "10": "operational",
  "20": "operational",
  "30": "temporarily_closed",
  "50": "operational",
  "75": "operational",
  "100": "temporarily_closed",
  "150": "planned",
  "200": "decommissioned",
  [DUPLICATE]: "decommissioned",
};

/** A `StatusType` as a lifecycle; a status id Open Charge Map does not list is counted. */
function lifecycleOf(
  status: unknown,
  statusId: unknown,
  unread: () => void,
): Lifecycle | undefined {
  // A compact answer names the status by its id alone.
  const id = (isRecord(status) ? text(status["ID"]) : undefined) ?? text(statusId);
  if (id === undefined) return undefined;
  const lifecycle = own(LIFECYCLES, id);
  if (lifecycle !== undefined) return lifecycle ?? undefined;
  unread();
  // A status of no listed id says whether it works, if nothing more.
  return isRecord(status) && status["IsOperational"] === true ? "operational" : undefined;
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
  const phone = text(info["PhonePrimaryContact"]);
  const email = text(info["ContactEmail"]);
  return {
    name,
    ...(website === undefined ? {} : { website }),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
  };
}

/**
 * Who may charge, a membership and paying at the location ("Public - Pay At
 * Location", ad hoc charging); a usage type Open Charge Map does not list is
 * counted.
 */
function accessOf(
  poi: Raw,
  unread: () => void,
): Pick<SiteInput, "audience" | "payment" | "adHocCharging"> {
  const usage = record(poi["UsageType"]);
  const id = text(usage["ID"]) ?? text(poi["UsageTypeID"]);
  const audience = own(AUDIENCE, id);
  if (id !== undefined && audience === undefined) unread();
  return {
    ...(audience === undefined || audience === null ? {} : { audience }),
    ...(usage["IsMembershipRequired"] === true ? { payment: ["membership" as const] } : {}),
    ...(usage["IsPayAtLocation"] === true ? { adHocCharging: true } : {}),
  };
}

/** A POI's photos: its enabled media items that are no videos. */
function imagesOf(poi: Raw): SiteInput["images"] {
  return (Array.isArray(poi["MediaItems"]) ? poi["MediaItems"] : [])
    .filter(isRecord)
    .flatMap((item) => {
      const url = text(item["ItemURL"]);
      if (url === undefined || item["IsVideo"] === true || item["IsEnabled"] === false) return [];
      const thumbnail = text(item["ItemThumbnailURL"]);
      return [
        { url, category: "site" as const, ...(thumbnail === undefined ? {} : { thumbnail }) },
      ];
    });
}

/**
 * One charge point per connection, standing for `Quantity` of them. A
 * connection type or current type outside the tables is left unread and
 * counted.
 */
function evsesOf(feedId: string, poi: Raw): EvseInput[] {
  const unread = () => recordSkipped(feedId, "unknown_value");
  return (Array.isArray(poi["Connections"]) ? poi["Connections"] : [])
    .filter(isRecord)
    .flatMap((c) => {
      const key = text(c["ID"]);
      if (key === undefined) return [];
      const type = record(c["ConnectionType"]);
      const typeId = text(type["ID"]) ?? text(c["ConnectionTypeID"]);
      const amps = positiveNumber(c["Amps"]);
      const phases = own(IEC60309, typeId);
      const plug = /^SAE\s*J3400$/i.test(text(type["FormalName"]) ?? "")
        ? { standard: "SAE_J3400" }
        : phases !== undefined
          ? { standard: iec60309(phases, amps), format: "socket" as const }
          : own(CONNECTION_TYPES, typeId);
      if (typeId !== undefined && typeId !== "0" && plug === undefined) unread();
      const currentId = text(record(c["CurrentType"])["ID"]) ?? text(c["CurrentTypeID"]);
      const powerType = own(POWER_TYPES, currentId);
      if (currentId !== undefined && powerType === undefined) unread();
      const kw = positiveNumber(c["PowerKW"]);
      const volts = positiveNumber(c["Voltage"]);
      const quantity = positiveInteger(c["Quantity"]);
      const reference = text(c["Reference"]);
      const evseId = emi3Of(reference);
      const connectionStatus = record(c["StatusType"]);
      const status = lifecycleOf(connectionStatus, c["StatusTypeID"], unread);
      const lifecycle = status === "operational" ? undefined : status;
      const connector: ConnectorInput = {
        id: "1",
        standard: plug?.standard ?? "UNKNOWN",
        ...(plug?.format === undefined ? {} : { format: plug.format }),
        ...(powerType === undefined ? {} : { powerType }),
        ...(kw === undefined ? {} : { maxPowerKw: kw }),
        ...(volts === undefined ? {} : { maxVoltage: volts }),
        ...(amps === undefined ? {} : { maxAmperage: amps }),
      };
      // A connection's reference is its EVSE id where it is one, else the label on it.
      return [
        {
          key,
          ...(evseId === undefined ? {} : { evseId }),
          ...(reference === undefined || evseId !== undefined
            ? {}
            : { physicalReference: reference }),
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
 * POIs inside it; an answer as long as `maxresults` may have been cut short,
 * so it is logged and the output marked truncated. A POI without an id, or
 * listed again under one, is malformed; one without a position, or with one
 * that places nothing, is counted as such.
 */
export function parseOcm(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const pois: unknown[] = Array.isArray(doc) ? doc : [];
    const cap = maxResultsOf(feed);
    if (cap !== undefined && pois.length >= cap) {
      out.truncated = true;
      console.warn(
        `[ocm] ${feed.id}${ctx.cell === undefined ? "" : ` cell ${ctx.cell.id}`}: ${pois.length} results, the maxresults cap; POIs past it are missing`,
      );
    }
    for (const poi of pois) {
      const id = isRecord(poi) ? text(poi["ID"]) : undefined;
      if (!isRecord(poi) || id === undefined || seen.has(id)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      // A listing under review, rejected or delisted is not published; a
      // compact answer names its submission status by id, of which 100 and
      // 200 are the published ones.
      const submission = record(poi["SubmissionStatus"]);
      const submissionId = text(poi["SubmissionStatusTypeID"]);
      if (
        submission["IsLive"] === false ||
        (submission["IsLive"] === undefined &&
          submissionId !== undefined &&
          !LIVE_SUBMISSIONS.has(submissionId))
      ) {
        continue;
      }
      const address = record(poi["AddressInfo"]);
      // A missing coordinate is not zero: Number(null) would place the POI at the equator.
      const point = placeAt(
        Number(text(address["Latitude"]) ?? Number.NaN),
        Number(text(address["Longitude"]) ?? Number.NaN),
      );
      if (point === undefined) {
        recordSkipped(feed.id, unplacedReason(address["Latitude"], address["Longitude"]));
        continue;
      }
      if (ctx.cell !== undefined && !inside(ctx.cell, point)) continue;
      const status = record(poi["StatusType"]);
      if ((text(status["ID"]) ?? text(poi["StatusTypeID"])) === DUPLICATE) continue;
      seen.add(id);

      const provider = record(poi["DataProvider"]);
      const providerId = text(provider["ID"]) ?? text(poi["DataProviderID"]);
      const publisher = text(provider["Title"]);
      const license = text(provider["License"]);
      const providerRecord = text(poi["DataProvidersReference"]);
      const operator = operatorOf(poi);
      const unread = () => recordSkipped(feed.id, "unknown_value");
      const street = [text(address["AddressLine1"]), text(address["AddressLine2"])]
        .filter((line) => line !== undefined)
        .join(", ");
      const phone = text(address["ContactTelephone1"]) ?? text(address["ContactTelephone2"]);
      const access = text(address["AccessComments"]);
      const images = imagesOf(poi) ?? [];
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
              street: street === "" ? undefined : street,
              postalCode: text(address["Postcode"]),
              city: text(address["Town"]),
              region: text(address["StateOrProvince"]),
              country: text(record(address["Country"])["ISOCode"]),
            },
            ...accessOf(poi, unread),
            lifecycle: lifecycleOf(status, poi["StatusTypeID"], unread) ?? "unknown",
            tariffText: text(poi["UsageCost"]),
            ...(access === undefined ? {} : { directions: [{ lang: "und", text: access }] }),
            notes: text(poi["GeneralComments"]),
            ...(phone === undefined ? {} : { hotline: phone }),
            ...(images.length === 0 ? {} : { images }),
            ...(publisher === undefined
              ? {}
              : {
                  upstream: [
                    {
                      publisher,
                      ...(providerRecord === undefined ? {} : { recordId: providerRecord }),
                      ...(license === undefined ? {} : { license }),
                    },
                  ],
                }),
            evses: evsesOf(feed.id, poi),
          },
          ctx.fetchedAt,
        ),
      );
    }
  }
  return out;
}
