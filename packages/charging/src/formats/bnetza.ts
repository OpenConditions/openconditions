import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, PAYMENT_METHODS } from "@openconditions/model";
import { colocateSites } from "../colocate.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import {
  type ConnectorInput,
  type EvseInput,
  emi3Of,
  type Lifecycle,
  type PowerType,
  parsePowerKw,
  type SiteInput,
  siteDraft,
} from "../site.js";
import { type DelimitedRow, readDelimited } from "./delimited.js";
import { placeFromText, positiveInteger, text } from "./raw.js";

/** The register lists up to this many charge points of one device in its own columns. */
const SLOTS = 6;

const HEADER_START = "Ladeeinrichtungs-ID";

const COLUMNS = [
  HEADER_START,
  "Betreiber",
  "Anzeigename (Karte)",
  "Status",
  "Anzahl Ladepunkte",
  "Nennleistung Ladeeinrichtung [kW]",
  "Straße",
  "Hausnummer",
  "Postleitzahl",
  "Ort",
  "Breitengrad",
  "Längengrad",
  "Standortbezeichnung",
  "Informationen zum Parkraum",
  "Bezahlsysteme",
  "Öffnungszeiten",
  "Öffnungszeiten: Wochentage",
  "Öffnungszeiten: Tageszeiten",
  ...Array.from({ length: SLOTS }, (_, i) => [
    `Steckertypen${i + 1}`,
    `Nennleistung Stecker${i + 1}`,
    `EVSE-ID${i + 1}`,
  ]).flat(),
];

/** The register's states; it publishes no others today. */
const LIFECYCLES: Readonly<Record<string, Lifecycle>> = {
  "In Betrieb": "operational",
  "In Wartung": "temporarily_closed",
};

interface Plug {
  standard: string;
  format?: "socket" | "cable";
  powerType?: PowerType;
  current?: "ac" | "dc";
}

/**
 * The register's plug names: "Steckdose" is a socket, "Fahrzeugkupplung" a
 * cable with its coupler. Its CEE entries name the pole count but not the
 * amperage, so the plug stays unknown while the phases are kept.
 */
const PLUGS: Readonly<Record<string, Plug>> = {
  "AC Typ 2 Steckdose": { standard: "IEC_62196_T2", format: "socket", current: "ac" },
  "AC Typ 2 Fahrzeugkupplung": { standard: "IEC_62196_T2", format: "cable", current: "ac" },
  "AC Typ 1 Steckdose": { standard: "IEC_62196_T1", format: "socket", current: "ac" },
  "AC Typ 1 Fahrzeugkupplung": { standard: "IEC_62196_T1", format: "cable", current: "ac" },
  "AC Schuko": { standard: "DOMESTIC_F", format: "socket", current: "ac" },
  "AC CEE 5-polig": { standard: "UNKNOWN", format: "socket", powerType: "AC_3_PHASE" },
  "AC CEE 3-polig": { standard: "UNKNOWN", format: "socket", powerType: "AC_1_PHASE" },
  "DC Fahrzeugkupplung Typ Combo 2 (CCS)": {
    standard: "IEC_62196_T2_COMBO",
    format: "cable",
    powerType: "DC",
  },
  "DC Fahrzeugkupplung Typ Combo 1 (CCS)": {
    standard: "IEC_62196_T1_COMBO",
    format: "cable",
    powerType: "DC",
  },
  "DC CHAdeMO": { standard: "CHADEMO", format: "cable", powerType: "DC" },
  "DC Megawatt Charging System (MCS)": { standard: "MCS", format: "cable", powerType: "DC" },
  "DC Tesla Fahrzeugkupplung (Typ 2)": {
    standard: "IEC_62196_T2",
    format: "cable",
    powerType: "DC",
  },
};

type Payment = (typeof PAYMENT_METHODS)[number];

