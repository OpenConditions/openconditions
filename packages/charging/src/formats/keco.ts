import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  instantIn,
  parsePowerKw,
  type SiteInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader } from "../status.js";
import { isRecord, placeFromText, type Raw, text } from "./raw.js";

const ZONE = "Asia/Seoul";

const CHADEMO = { standard: "CHADEMO", current: "dc" } as const;
const AC_SLOW = { standard: "IEC_62196_T1", current: "ac" } as const;
const AC_3_PHASE = { standard: "IEC_62196_T2", current: "ac" } as const;
const DC_COMBO = { standard: "IEC_62196_T1_COMBO", current: "dc" } as const;
const NACS = { standard: "SAE_J3400" } as const;

type Plug = { standard: string; current?: "ac" | "dc" };

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
  "11": [{ standard: "IEC_62196_T2_COMBO", current: "dc" }],
};

/** `stat`: what the charger is doing. A lost connection or an unconfirmed state is unknown. */
const STATES: Readonly<Record<string, EvseStatus>> = {
  "0": "unknown",
  "1": "unknown",
  "2": "available",
  "3": "charging",
  "4": "inoperative",
  "5": "out_of_order",
  "6": "reserved",
  "9": "unknown",
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
 * delivers it on those, and its AC plug of unstated power.
 */
function connectorsOf(item: Raw): ConnectorInput[] {
  const plugs = CHARGER_TYPES[text(item["chgerType"]) ?? ""] ?? [{ standard: "UNKNOWN" }];
  const kw = parsePowerKw(item["output"]);
  const fast = plugs.some((p) => p.current === "dc");
  return plugs.map((p) => ({
    id: p.standard,
    standard: p.standard,
    ...(p.current === undefined ? {} : { current: p.current }),
    ...(kw !== undefined && (!fast || p.current !== "ac") ? { maxPowerKw: kw } : {}),
  }));
}

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
 * days back. A deleted charger (`delYn=Y`) is left out.
 */
export function parseKeco(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const stations = new Map<string, Raw[]>();
  for (const item of (payloads["main"] ?? []).flatMap(itemsOf)) {
    const statId = text(item["statId"]);
    if (statId === undefined || text(item["delYn"])?.toUpperCase() === "Y") continue;
    stations.set(statId, [...(stations.get(statId) ?? []), item]);
  }
  const index: StatusIndexDraft = new Map();
  let rejected = 0;
  for (const [statId, chargers] of stations) {
    const [first] = chargers;
    const point = first === undefined ? undefined : placeFromText(first["lat"], first["lng"]);
    if (first === undefined || point === undefined) {
      rejected++;
      continue;
    }
    const evses: EvseInput[] = [];
    for (const charger of chargers) {
      const chgerId = text(charger["chgerId"]);
      if (chgerId === undefined) continue;
      evses.push({ key: chgerId, connectors: connectorsOf(charger) });
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
    const operator = text(first["busiNm"]);
    const limited = text(first["limitYn"])?.toUpperCase();
    const notes = [text(first["note"]), limited === "Y" ? text(first["limitDetail"]) : undefined]
      .filter((n) => n !== undefined)
      .join("; ");
    out.features.push(
      siteDraft(
        feed,
        {
          stationId: statId,
          point,
          name: text(first["statNm"]),
          lang: "ko",
          ...(operator === undefined ? {} : { operator: { name: operator } }),
          address: { text: text(first["addr"]) },
          ...hoursOf(text(first["useTime"])),
          ...(limited === "N" ? { audience: "public" as const } : {}),
          ...(limited === "Y" ? { audience: "restricted" as const } : {}),
          notes,
          evses,
        },
        ctx.fetchedAt,
      ),
    );
  }
  out.rejected = rejected;
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
 * back; a change of a charger the index does not hold is rejected.
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
    for (const subject of subjects) {
      const state =
        update !== undefined && msOf(update.at) >= msOf(subject.snapshotAt)
          ? update
          : { stat: subject.snapshotStatus, at: subject.snapshotAt };
      const status = STATES[state.stat ?? ""];
      if (status === undefined || !statusIsLive(state.at, ctx.fetchedAt)) continue;
      reader.read(subject, status, state.at);
    }
  }
  return reader.output();
}
