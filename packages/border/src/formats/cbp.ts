import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { type BorderCrossing, crossingOfCbpPort } from "../crossings.js";
import {
  type BorderFeed,
  type BorderMode,
  type BorderProgram,
  type CrossingDraft,
  crossingDraft,
  type LaneGroupInput,
  openStatusDraft,
  utcInstant,
  type WaitValue,
  waitDraft,
} from "../records.js";
import { clock, dayBefore, HOUR_MS, wallClock, zonedInstant } from "../time.js";

/** CBP's queue groups: the lanes of one mode. */
const MODES: readonly (readonly [string, BorderMode])[] = [
  ["commercial_vehicle_lanes", "commercial"],
  ["passenger_vehicle_lanes", "passenger"],
  ["pedestrian_lanes", "pedestrian"],
];

/** CBP's queues within a group. NEXUS and SENTRI members share one queue. */
const PROGRAMS: Readonly<Record<string, BorderProgram>> = {
  standard_lanes: "standard",
  FAST_lanes: "fast",
  NEXUS_SENTRI_lanes: "trusted_traveller",
  ready_lanes: "ready_lane",
};

/**
 * CBP's queue states, in the English and the Spanish edition; `null` is a
 * queue the port does not have.
 */
const STATES: Readonly<Record<string, WaitValue["status"] | null>> = {
  "no delay": "no_delay",
  "sin demora": "no_delay",
  delay: "delay",
  demora: "delay",
  "lanes closed": "closed",
  "carriles cerrados": "closed",
  "update pending": "unknown",
  "actualización pendiente": "unknown",
  "n/a": null,
};

const PORT_STATES: Readonly<Record<string, "open" | "closed">> = {
  open: "open",
  abierto: "open",
  closed: "closed",
  cerrado: "closed",
};

/** How far past the fetch a queue's update time may lie and still be today's: the publisher's clock runs a little ahead. */
const AHEAD_MS = 10 * 60_000;

interface CbpLane {
  update_time?: unknown;
  operational_status?: unknown;
  delay_minutes?: unknown;
  lanes_open?: unknown;
}

type CbpPort = Record<string, unknown> & {
  port_number?: unknown;
  port_name?: unknown;
  crossing_name?: unknown;
  hours?: unknown;
  construction_notice?: unknown;
  date?: unknown;
  time?: unknown;
  port_status?: unknown;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const count = (value: unknown): number | undefined => {
  const s = text(value);
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined;
};

/** The port page's wall clock: `date` `M/D/YYYY` and `time` `HH:MM:SS`. */
function pageClock(port: CbpPort): { date: string; time: string } | undefined {
  const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text(port.date) ?? "");
  const time = /^(\d{2}):(\d{2}):(\d{2})$/.exec(text(port.time) ?? "");
  if (date === null || time === null) return undefined;
  return {
    date: `${date[3]}-${date[1]!.padStart(2, "0")}-${date[2]!.padStart(2, "0")}`,
    time: time[0],
  };
}

/** A queue's `update_time` (`At 4:00 pm EDT`, `At Midnight EDT`, `En 4:00 pm EDT`) as `HH:MM`; the zone label is not read. */
function updateClock(value: unknown): string | undefined {
  const m =
    /^(?:at|en)\s+(?:(\d{1,2}):(\d{2})\s*(am|pm)|(midnight|medianoche|noon|mediodía))\b/i.exec(
      text(value) ?? "",
    );
  if (m === null) return undefined;
  if (m[4] !== undefined) return /^(midnight|medianoche)$/i.test(m[4]) ? "00:00" : "12:00";
  const hour = Number(m[1]);
  if (hour < 1 || hour > 12) return undefined;
  return clock(hour, Number(m[2]), m[3]!.toLowerCase() as "am" | "pm");
}

/**
 * CBP's opening hours (`24 hrs/day`, `6 am-10 pm`, `6 am-Midnight`) in the OSM
 * grammar, in the port's zone; anything else is left out.
 */
export function cbpOpeningHours(
  hours: string | undefined,
  zone: string,
): Record<string, unknown> | undefined {
  if (hours === undefined) return undefined;
  if (/^24 hrs\/d[ií]a$|^24 hrs\/day$/i.test(hours)) {
    return { osm: "24/7", twentyFourSeven: true, timezone: zone };
  }
  const m = /^(\d{1,2}) (am|pm)-(?:(\d{1,2}) (am|pm)|(midnight|medianoche))$/i.exec(hours);
  if (m === null) return undefined;
  const open = clock(Number(m[1]), 0, m[2]!.toLowerCase() as "am" | "pm");
  const close =
    m[5] !== undefined ? "24:00" : clock(Number(m[3]), 0, m[4]!.toLowerCase() as "am" | "pm");
  return { osm: `${open}-${close}`, timezone: zone };
}

