import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { type BorderCrossing, crossingOfCbsaOffice } from "../crossings.js";
import {
  type BorderFeed,
  type BorderMode,
  crossingDraft,
  type LaneGroupInput,
  utcInstant,
  type WaitValue,
  waitDraft,
} from "../records.js";
import { zonedInstant } from "../time.js";

const OFFICE = "Customs Office";
const LOCATION = "Location";
const UPDATED = "Last updated";

/** The Canada-bound flows CBSA reports: the U.S.-bound columns are always `--`. */
const FLOWS: readonly (readonly [string, BorderMode])[] = [
  ["Commercial Flow - Canada bound", "commercial"],
  ["Travellers Flow - Canada bound", "passenger"],
];

/** CBSA's zone labels, which match its ports' clocks (Saskatchewan keeps CST all year). */
const ZONE_OFFSETS: Readonly<Record<string, string>> = {
  NDT: "-02:30",
  NST: "-03:30",
  ADT: "-03:00",
  AST: "-04:00",
  EDT: "-04:00",
  EST: "-05:00",
  CDT: "-05:00",
  CST: "-06:00",
  MDT: "-06:00",
  MST: "-07:00",
  PDT: "-07:00",
  PST: "-08:00",
};

/**
 * One flow cell: `No Delay`, a wait (`5 minutes`, `1 minute`, `1 hour 5
 * minutes`), `Closed` or `Temporarily closed`; `Not Applicable` and `--` are
 * a flow the office does not have or does not report, `undefined` here.
 * Anything else is a queue whose state is unknown.
 */
export function cbsaFlow(cell: string | undefined): WaitValue | undefined {
  const value = cell?.trim() ?? "";
  if (value === "" || value === "--" || /^not applicable$/i.test(value)) return undefined;
  if (/^no delay$/i.test(value)) return { status: "no_delay" };
  if (/closed$/i.test(value)) return { status: "closed" };
  const wait = /^(?:(\d+)\s*hours?)?\s*(?:(\d+)\s*minutes?)?$/i.exec(value);
  if (wait !== null && (wait[1] !== undefined || wait[2] !== undefined)) {
    return { status: "delay", waitMinutes: Number(wait[1] ?? 0) * 60 + Number(wait[2] ?? 0) };
  }
  return { status: "unknown" };
}

/**
 * `Last updated` (`2026-10-14 16:15 CST`) as an instant: by its zone label,
 * or by the crossing's zone where the label is missing or unknown; undefined
 * when it is no date and time.
 */
function updatedAt(cell: string | undefined, crossing: BorderCrossing): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(?: ([A-Z]{2,4}))?$/.exec(cell?.trim() ?? "");
  if (m === null) return undefined;
  const time = `${m[2]!.padStart(2, "0")}:${m[3]}`;
  const offset = m[4] === undefined ? undefined : ZONE_OFFSETS[m[4]];
  const at =
    offset === undefined
      ? zonedInstant(m[1]!, time, crossing.zone).getTime()
      : Date.parse(`${m[1]}T${time}:00${offset}`);
  return Number.isNaN(at) ? undefined : at;
}

/** An office name as a feature's local id: lower case, accents dropped, anything else a dash. */
const slug = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * CBSA border wait times (`bwt-eng.csv`): one row per customs office of the
 * busiest land crossings, cells separated by `;;`, with the Canada-bound
 * commercial and traveller flows. CBSA publishes no office id and no
 * coordinates, so the office name is the key and its crossing in the vendored
 * table the place; an office the table lacks is rejected rather than guessed.
 *
 * Each flow the office has is a `lane_group` keyed by its mode, without a
 * programme (CBSA does not split its queues by one): travellers are the
 * passenger queue. `No Delay` is no delay without minutes, a stated wait a
 * delay of that many minutes, `Closed` and `Temporarily closed` a closed
 * queue. A row without a readable update time is dated by the fetch, and one
 * dated after the fetch is read as the fetch.
 */
export function parseCbsa(
  feed: BorderFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const fetched = Date.parse(ctx.fetchedAt);
  let rejected = 0;
  for (const payload of payloads["main"] ?? []) {
    const [header, ...rows] = payload
      .toString("utf8")
      .replace(/^﻿/, "")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    const columns = (header ?? "").split(";;").map((c) => c.trim());
    const column = (name: string) => columns.indexOf(name);
    if (column(OFFICE) < 0 || column(UPDATED) < 0 || FLOWS.every(([name]) => column(name) < 0)) {
      throw new Error("cbsa: the CSV lacks the office, update or Canada-bound flow columns");
    }
    for (const row of rows) {
      const cells = row.split(";;").map((c) => c.trim());
      const cell = (name: string) => (column(name) < 0 ? undefined : cells[column(name)]);
      const office = cell(OFFICE);
      const crossing = office ? crossingOfCbsaOffice(office) : undefined;
      if (!office || crossing === undefined) {
        rejected++;
        continue;
      }
      const other = crossing.countries.find((c) => c !== "CA") ?? crossing.countries[0];
      const lanes: LaneGroupInput[] = [];
      const waits: { key: string; value: WaitValue }[] = [];
      for (const [name, mode] of FLOWS) {
        const value = cbsaFlow(cell(name));
        if (value === undefined) continue;
        lanes.push({ key: mode, mode, direction: { from: other, to: "CA" } });
        waits.push({ key: mode, value });
      }
      if (lanes.length === 0) {
        rejected++;
        continue;
      }
      const updated = updatedAt(cell(UPDATED), crossing);
      const at = utcInstant(new Date(Math.min(updated ?? fetched, fetched)));
      const location = cell(LOCATION);
      const feature = crossingDraft(
        feed,
        crossing,
        {
          localId: slug(office),
          recordId: office,
          name: office,
          country: "CA",
          ...(location ? { areaDescription: location } : {}),
          lanes,
          modes: lanes.map((l) => l.mode),
        },
        ctx.fetchedAt,
      );
      out.features.push(feature);
      for (const { key, value } of waits) out.observations.push(waitDraft(feature, key, value, at));
    }
  }
  out.rejected = rejected;
  return out;
}
