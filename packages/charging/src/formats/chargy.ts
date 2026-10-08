import {
  getXmlChild,
  getXmlChildren,
  getXmlChildText,
  parseXmlDocument,
  xmlText,
} from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { connectorStatusDraft, type EvseInput, type EvseStatus, siteDraft } from "../site.js";
import { isRecord, placeFromText, positiveNumber, type Raw, text } from "./raw.js";

/**
 * The OCPP connector states the devices report. Only `CHARGING` says energy
 * flows; the other states of a session (preparing, suspended, finishing) and
 * a bare `OCCUPIED` say the connector is in use. An offline device says
 * nothing of its connectors.
 */
const STATES: Readonly<Record<string, EvseStatus>> = {
  AVAILABLE: "available",
  CHARGING: "charging",
  OCCUPIED: "occupied",
  PREPARING: "occupied",
  SUSPENDED_EV: "occupied",
  SUSPENDED_EVSE: "occupied",
  FINISHING: "occupied",
  RESERVED: "reserved",
  FAULTED: "out_of_order",
  FAULT: "out_of_order",
  UNAVAILABLE: "inoperative",
  OFFLINE: "unknown",
};

/** The lowest of a placemark's device ids; undefined without any. */
function lowestId(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined;
  if (ids.every((id) => /^\d+$/.test(id))) {
    return ids.reduce((low, id) => (Number(id) < Number(low) ? id : low));
  }
  return [...ids].sort()[0];
}

/** The `chargingdevice` entries of a placemark: JSON in the `value` of each. */
function devicesOf(placemark: unknown): Raw[] {
  const data = getXmlChildren(getXmlChild(placemark, "ExtendedData"), "Data");
  return data.flatMap((entry) => {
    if (entry["@_name"] !== "chargingdevice") return [];
    const value = xmlText(entry["value"]);
    if (value === undefined) return [];
    try {
      const device = JSON.parse(value) as unknown;
      return isRecord(device) ? [device] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Chargy's KML: a placemark per site, each charging device in it a charge
 * point keyed by the device id, each of its connectors a plug keyed by the
 * connector id, with the connector's live OCPP state read as of the fetch
 * (the file carries no time). The file names no plug standard: its
 * descriptions say Type 2 even at 400 kW, so every plug is `UNKNOWN`. A site
 * has no id of its own and is keyed by its lowest device id: numerically when
 * every id is a number, as Chargy's are, else the first in string order.
 */
export function parseChargy(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = parseXmlDocument(body, {
      isArray: (name) => name === "Placemark" || name === "Data",
    });
    for (const placemark of getXmlChildren(
      getXmlChild(getXmlChild(doc, "kml"), "Document"),
      "Placemark",
    )) {
      const [lon, lat] = (
        getXmlChildText(getXmlChild(placemark, "Point"), "coordinates") ?? ""
      ).split(",");
      const point = placeFromText(lat, lon);
      const devices = devicesOf(placemark).flatMap((device) => {
        const id = text(device["id"]);
        return id === undefined ? [] : [{ id, device }];
      });
      const stationId = lowestId(devices.map((d) => d.id));
      if (point === undefined || stationId === undefined || seen.has(stationId)) {
        rejected++;
        continue;
      }
      seen.add(stationId);

      const evses: EvseInput[] = [];
      const states: { evseKey: string; connectorId: string; status: EvseStatus }[] = [];
      for (const { id, device } of devices) {
        const connectors = (Array.isArray(device["connectors"]) ? device["connectors"] : []).filter(
          isRecord,
        );
        evses.push({
          key: id,
          connectors: connectors.flatMap((c) => {
            const connectorId = text(c["id"]);
            if (connectorId === undefined) return [];
            const status = STATES[text(c["description"])?.toUpperCase() ?? ""];
            if (status !== undefined) states.push({ evseKey: id, connectorId, status });
            const kw = positiveNumber(c["maxchspeed"]);
            return [
              {
                id: connectorId,
                standard: "UNKNOWN",
                ...(kw === undefined ? {} : { maxPowerKw: kw }),
              },
            ];
          }),
        });
      }
      out.features.push(
        siteDraft(
          feed,
          {
            stationId,
            point,
            name: getXmlChildText(placemark, "name"),
            address: { text: getXmlChildText(placemark, "address") },
            evses,
          },
          ctx.fetchedAt,
        ),
      );
      for (const s of states) {
        out.observations.push(connectorStatusDraft(feed, { stationId, ...s, point }, ctx));
      }
    }
  }
  out.rejected = rejected;
  return out;
}
