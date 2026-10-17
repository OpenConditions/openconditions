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
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import { own } from "../records.js";
import {
  type ConnectorInput,
  emi3Of,
  type Lifecycle,
  parsePowerKw,
  type SiteInput,
  siteDraft,
} from "../site.js";
import { placeFromText, unplacedReason } from "./raw.js";

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

/**
 * `vehicleTypeCompatibility`, by UNECE vehicle category: a passenger car
 * (M1), a bus or coach (M2, M3), a two- or three-wheeler (L), a light
 * commercial vehicle (N1), a heavy goods vehicle (N2 a rigid truck; N3, over
 * 12 t, a rigid truck or a tractor unit).
 */
const VEHICLE_TYPES: Readonly<Record<string, string[]>> = {
  "PassengerCar (M1)": ["personal_vehicle"],
  "Bus (M2)": ["bus"],
  "Coach (M3)": ["bus"],
  "TwoThreeWheeledVehicle (L)": ["motorcycle"],
  "LightCommercialVehicle (N1)": ["van"],
  "HeavyDutyVehicle (N2)": ["rigid"],
  "HeavyDutyVehicle (N3)": ["rigid", "semi_tractor"],
};

/** The table's time zone, a fixed offset in summer and winter alike: Cyprus's zone. */
const ZONE = "Asia/Nicosia";

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
 * lifecycle, never a reading. A row without an identification, or listed
 * again under one, is malformed; one without a position, or with one that
 * places nothing, is counted as such. A connector type or a status the table
 * does not list is left unread and counted.
 */
export function parseCynap(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
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
      const [lat, lon] = [
        getXmlChildText(coordinates, "latitude"),
        getXmlChildText(coordinates, "longitude"),
      ];
      const point = placeFromText(lat, lon);
      if (id === undefined || id === "" || seen.has(id)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (point === undefined) {
        recordSkipped(feed.id, unplacedReason(lat, lon));
        continue;
      }
      seen.add(id);

      const declared = getXmlChildText(row, "powerType")?.trim().toLowerCase();
      const current: Current | undefined =
        declared === "ac" || declared === "dc" ? declared : undefined;
      if (declared !== undefined && declared !== "" && current === undefined) {
        recordSkipped(feed.id, "unknown_value");
      }
      const kw = parsePowerKw(getXmlChildText(row, "connectorPower"));
      const types = getXmlChild(row, "connectorTypes");
      const listed = types === undefined ? [] : [types["connectorType"]].flat();
      const connectors: ConnectorInput[] = listed.flatMap((value, i) => {
        const type = typeof value === "string" ? value.trim().toLowerCase() : "";
        if (type === "") return [];
        const known = own(PLUGS, type);
        if (known === undefined) recordSkipped(feed.id, "unknown_value");
        const plug = known ?? { standard: "UNKNOWN", current };
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
      const status = valueText(row, "chargingPointStatus")?.trim();
      const lifecycle = status === undefined || status === "" ? undefined : own(LIFECYCLES, status);
      if (status !== undefined && status !== "" && lifecycle === undefined) {
        recordSkipped(feed.id, "unknown_value");
      }
      // The operator's contacts: a support line, and an e-mail address.
      const contacts = getXmlChildren(getXmlChild(row, "contactInformation"), "contact");
      const phone = contacts.map((c) => getXmlChildText(c, "phoneNumber")?.trim()).find((p) => p);
      const email = contacts.map((c) => getXmlChildText(c, "emailAddress")?.trim()).find((e) => e);
      const access = getXmlChild(row, "accessInformation");
      const accessText = getXmlChildText(access, "value")?.trim();
      const accessLang = getXmlChildText(access, "lang")?.trim();
      const compatible = getXmlChild(row, "vehicleTypeCompatibility");
      const listedTypes = compatible === undefined ? [] : [compatible["vehicleType"]].flat();
      const vehicleTypes = [
        ...new Set(
          listedTypes.flatMap((value) => {
            const name = typeof value === "string" ? value.trim() : "";
            if (name === "") return [];
            const types = own(VEHICLE_TYPES, name);
            if (types === undefined) recordSkipped(feed.id, "unknown_value");
            return types ?? [];
          }),
        ),
      ];
      out.features.push(
        siteDraft(
          feed,
          {
            stationId: id,
            point,
            name: id,
            ...(operator === undefined
              ? {}
              : { operator: { name: operator, ...(email === undefined ? {} : { email }) } }),
            ...(owner === undefined ? {} : { owner: { name: owner } }),
            address: { text: valueText(row, "chargingPointAddress") },
            ...hoursOf(valueText(row, "operatingTime")?.trim()),
            ...(getXmlChildText(row, "timeZone") === undefined ? {} : { timeZone: ZONE }),
            ...(phone === undefined ? {} : { hotline: phone }),
            ...(accessText === undefined || accessText === ""
              ? {}
              : { notes: accessText, ...(accessLang ? { notesLang: accessLang } : {}) }),
            lifecycle: lifecycle ?? "unknown",
            evses: [
              {
                key: id,
                ...(evseId === undefined ? {} : { evseId }),
                ...(vehicleTypes.length === 0 ? {} : { bays: [{ key: "1" }] }),
                connectors,
              },
            ],
            // The vehicles the point is compatible with are those its bay takes.
            ...(vehicleTypes.length === 0
              ? {}
              : { bays: [{ key: "1", details: { vehicleTypes } }] }),
          },
          ctx.fetchedAt,
        ),
      );
    }
  }
  return out;
}