/** Whether a port states no queue: every queue it lists is N/A or pending an update. */
function statesNoQueue(port: CbpPort): boolean {
  return MODES.every(([field]) => {
    const group = port[field];
    if (typeof group !== "object" || group === null) return true;
    return Object.keys(PROGRAMS).every((name) => {
      const lane = (group as Record<string, unknown>)[name];
      if (typeof lane !== "object" || lane === null) return true;
      const said = text((lane as CbpLane).operational_status)?.toLowerCase();
      if (said === undefined || !Object.hasOwn(STATES, said)) return false;
      return STATES[said] === null || STATES[said] === "unknown";
    });
  });
}

/**
 * The instant most ports' page clocks name, to within a minute: when CBP
 * wrote the page (its ports' clocks differ by a second or so).
 */
function pageInstant(pages: readonly Date[]): number | undefined {
  let best: { at: number; agreeing: number } | undefined;
  for (const page of pages) {
    const at = page.getTime();
    const agreeing = pages.filter((other) => Math.abs(other.getTime() - at) <= 60_000).length;
    if (best === undefined || agreeing > best.agreeing) best = { at, agreeing };
  }
  return best?.at;
}

interface Located {
  port: CbpPort;
  portNumber: string;
  crossing: BorderCrossing;
  page?: { date: string; time: string };
  pageAt?: Date;
}

/**
 * CBP Border Wait Times (`/api/bwtnew`): one record per U.S. port of entry
 * crossing, with the U.S.-bound queues it inspects. Each port is one
 * `border_crossing`, placed at its crossing of the vendored table (neither
 * coordinates nor an id beyond the port number are published); a port the
 * table lacks is skipped as unplaced rather than guessed, unless it states
 * no queue (every queue N/A or pending): then it carries nothing to place
 * and is left out. A port without a number, or one with no queue and no
 * lanes of any mode, is skipped as malformed. CBP's El Paso record 240221, the port as a whole with no
 * crossing named, has been all pending since it appeared in 2026; it
 * stands for none of El Paso's four bridges, which report on their own.
 *
 * A queue is a `lane_group` keyed `mode/programme`: commercial, passenger and
 * pedestrian lanes, each standard, FAST, NEXUS/SENTRI or Ready Lane. A queue
 * CBP marks N/A does not exist at the port and gets no lane group. "no delay"
 * and "delay" keep the minutes and open lanes CBP states ("no delay" carries
 * up to a few minutes); "Lanes Closed" is a closed queue and "Update Pending"
 * one whose state is unknown, neither with minutes; a state CBP did not
 * write before is unknown too, and counted as a value not read. The port's
 * `port_status` is the crossing's `facility.open_status`, unknown and
 * counted alike when it is another word. A mode's `maximum_lanes` is the
 * lanes in all of its queue where the mode has one queue only; with several,
 * CBP does not say how the lanes divide. The port's opening hours are counted
 * when `cbpOpeningHours` cannot read them, and its notice to travellers
 * (`construction_notice`) is the crossing's description. How CBP measures a
 * mode's wait (`*_automation_type`: manually, by Bluetooth or RFID) is not
 * read: the wait reading has no field for it.
 *
 * Times are wall-clock times without a date, and their zone labels are
 * wrong at some ports (EST in summer, PST in Arizona), so the vendored zone
 * dates them. Some ports' clocks are moreover an hour off that zone: every
 * port's page time names one instant, the one most ports agree on, and a
 * port whose page time is off by whole hours has its queue times read with
 * the same offset. A queue time later than the fetch (beyond a few minutes'
 * clock skew) is yesterday's; one just past it is read as the fetch. A
 * reading without a time of its own (a closed or pending queue, the port's
 * status) is dated by the page.
 */