/** Each payment system the register names, with the methods it stands for. */
const PAYMENTS: Readonly<Record<string, readonly Payment[]>> = {
  Onlinezahlungsverfahren: ["app"],
  "RFID-Karte": ["rfid"],
  "Kreditkarte (NFC)": ["credit_card", "contactless"],
  "Debitkarte (NFC)": ["debit_card", "contactless"],
  "Kreditkarte (Lesegerät)": ["credit_card"],
  "Debitkarte (Lesegerät)": ["debit_card"],
  Kostenlos: ["free"],
  "Kostenlos (Registrierung)": ["free"],
  Bargeld: ["cash"],
  Sonstige: ["other"],
};

const WEEKDAYS: Readonly<Record<string, number>> = {
  montag: 1,
  dienstag: 2,
  mittwoch: 3,
  donnerstag: 4,
  freitag: 5,
  samstag: 6,
  sonntag: 7,
};

const CLOCK_SPAN = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;

/** The members of a list cell, in the order written. */
const items = (value: string | undefined): string[] =>
  (value ?? "")
    .split(/[;|]/)
    .map((v) => v.trim())
    .filter((v) => v !== "");

interface Hours {
  osm?: string;
  text?: string;
}

/**
 * "247" is round the clock and "Keine Angabe" says nothing. Otherwise the
 * weekday and time-of-day lists pair up by position (one time span stands for
 * every day) into OSM hours; lists that do not pair stay as written.
 */
function hoursOf(row: DelimitedRow): Hours {
  const kind = row["Öffnungszeiten"] ?? "";
  if (kind === "247") return { osm: "24/7" };
  const days = items(row["Öffnungszeiten: Wochentage"]);
  const times = items(row["Öffnungszeiten: Tageszeiten"]);
  if (days.length === 0 || times.length === 0) return {};
  const periods: WeeklyPeriod[] = [];
  days.forEach((name, i) => {
    const day = WEEKDAYS[name.toLowerCase()];
    const span = (times.length === 1 ? times[0] : times[i])?.match(CLOCK_SPAN);
    if (day !== undefined && span?.[1] !== undefined && span[2] !== undefined) {
      periods.push({ day, from: span[1], to: span[2] });
    }
  });
  const osm = periods.length === days.length ? osmOpeningHours(periods) : undefined;
  return osm === undefined ? { text: `${days.join(", ")}: ${times.join(", ")}` } : { osm };
}

const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  "keine beschränkung": "public",
  "nur für kunden/besucher": "customers",
};

/** The connectors of one charge point: a plug per list entry, power by position. */
function connectorsOf(plugs: string[], powers: (number | undefined)[]): ConnectorInput[] {
  if (plugs.length === 0) {
    return [
      {
        id: "1",
        standard: "UNKNOWN",
        ...(powers[0] === undefined ? {} : { maxPowerKw: powers[0] }),
      },
    ];
  }
  return plugs.map((name, j) => {
    const known = PLUGS[name];
    const kw = powers[j] ?? (powers.length === 1 ? powers[0] : undefined);
    return {
      id: String(j + 1),
      standard: known?.standard ?? "UNKNOWN",
      ...(known?.format === undefined ? {} : { format: known.format }),
      ...(known?.powerType === undefined ? {} : { powerType: known.powerType }),
      ...(known?.current === undefined ? {} : { current: known.current }),
      ...(kw === undefined ? {} : { maxPowerKw: kw }),
    };
  });
}

