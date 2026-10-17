import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { own } from "../records.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  instantIn,
  type ParkingType,
  type PowerType,
  parsePowerKw,
  type SiteInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader } from "../status.js";
import { isRecord, placeFromText, type Raw, text, unplacedReason } from "./raw.js";

const ZONE = "Asia/Seoul";

const CHADEMO = { standard: "CHADEMO", current: "dc", powerType: "DC" } as const;
const AC_SLOW = { standard: "IEC_62196_T1", current: "ac" } as const;
const AC_3_PHASE = { standard: "IEC_62196_T2", current: "ac", powerType: "AC_3_PHASE" } as const;
const DC_COMBO = { standard: "IEC_62196_T1_COMBO", current: "dc", powerType: "DC" } as const;
const NACS = { standard: "SAE_J3400" } as const;

type Plug = { standard: string; current?: "ac" | "dc"; powerType?: PowerType };

/**
 * `chgerType`: the plugs one charger has. Korean slow AC is Type 1 and its
 * three-phase AC Type 2; its combo is CCS1, except the bus-only CCS2 of 11.
 */
const CHARGER_TYPES: Readonly<Record<string, readonly Plug[]>> = {
  "01": [CHADEMO],
  "02": [AC_SLOW],
  "03": [CHADEMO, AC_3_PHASE],
  "04": [DC_COMBO],
  "05": [CHADEMO, DC_COMBO],
  "06": [CHADEMO, AC_3_PHASE, DC_COMBO],
  "07": [AC_3_PHASE],
  "08": [DC_COMBO],
  "09": [NACS],
  "10": [DC_COMBO, NACS],
  "11": [{ standard: "IEC_62196_T2_COMBO", current: "dc", powerType: "DC" }],
};

/**
 * `stat`: what the charger is doing. A lost connection or an unconfirmed
 * state is unknown; operation suspended (4) and under inspection (5,
 * 점검중) are not available for now, with nothing said of a fault.
 */
const STATES: Readonly<Record<string, EvseStatus>> = {
  "0": "unknown",
  "1": "unknown",
  "2": "available",
  "3": "charging",
  "4": "inoperative",
  "5": "inoperative",
  "6": "reserved",
  "9": "unknown",
};

/** `zcode`: the province (시도) of the station, by the first two digits of its administrative code. */
const PROVINCES: Readonly<Record<string, string>> = {
  "11": "서울특별시",
  "12": "전남광주통합특별시",
  "26": "부산광역시",
  "27": "대구광역시",
  "28": "인천광역시",
  "30": "대전광역시",
  "31": "울산광역시",
  "36": "세종특별자치시",
  "41": "경기도",
  "43": "충청북도",
  "44": "충청남도",
  "47": "경상북도",
  "48": "경상남도",
  "50": "제주특별자치도",
  "51": "강원특별자치도",
  "52": "전북특별자치도",
};

/**
 * `kindDetail`: a car park is a parking lot and an expressway service area
 * (C001) a site along a motorway; the venues are amenities of the station.
 * Public offices, housing, schools and the like name nothing the site
 * offers a driver.
 */
const KINDS: Readonly<Record<string, { parking?: ParkingType; amenities?: string[] }>> = {
  B001: { parking: "parking_lot" },
  B002: { parking: "parking_lot" },
  B003: { parking: "parking_lot", amenities: ["public_transport_hub"] },
  B004: { parking: "parking_lot" },
  C001: { parking: "along_motorway" },
  D001: { amenities: ["recreation_area"] },
  D004: { amenities: ["nature"] },
  D008: { amenities: ["museum"] },
  E001: { amenities: ["mall"] },
  E002: { amenities: ["mall"] },
  E003: { amenities: ["overnight_accommodation"] },
  E005: { amenities: ["cafe"] },
  E006: { amenities: ["restaurant"] },
  E007: { amenities: ["petrol_station"] },
  E008: { amenities: ["leisure"] },
  F001: { amenities: ["vehicle_maintenance"] },
  F002: { amenities: ["vehicle_maintenance"] },
  G002: { amenities: ["overnight_accommodation"] },
  I001: { amenities: ["medical_facility"] },
  ...Object.fromEntries(
    [
      "A001",
      "A002",
      "A003",
      "A004",
      "C002",
      "C003",
      "D002",
      "D003",
      "D005",
      "D006",
      "D007",
      "D009",
      "E004",
      "G001",
      "G003",
      "G004",
      "G005",
      "G006",
      "H001",
      "H002",
      "H003",
      "H004",
      "H005",
      "I002",
      "I003",
      "I004",
      "I005",
      "I006",
      "I007",
      "I008",
      "J001",
      "J002",
      "J003",
      "J004",
      "J005",
      "J006",
      "J007",
    ].map((code) => [code, {}]),
  ),
};

