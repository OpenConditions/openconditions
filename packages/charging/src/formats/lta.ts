import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { OcpiTariff } from "@openconditions/ocpi";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  evseStatusDraft,
  parsePowerKw,
  siteDraft,
} from "../site.js";
import { tariffDraft } from "../tariff.js";
import { isRecord, placeFromText, type Raw, text } from "./raw.js";

/** A plug type as DataMall names it. */
function standardOf(name: string | undefined): string {
  const n = (name ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (/ccs1|combo1|type1combo/.test(n)) return "IEC_62196_T1_COMBO";
  if (/ccs|combo/.test(n)) return "IEC_62196_T2_COMBO";
  if (/chademo/.test(n)) return "CHADEMO";
  if (/gb\/?t/.test(n)) return /dc/.test(n) ? "GBT_DC" : "GBT_AC";
  if (/type1|j1772/.test(n)) return "IEC_62196_T1";
  if (/type2/.test(n)) return "IEC_62196_T2";
  return "UNKNOWN";
}

/**
 * A charger's or an evId's status: 0 is occupied, which DataMall's guide says
 * covers a charging, reserved or blocked point, so it says no more than in
 * use; 1 available; 100 not available. An empty status says nothing.
 */
const STATES: Readonly<Record<string, EvseStatus>> = {
  "0": "occupied",
  "1": "available",
  "100": "inoperative",
};

const trimmed = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * A plug type's price as a tariff: per kWh an energy price, per hour a time
 * price, in Singapore dollars including GST as the guide states. Undefined
 * for a price or unit it cannot read.
 */
function tariffOf(plug: Raw): OcpiTariff | undefined {
  const price = Number(text(plug["price"]));
  const unit = text(plug["priceType"])
    ?.replace(/^\$\s*\/\s*/, "")
    .toLowerCase();
  if (!Number.isFinite(price) || price < 0) return undefined;
  const type = unit === "kwh" ? "ENERGY" : unit === "h" ? "TIME" : undefined;
  if (type === undefined) return undefined;
  return {
    id: `${unit === "kwh" ? "kWh" : "h"}-${trimmed(price)}`,
    currency: "SGD",
    tax_included: "YES",
    elements: [{ price_components: [{ type, price }] }],
  };
}

/** The stations of a batch file: `{ value: [...] }`, or the list itself. */
function stationsOf(body: Buffer): Raw[] {
  const doc = JSON.parse(body.toString("utf8")) as unknown;
  const list = isRecord(doc) ? doc["value"] : doc;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

const listOf = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/**
 * LTA DataMall's EV charging points batch, the file its `EVCBatch` link
 * names: a location per site (`locationId`, the longitude's decimals and the
 * postal code), each of its chargers one charge point with its plug types as
 * connectors. A charger's status is its own, or its evId's when it has exactly
 * one. Statuses are read as of the fetch, the file holding no time. Prices
 * include GST.
 */
export function parseLta(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  const seen = new Set<string>();
  for (const station of (payloads["main"] ?? []).flatMap(stationsOf)) {
    const stationId = text(station["locationId"]);
    // `longtitude` is the guide's own spelling.
    const point = placeFromText(station["latitude"], station["longtitude"] ?? station["longitude"]);
    if (stationId === undefined || point === undefined || seen.has(stationId)) {
      rejected++;
      continue;
    }
    seen.add(stationId);

    const tariffs = new Map<string, OcpiTariff>();
    const evses: EvseInput[] = [];
    const states: { key: string; status: EvseStatus }[] = [];
    const chargers = listOf(station["chargingPoints"]);
    for (const [c, charger] of chargers.entries()) {
      const connectors: ConnectorInput[] = listOf(charger["plugTypes"]).map((plug, i) => {
        const tariff = tariffOf(plug);
        if (tariff !== undefined) tariffs.set(tariff.id, tariff);
        const rating = text(plug["powerRating"])?.toLowerCase();
        const kw = parsePowerKw(plug["chargingSpeed"]);
        return {
          id: String(i + 1),
          standard: standardOf(text(plug["plugType"])),
          ...(rating === "ac" || rating === "dc" ? { current: rating } : {}),
          ...(kw === undefined ? {} : { maxPowerKw: kw }),
          ...(tariff === undefined ? {} : { tariffIds: [tariff.id] }),
        };
      });
      const evIds = listOf(charger["evIds"]);
      const [only] = evIds.length === 1 ? evIds : [];
      const key =
        text(charger["id"]) ??
        (only === undefined ? undefined : (text(only["evCpId"]) ?? text(only["id"]))) ??
        `${stationId}-${c + 1}`;
      evses.push({ key, connectors });
      // One evId is the charge point itself; over several, the charger's own
      // status is what the file says of the charge point.
      const status = STATES[text((only ?? charger)["status"]) ?? ""];
      if (status !== undefined) states.push({ key, status });
    }

    const address = text(station["address"]);
    const operator = chargers.map((c) => text(c["operator"])).find((o) => o !== undefined);
    const hours = chargers.map((c) => text(c["operationHours"])).find((h) => h !== undefined);
    out.features.push(
      siteDraft(
        feed,
        {
          stationId,
          point,
          name: text(station["name"]),
          lang: "en",
          ...(operator === undefined ? {} : { operator: { name: operator } }),
          // The location id ends in the six-digit postal code.
          address: { text: address, postalCode: stationId.match(/(\d{6})$/)?.[1] },
          ...(hours === undefined ? {} : { openingHoursText: hours }),
          evses,
        },
        ctx.fetchedAt,
      ),
    );
    for (const tariff of tariffs.values()) {
      const offer = tariffDraft(feed, stationId, tariff, { fetchedAt: ctx.fetchedAt, point });
      if (offer !== undefined) out.offers.push(offer);
    }
    for (const s of states) {
      out.observations.push(
        evseStatusDraft(feed, { stationId, evseKey: s.key, status: s.status, point }, ctx),
      );
    }
  }
  out.rejected = rejected;
  return out;
}
