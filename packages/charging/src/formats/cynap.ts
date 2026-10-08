import {
  getXmlChild,
  getXmlChildren,
  getXmlChildText,
  parseXmlDocument,
} from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import {
  type ConnectorInput,
  emi3Of,
  type Lifecycle,
  parsePowerKw,
  type SiteInput,
  siteDraft,
} from "../site.js";
import { placeFromText } from "./raw.js";

type Current = "ac" | "dc";

/**
 * The connector types the table names. A Type 2 socket is AC and the combo
 * and CHAdeMO plugs DC, whatever the point's own power type says.
 */
const PLUGS: Readonly<Record<string, { standard: string; current: Current }>> = {
  type2: { standard: "IEC_62196_T2", current: "ac" },
  combotype2: { standard: "IEC_62196_T2_COMBO", current: "dc" },
  chademo: { standard: "CHADEMO", current: "dc" },
};

/** The register's status: whether the point is in service, not what it is doing. */
const LIFECYCLES: Readonly<Record<string, Lifecycle>> = {
  operational: "operational",
  unavailable: "temporarily_closed",
};

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * The weekly hours the table writes as a Python dict
 * (`{'monday': [{'start': '08:00', 'end': '20:00'}], …}`), as periods.
 */
function dictPeriods(text: string): WeeklyPeriod[] {
  const periods: WeeklyPeriod[] = [];
  for (const [, name, spans] of text.matchAll(/'([a-z]+)'\s*:\s*\[([^\]]*)\]/g)) {
    const day = DAYS.indexOf(name ?? "") + 1;
    if (day === 0) continue;
    for (const [, from, to] of (spans ?? "").matchAll(
      /'start'\s*:\s*'(\d{2}:\d{2})'\s*,\s*'end'\s*:\s*'(\d{2}:\d{2})'/g,
    )) {
      if (from !== undefined && to !== undefined) periods.push({ day, from, to });
    }
  }
  return periods;
}

/** `24h` and `24/7` are every hour; a dict is weekly hours; anything else is the publisher's text. */
function hoursOf(
  text: string | undefined,
): Pick<SiteInput, "twentyFourSeven" | "openingHoursOsm" | "openingHoursText"> {
  if (text === undefined) return {};
  if (/^24\s*(?:h|\/\s*7)$/i.test(text)) return { twentyFourSeven: true };
  const osm = text.startsWith("{") ? osmOpeningHours(dictPeriods(text)) : undefined;
  return osm === undefined ? { openingHoursText: text } : { openingHoursOsm: osm };
}

/** The text of a `{ value, lang }` element. */
const valueText = (node: unknown, key: string) => getXmlChildText(getXmlChild(node, key), "value");

/**
 * The Cyprus access point's charging-point table: DATEX II namespaces around
 * a table of its own, one `chargingPoint` per row. A row is one site with one
 * charge point, identified by its name; it lists one connector per plug type.
 * The connector power is each plug's own, never the point's total, and goes
 * to the plugs of the point's declared power type: a Type 2 socket on a DC
 * point is AC of unstated power. The register's status is the site's
 * lifecycle, never a reading.
 */
export function parseCynap(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = parseXmlDocument(body, { removeNSPrefix: true });
    const table = getXmlChild(
      getXmlChild(
        getXmlChild(getXmlChild(doc, "d2LogicalModel"), "payload"),
        "energyInfrastructureTable",
      ),
      "energyInfrastructureTablePublication",
    );
    for (const row of getXmlChildren(getXmlChild(table, "chargingPoints"), "chargingPoint")) {
      const id = getXmlChildText(row, "chargingPointIdentification")?.trim();
      const coordinates = getXmlChild(
        getXmlChild(getXmlChild(row, "location"), "pointByCoordinates"),
        "pointCoordinates",
      );
      const point = placeFromText(
        getXmlChildText(coordinates, "latitude"),
        getXmlChildText(coordinates, "longitude"),
      );
      if (id === undefined || id === "" || point === undefined || seen.has(id)) {
        rejected++;
        continue;
      }
      seen.add(id);

      const declared = getXmlChildText(row, "powerType")?.trim().toLowerCase();
      const current: Current | undefined =
        declared === "ac" || declared === "dc" ? declared : undefined;
      const kw = parsePowerKw(getXmlChildText(row, "connectorPower"));
      const types = getXmlChild(row, "connectorTypes");
      const listed = types === undefined ? [] : [types["connectorType"]].flat();
      const connectors: ConnectorInput[] = listed.flatMap((value, i) => {
        const type = typeof value === "string" ? value.trim().toLowerCase() : "";
        if (type === "") return [];
        const plug = PLUGS[type] ?? { standard: "UNKNOWN", current };
        const powered = kw !== undefined && (current === undefined || plug.current === current);
        return [
          {
            id: String(i + 1),
            standard: plug.standard,
            ...(plug.current === undefined ? {} : { current: plug.current }),
            ...(powered ? { maxPowerKw: kw } : {}),
          },
        ];
      });

      const operator = getXmlChildText(row, "chargingPointOperator");
      const owner = getXmlChildText(row, "chargingPointOwner");
      const evseId = emi3Of(id);
      out.features.push(
        siteDraft(
          feed,
          {
            stationId: id,
            point,
            name: id,
            ...(operator === undefined ? {} : { operator: { name: operator } }),
            ...(owner === undefined ? {} : { owner: { name: owner } }),
            address: { text: valueText(row, "chargingPointAddress") },
            ...hoursOf(valueText(row, "operatingTime")?.trim()),
            notes: valueText(row, "accessInformation"),
            lifecycle: LIFECYCLES[valueText(row, "chargingPointStatus")?.trim() ?? ""] ?? "unknown",
            evses: [{ key: id, ...(evseId === undefined ? {} : { evseId }), connectors }],
          },
          ctx.fetchedAt,
        ),
      );
    }
  }
  out.rejected = rejected;
  return out;
}