function evsesOf(stationId: string, row: DelimitedRow): EvseInput[] {
  const count = positiveInteger(row["Anzahl Ladepunkte"]);
  const deviceKw = parsePowerKw(row["Nennleistung Ladeeinrichtung [kW]"]);
  const slot = (i: number) => ({
    plugs: items(row[`Steckertypen${i}`]),
    powers: items(row[`Nennleistung Stecker${i}`]).map((p) => parsePowerKw(p)),
    id: text(row[`EVSE-ID${i}`]),
  });
  const filled = Array.from({ length: SLOTS }, (_, k) => k + 1).filter((i) => {
    const s = slot(i);
    return s.plugs.length > 0 || s.powers.length > 0 || s.id !== undefined;
  });
  const wanted =
    count === undefined
      ? filled.length === 0
        ? [1]
        : filled
      : Array.from({ length: Math.min(count, SLOTS) }, (_, k) => k + 1);
  const evses = wanted.map((i): EvseInput => {
    const s = slot(i);
    // A device of one charge point is rated as that point where the plug is not.
    const powers = s.powers.length === 0 && count === 1 ? [deviceKw] : s.powers;
    const evseId = emi3Of(s.id);
    return {
      key: evseId ?? `${stationId}-${i}`,
      ...(evseId === undefined ? {} : { evseId }),
      connectors: connectorsOf(s.plugs, powers),
    };
  });
  if (count !== undefined && count > SLOTS) {
    // Points past the sixth have no columns: the register states only how many there are.
    const rest = count - SLOTS;
    evses.push({
      key: rest === 1 ? `${stationId}-${SLOTS + 1}` : `${stationId}-more`,
      ...(rest === 1 ? {} : { quantity: rest }),
      connectors: [{ id: "1", standard: "UNKNOWN" }],
    });
  }
  return evses;
}

/**
 * One device of the register as a site of its own; `colocateSites` makes the
 * devices one operator registered together one site. The register names no
 * site where the map name and the location label are empty: the operator is
 * no name.
 */
function deviceSite(id: string, row: DelimitedRow, point: [number, number]): SiteInput {
  const hours = hoursOf(row);
  const payments = [...new Set(items(row["Bezahlsysteme"]).flatMap((p) => PAYMENTS[p] ?? []))];
  const audience = AUDIENCE[(row["Informationen zum Parkraum"] ?? "").toLowerCase()];
  const operator = text(row["Betreiber"]);
  const name = text(row["Anzeigename (Karte)"]) ?? text(row["Standortbezeichnung"]);
  return {
    stationId: id,
    point,
    lang: "de",
    externalIds: [{ scheme: "bnetza", id }],
    ...(name === undefined ? {} : { name }),
    ...(operator === undefined ? {} : { operator: { name: operator } }),
    address: {
      street: row["Straße"],
      houseNumber: row["Hausnummer"],
      postalCode: row["Postleitzahl"],
      city: row["Ort"],
    },
    lifecycle: LIFECYCLES[row["Status"] ?? ""] ?? "unknown",
    ...(hours.osm === undefined ? {} : { openingHoursOsm: hours.osm }),
    ...(hours.text === undefined ? {} : { openingHoursText: hours.text }),
    ...(audience === undefined ? {} : { audience }),
    ...(payments.length === 0 ? {} : { payment: payments }),
    ...(items(row["Bezahlsysteme"]).includes("Plug & Charge")
      ? { authentication: ["plug_and_charge" as const] }
      : {}),
    evses: evsesOf(id, row),
  };
}

/**
 * The Bundesnetzagentur charge-point register: a semicolon CSV with a ten-line
 * preamble, a byte order mark and decimal commas. A row is one device with the
 * charge points in its numbered column groups, and the devices one operator
 * registered within 15 m of each other (house numbers allowing) are one site,
 * named by its lowest device id, since two of a source's sites never link.
 * One device in service keeps the site in service; a device whose state
 * differs carries it on its own charge points. The commissioning date is no
 * update time. The register states no live status, so "In Betrieb" and
 * "In Wartung" set the lifecycle and no reading is written.
 */
export function parseBnetza(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  let rejected = 0;
  for (const body of payloads["main"] ?? []) {
    readDelimited(
      body,
      { delimiter: ";", columns: COLUMNS, headerStartsWith: HEADER_START },
      (row) => {
        const id = text(row[HEADER_START]);
        const point = placeFromText(row["Breitengrad"], row["Längengrad"]);
        if (id === undefined || point === undefined) {
          rejected++;
          return;
        }
        // A device listed twice is the device once, not a malformed row.
        if (seen.has(id)) return;
        seen.add(id);
        out.features.push(siteDraft(feed, deviceSite(id, row, point), ctx.fetchedAt));
      },
    );
  }
  out.rejected = rejected;
  return colocateSites(out);
}
