import { emptyParseOutput, type ParseOutput } from "@openconditions/ingest-framework";
import type { HazardsFeed } from "../records.js";
import { capToken, currentMessages } from "./messages.js";
import { type CapSituationOptions, capDrafts, capEnd } from "./situations.js";
import type { CapAlert } from "./types.js";

export type CapOutputOptions = Omit<CapSituationOptions, "groupId"> & {
  /** Payloads of one message each that did not decode: input records, each rejected. */
  unreadable?: number;
};

const HEADER = ["identifier", "sender", "sent", "status", "msgType", "scope"] as const;

/** Whether a message carries the header fields every situation of it needs, `sent` as a time. */
const readable = (alert: CapAlert) =>
  HEADER.every((field) => capToken(alert[field]) !== "") && !Number.isNaN(Date.parse(alert.sent));

/**
 * Whether every hazard of a message ended (`capEnd`) before the poll read
 * it. A message log (the ECCC Datamart) still lists such a message, which
 * would otherwise be published only for the sweep to end it.
 */
function expiredAt(
  alert: CapAlert,
  fetchedAt: string,
  endOf: CapSituationOptions["endOf"],
): boolean {
  const at = Date.parse(fetchedAt);
  const infos = Array.isArray(alert.info) ? alert.info : [];
  return (
    infos.length > 0 &&
    infos.every((i) => {
      const end = Date.parse(capEnd(i, endOf) ?? "");
      return !Number.isNaN(end) && end < at;
    })
  );
}

/**
 * Every message of one parse as situations, with the record accounting a
 * complete snapshot owes: `inputCount` the messages, `terminal` those that
 * end here (superseded by another message of the parse, not `Actual`,
 * expired before the poll, or a cancel without info blocks, which ends its
 * warning and describes nothing), `accepted` the situations. A quiet poll
 * with no message is an accounted zero, which publishes zero instead of
 * being refused. A message that does not read is rejected, never the parse.
 */
export function capOutput(
  alerts: readonly CapAlert[],
  feed: HazardsFeed,
  opts: CapOutputOptions,
): ParseOutput {
  const { unreadable = 0, ...situationOpts } = opts;
  const out = emptyParseOutput();
  let rejected = unreadable;
  let terminal = 0;
  const unique = new Map<string, CapAlert>();
  // Messages that cannot be read are unique records too, each rejected: a
  // poll whose every non-terminal record was rejected is told apart from a
  // quiet one by `rejected` against `uniqueCount - terminal`.
  let unreadableMessages = unreadable;
  let duplicates = 0;
  for (const alert of alerts) {
    if (!readable(alert)) {
      rejected++;
      unreadableMessages++;
    } else if (unique.has(alert.identifier)) {
      duplicates++;
    } else {
      unique.set(alert.identifier, alert);
    }
  }
  const actual = [...unique.values()].filter((a) => capToken(a.status) === "Actual");
  terminal += unique.size - actual.length;
  const { current, superseded, groupOf } = currentMessages(actual);
  terminal += superseded;
  for (const alert of current) {
    if (!Array.isArray(alert.info) || alert.info.length === 0) {
      if (capToken(alert.msgType) === "Cancel") terminal++;
      else rejected++;
      continue;
    }
    if (expiredAt(alert, opts.fetchedAt, opts.endOf)) {
      terminal++;
      continue;
    }
    const groupId = groupOf(alert.identifier);
    const drafts = capDrafts(alert, feed, { ...situationOpts, groupId });
    out.situations.push(...drafts.drafts);
    rejected += drafts.rejected;
  }
  out.records = {
    inputCount: alerts.length + unreadable,
    uniqueCount: unique.size + unreadableMessages,
    duplicates,
    accepted: out.situations.length,
    terminal,
    unlocatable: 0,
    unlocatableSituations: [],
    unlocatableRecords: [],
    situationRecords: Object.fromEntries(out.situations.map((s) => [String(s["id"]), 1])),
  };
  if (rejected > 0) out.rejected = rejected;
  return out;
}
