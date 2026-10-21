import {
  addSkips,
  emptyParseOutput,
  type ParseOutput,
  type RecordSkipReason,
  recordSkipped,
  type SkipCounts,
  type SkipReason,
} from "@openconditions/ingest-framework";
import { CAP_1_2 } from "@openconditions/model-hazards";
import { type HazardsFeed, isRecord } from "../records.js";
import { capToken, currentMessages } from "./messages.js";
import { type CapSituationOptions, capDrafts, capEnd, capInstant } from "./situations.js";
import type { CapAlert } from "./types.js";

export type CapOutputOptions = Omit<CapSituationOptions, "groupId"> & {
  /**
   * Payloads or entries that did not decode into a message, by the reason
   * each is skipped: input records, each one message.
   */
  undecoded?: Partial<Record<RecordSkipReason, number>>;
};

const HEADER = ["identifier", "sender", "sent", "status", "msgType", "scope"] as const;

/** Whether a header field holds one of the tokens CAP 1.2 enumerates for it. */
const isToken = (values: readonly string[], value: unknown) => values.includes(capToken(value));

/**
 * Whether a message carries the header every situation of it needs: each
 * field present, `sent` a time with its zone, and `status`, `msgType` and `scope` CAP 1.2
 * tokens, which are case-sensitive.
 */
const readable = (alert: CapAlert) =>
  HEADER.every((field) => capToken(alert[field]) !== "") &&
  capInstant(alert.sent) !== undefined &&
  isToken(CAP_1_2.status, alert.status) &&
  isToken(CAP_1_2.msgType, alert.msgType) &&
  isToken(CAP_1_2.scope, alert.scope);

/**
 * The message types that warn of nothing: `Ack` acknowledges the messages
 * it references and `Error` rejects them (CAP 1.2, 3.2.1), so neither is a
 * hazard of its own.
 */
const NO_HAZARD = new Set(["Ack", "Error"]);

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
  const infos = (Array.isArray(alert.info) ? alert.info : []).filter(isRecord);
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
 * end here by design, `accepted` the situations. A quiet poll with no
 * message is an accounted zero, which publishes zero instead of being
 * refused.
 *
 * A message ends here when it is superseded by another message of the parse,
 * expired before the poll, a cancel without info blocks (it ends its warning
 * and describes nothing), or not meant as a public warning: a `status` other
 * than `Actual` (an exercise, a system message, a test or a draft, which
 * CAP 1.2 says are not real or not actionable), a `scope` other than
 * `Public` (CAP's `Restricted` and `Private` are for named recipients only,
 * not for republishing), or an `Ack` or `Error`.
 *
 * What does not read is skipped under its reason in the feed's skip counts
 * (`recordSkipped`), never the parse: a message without its header or with a
 * header token CAP does not define, an alert or update with no info block,
 * and a hazard whose CAP does not read are `malformed`; a category or
 * response type CAP does not define is left out of a hazard that is kept
 * (`unknown_value`).
 */
export function capOutput(
  alerts: readonly CapAlert[],
  feed: HazardsFeed,
  opts: CapOutputOptions,
): ParseOutput {
  const { undecoded = {}, ...situationOpts } = opts;
  const out = emptyParseOutput();
  let skipped: SkipCounts = { ...undecoded };
  const skip = (reason: SkipReason, count = 1) => {
    skipped = addSkips(skipped, { [reason]: count });
  };
  const undecodedCount = Object.values(undecoded).reduce((sum, n) => sum + (n ?? 0), 0);
  let terminal = 0;
  const unique = new Map<string, CapAlert>();
  // Messages that cannot be read are unique records too, each skipped: a
  // poll whose every non-terminal record was skipped is told apart from a
  // quiet one by the skipped records against `uniqueCount - terminal`.
  let unreadableMessages = undecodedCount;
  let duplicates = 0;
  for (const alert of alerts) {
    if (!readable(alert)) {
      skip("malformed");
      unreadableMessages++;
    } else if (unique.has(alert.identifier)) {
      duplicates++;
    } else {
      unique.set(alert.identifier, alert);
    }
  }
  const actual = [...unique.values()].filter((a) => capToken(a.status) === "Actual");
  terminal += unique.size - actual.length;
  // An update or cancel supersedes what it references whoever it is for.
  const { current, superseded, groupOf } = currentMessages(actual);
  terminal += superseded;
  for (const alert of current) {
    if (NO_HAZARD.has(capToken(alert.msgType)) || capToken(alert.scope) !== "Public") {
      terminal++;
      continue;
    }
    if (!Array.isArray(alert.info) || alert.info.length === 0) {
      // A cancel ends its warning; an alert or update without info names no hazard.
      if (capToken(alert.msgType) === "Cancel") terminal++;
      else skip("malformed");
      continue;
    }
    if (expiredAt(alert, opts.fetchedAt, opts.endOf)) {
      terminal++;
      continue;
    }
    const groupId = groupOf(alert.identifier);
    const drafts = capDrafts(alert, feed, { ...situationOpts, groupId });
    out.situations.push(...drafts.drafts);
    skipped = addSkips(skipped, drafts.skipped);
  }
  for (const [reason, count] of Object.entries(skipped) as [SkipReason, number][]) {
    recordSkipped(feed.id, reason, count);
  }
  out.records = {
    inputCount: alerts.length + undecodedCount,
    uniqueCount: unique.size + unreadableMessages,
    duplicates,
    accepted: out.situations.length,
    terminal,
    unlocatable: 0,
    unlocatableSituations: [],
    unlocatableRecords: [],
    situationRecords: Object.fromEntries(out.situations.map((s) => [String(s["id"]), 1])),
  };
  return out;
}