/** The items of one answer page: `items.item`, a list or a single item. */
function itemsOf(body: Buffer): Raw[] {
  const doc = JSON.parse(body.toString("utf8")) as unknown;
  const root = isRecord(doc) && isRecord(doc["response"]) ? doc["response"] : doc;
  const holder = isRecord(root) && isRecord(root["body"]) ? root["body"] : root;
  const items = isRecord(holder) && isRecord(holder["items"]) ? holder["items"]["item"] : undefined;
  return (Array.isArray(items) ? items : [items]).filter(isRecord);
}

/** `20190829121020`, wall-clock time in Seoul, as a UTC instant. */
function seoulInstant(value: unknown): string | undefined {
  const m = text(value)?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m === null || m === undefined) return undefined;
  return instantIn(ZONE, `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
}

/**
 * A charger's plugs. `output` is the charger's power: a charger with DC plugs
 * delivers it on those, and its AC plug of unstated power. A charger type the
 * API does not list is left unread and counted.
 */
function connectorsOf(feedId: string, item: Raw): ConnectorInput[] {
  const type = text(item["chgerType"]);
  const known = own(CHARGER_TYPES, type);
  if (type !== undefined && known === undefined) recordSkipped(feedId, "unknown_value");
  const plugs = known ?? [{ standard: "UNKNOWN" }];
  const kw = parsePowerKw(item["output"]);
  const fast = plugs.some((p) => p.current === "dc");
  return plugs.map((p) => ({
    id: p.standard,
    standard: p.standard,
    ...(p.powerType === undefined ? {} : { powerType: p.powerType }),
    ...(p.current === undefined ? {} : { current: p.current }),
    ...(kw !== undefined && (!fast || p.current !== "ac") ? { maxPowerKw: kw } : {}),
  }));
}

/** `floorType` (지상 F above ground, 지하 B below) and `floorNum`: `2`, or `B1` below ground. */
function floorOf(item: Raw): string | undefined {
  const num = text(item["floorNum"]);
  if (num === undefined) return undefined;
  return text(item["floorType"])?.toUpperCase() === "B" ? `B${num}` : num;
}

/** The first value of a field any of a station's chargers gives. */
const firstOf = (chargers: readonly Raw[], field: string) =>
  chargers.map((c) => text(c[field])).find((v) => v !== undefined);

/** `useTime`: `24시간 …` is open around the clock; anything else is the publisher's text. */
function hoursOf(
  useTime: string | undefined,
): Pick<SiteInput, "twentyFourSeven" | "openingHoursText"> {
  if (useTime === undefined) return {};
  return /^24\s*시간/.test(useTime) ? { twentyFourSeven: true } : { openingHoursText: useTime };
}

/**
 * Korea Environment Corporation's charger API: `getChargerInfo` pages in
 * `main`, one item per charger, whose station (`statId`) is the site and the
 * charger (`chgerId`) its charge point; `getChargerStatus` in `status`, the
 * chargers whose state changed in the last minutes. The pipeline hands over
 * every status answer since the information was fetched, so the daily state
 * with every change since is each charger's state now, read as of its change
 * time (`statUpdDt`, Seoul time), and no reading when that lies more than 30
 * days back. A deleted charger (`delYn=Y`) is left out. A charger without its
 * station or charger id is malformed; a station whose first charger places
 * nothing is counted once, as such.
 */
export function parseKeco(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const stations = new Map<string, Raw[]>();
  for (const item of (payloads["main"] ?? []).flatMap(itemsOf)) {
    if (text(item["delYn"])?.toUpperCase() === "Y") continue;
    const statId = text(item["statId"]);
    if (statId === undefined) {
      recordSkipped(feed.id, "malformed");
      continue;
    }
    stations.set(statId, [...(stations.get(statId) ?? []), item]);
  }
  const index: StatusIndexDraft = new Map();
  for (const [statId, chargers] of stations) {
    const [first] = chargers;
    if (first === undefined) continue;
    const point = placeFromText(first["lat"], first["lng"]);
    if (point === undefined) {
      recordSkipped(feed.id, unplacedReason(first["lat"], first["lng"]));
      continue;
    }
    const evses: EvseInput[] = [];
    for (const charger of chargers) {
      const chgerId = text(charger["chgerId"]);
      if (chgerId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const floor = floorOf(charger);
      const location = text(charger["location"]);
      evses.push({
        key: chgerId,
        ...(floor === undefined ? {} : { floorLevel: floor }),
        ...(location === undefined ? {} : { directions: [{ lang: "ko", text: location }] }),
        connectors: connectorsOf(feed.id, charger),
      });
      const stat = text(charger["stat"]);
      const changed = seoulInstant(charger["statUpdDt"]);
      indexStatus(index, chargerKey(statId, chgerId), {
        stationId: statId,
        evseKey: chgerId,
        point,
        ...(stat === undefined ? {} : { snapshotStatus: stat }),
        ...(changed === undefined ? {} : { snapshotAt: changed }),
      });
    }
    // A station's attributes are repeated on each charger; the first that gives one counts.
    const field = (name: string) => firstOf(chargers, name);
    const operator = field("busiNm");
    const operatorId = field("busiId");
    const phone = field("busiCall");
    const limited = field("limitYn")?.toUpperCase();
    const notes = [field("note"), limited === "Y" ? field("limitDetail") : undefined]
      .filter((n) => n !== undefined)
      .join("; ");
    const kindCode = field("kindDetail");
    const kind = own(KINDS, kindCode);
    if (kindCode !== undefined && kind === undefined) recordSkipped(feed.id, "unknown_value");
    const zcode = field("zcode");
    const province = own(PROVINCES, zcode);
    if (zcode !== undefined && province === undefined) recordSkipped(feed.id, "unknown_value");
    const detail = field("addrDetail");
    out.features.push(
      siteDraft(
        feed,
        {
          stationId: statId,
          point,
          name: field("statNm"),
          lang: "ko",
          ...(operator === undefined
            ? {}
            : {
                operator: {
                  name: operator,
                  ...(phone === undefined ? {} : { phone }),
                  ...(operatorId === undefined
                    ? {}
                    : { ids: [{ scheme: "cpo", id: operatorId, authority: feed.id }] }),
                },
              }),
          address: { text: field("addr"), region: province },
          ...(detail === undefined ? {} : { directions: [{ lang: "ko", text: detail }] }),
          ...(phone === undefined ? {} : { hotline: phone }),
          ...hoursOf(field("useTime")),
          ...(limited === "N" ? { audience: "public" as const } : {}),
          ...(limited === "Y" ? { audience: "restricted" as const } : {}),
          ...(kind?.parking === undefined ? {} : { parkingType: kind.parking }),
          ...(kind?.amenities === undefined ? {} : { amenities: kind.amenities }),
          notes,
          evses,
        },
        ctx.fetchedAt,
      ),
    );
  }
  out.statusIndex = index;
  out.observations = parseKecoStatus(feed, payloads, ctx, index).observations;
  return out;
}

const chargerKey = (statId: string | undefined, chgerId: string | undefined) =>
  `${statId}\u0000${chgerId}`;

/** When a state last changed, in epoch ms; 0 when unreadable. */
const msOf = (instant: string | undefined) => Date.parse(instant ?? "") || 0;

/**
 * Every indexed charger's state now: the daily state with every change since
 * the information was fetched, oldest poll first. A charger's latest change
 * stands, and a change older than the state it would replace changes
 * nothing. Read as of its change time, unless that lies more than 30 days
 * back; a change of a charger the index does not hold is rejected, and a
 * state the API does not list is no reading and counted.
 */
export function parseKecoStatus(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  const reader = statusReader(feed, ctx);
  const updates = new Map<string, { stat: string | undefined; at: string | undefined }>();
  for (const item of (payloads["status"] ?? []).flatMap(itemsOf)) {
    const key = chargerKey(text(item["statId"]), text(item["chgerId"]));
    if (!index.has(key)) {
      reader.reject();
      continue;
    }
    const update = { stat: text(item["stat"]), at: seoulInstant(item["statUpdDt"]) };
    const held = updates.get(key);
    if (held === undefined || msOf(update.at) >= msOf(held.at)) updates.set(key, update);
  }
  for (const [key, subjects] of index) {
    const update = updates.get(key);
    let unread = false;
    for (const subject of subjects) {
      const state =
        update !== undefined && msOf(update.at) >= msOf(subject.snapshotAt)
          ? update
          : { stat: subject.snapshotStatus, at: subject.snapshotAt };
      if (!statusIsLive(state.at, ctx.fetchedAt)) continue;
      const status = own(STATES, state.stat);
      if (status === undefined) {
        unread ||= state.stat !== undefined;
        continue;
      }
      reader.read(subject, status, state.at);
    }
    if (unread) recordSkipped(feed.id, "unknown_value");
  }
  return reader.output();
}