export function parseCbp(feed: BorderFeed, payloads: FeedPayloads, ctx: ParseContext): ParseOutput {
  const out = emptyParseOutput();
  const fetched = Date.parse(ctx.fetchedAt);
  const located: Located[] = [];
  for (const payload of payloads["main"] ?? []) {
    const answer = JSON.parse(payload.toString("utf8").replace(/^﻿/, "")) as unknown;
    if (!Array.isArray(answer)) throw new Error("cbp: the answer is not a list of ports");
    for (const port of answer as CbpPort[]) {
      // A list entry that is no object (a `null`) is a malformed port, not a failed poll.
      const portNumber =
        typeof port === "object" && port !== null && !Array.isArray(port)
          ? text(port.port_number)
          : undefined;
      const crossing = portNumber === undefined ? undefined : crossingOfCbpPort(portNumber);
      if (portNumber === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (crossing === undefined) {
        // A port the table lacks that states no queue has nothing to place.
        if (!statesNoQueue(port)) recordSkipped(feed.id, "no_geometry");
        continue;
      }
      const page = pageClock(port);
      located.push({
        port,
        portNumber,
        crossing,
        ...(page === undefined
          ? {}
          : { page, pageAt: zonedInstant(page.date, page.time, crossing.zone) }),
      });
    }
  }

  const written = pageInstant(located.flatMap((l) => (l.pageAt === undefined ? [] : [l.pageAt])));
  const pageAt = written !== undefined && written <= fetched + AHEAD_MS ? written : undefined;
  const undated = utcInstant(new Date(Math.min(pageAt ?? fetched, fetched)));

  for (const { port, portNumber, crossing, page, pageAt: portPageAt } of located) {
    const skew =
      pageAt === undefined || portPageAt === undefined
        ? 0
        : Math.round((portPageAt.getTime() - pageAt) / HOUR_MS) * HOUR_MS;
    const today = page?.date ?? wallClock(new Date(fetched), crossing.zone).date;
    const queueTime = (lane: CbpLane): string => {
      const hhmm = updateClock(lane.update_time);
      if (hhmm === undefined) return undated;
      let at = zonedInstant(today, hhmm, crossing.zone).getTime() - skew;
      if (at > fetched + AHEAD_MS) {
        at = zonedInstant(dayBefore(today), hhmm, crossing.zone).getTime() - skew;
      }
      return utcInstant(new Date(Math.min(at, fetched)));
    };

    const other = crossing.countries.find((c) => c !== "US") ?? crossing.countries[0];
    const lanes: LaneGroupInput[] = [];
    const waits: { key: string; value: WaitValue; at: string }[] = [];
    const reported = new Set<BorderMode>();
    const maxLanes = new Map<BorderMode, number>();
    let unread = 0;
    for (const [field, mode] of MODES) {
      const group = port[field];
      if (typeof group !== "object" || group === null) continue;
      const groupFields = group as Record<string, unknown>;
      const maximum = count(groupFields["maximum_lanes"]);
      if (maximum !== undefined) reported.add(mode);
      if (maximum !== undefined && maximum > 0) maxLanes.set(mode, maximum);
      for (const [name, program] of Object.entries(PROGRAMS)) {
        const lane = groupFields[name] as CbpLane | undefined;
        if (typeof lane !== "object" || lane === null) continue;
        const said = text(lane.operational_status)?.toLowerCase();
        const known = said !== undefined && Object.hasOwn(STATES, said);
        const status = known ? (STATES[said] ?? null) : "unknown";
        if (status === null) continue;
        if (!known && said !== undefined) unread++;
        const key = `${mode}/${program}`;
        lanes.push({ key, mode, program, direction: { from: other, to: "US" } });
        const minutes = count(lane.delay_minutes);
        const open = count(lane.lanes_open);
        const counted = status === "delay" || status === "no_delay";
        waits.push({
          key,
          value: {
            status,
            ...(counted && minutes !== undefined ? { waitMinutes: minutes } : {}),
            ...(counted && open !== undefined ? { lanesOpen: open } : {}),
          },
          at: counted ? queueTime(lane) : undated,
        });
      }
    }
    const modes = [...new Set(lanes.map((l) => l.mode))];
    if (modes.length === 0) modes.push(...MODES.map(([, m]) => m).filter((m) => reported.has(m)));
    if (modes.length === 0) {
      recordSkipped(feed.id, "malformed");
      continue;
    }

    // A mode's lanes in all are its one queue's where it has no other.
    for (const lane of lanes) {
      const total = maxLanes.get(lane.mode);
      if (total !== undefined && lanes.filter((l) => l.mode === lane.mode).length === 1) {
        lane.lanesTotal = total;
      }
    }

    const portName = text(port.port_name) ?? portNumber;
    const crossingName = text(port.crossing_name);
    const hours = text(port.hours);
    const openingHours = cbpOpeningHours(hours, crossing.zone);
    if (hours !== undefined && openingHours === undefined) unread++;
    const notice = text(port.construction_notice)?.replace(/\s+/g, " ");
    const feature: CrossingDraft = crossingDraft(
      feed,
      crossing,
      {
        localId: portNumber,
        recordId: portNumber,
        name: crossingName === undefined ? portName : `${portName}: ${crossingName}`,
        country: "US",
        portIds: [{ scheme: "cbp:port", id: portNumber, authority: "CBP" }],
        ...(openingHours === undefined ? {} : { openingHours }),
        ...(notice === undefined ? {} : { description: notice }),
        lanes,
        modes,
      },
      ctx.fetchedAt,
    );
    out.features.push(feature);
    const stated = text(port.port_status)?.toLowerCase();
    const portState =
      stated !== undefined && Object.hasOwn(PORT_STATES, stated) ? PORT_STATES[stated]! : "unknown";
    if (stated !== undefined && portState === "unknown") unread++;
    recordSkipped(feed.id, "unknown_value", unread);
    out.observations.push(openStatusDraft(feature, portState, undated));
    for (const { key, value, at } of waits)
      out.observations.push(waitDraft(feature, key, value, at));
  }
  return out;
}
