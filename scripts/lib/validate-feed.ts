import type { FeedSourceBase } from "@openconditions/ingest-framework";
import { fetchAll, guardedFetch, redactUrl } from "@openconditions/ingest-framework";
import type { FeedSource } from "@openconditions/roads";
import { parseEvents, parseFlows } from "@openconditions/roads";

export type FeedFailureKind = "upstream" | "parse";

/** Canonical liveness verdict — the shape the changed-feed CI job also imports. */
export interface FeedValidation {
  ok: boolean;
  rowCount: number;
  failureKind?: FeedFailureKind; // present iff !ok — distinguishes an upstream flake from broken data
  message?: string; // redacted
}

/** How many records one fetch of a feed parses into. */
export type RecordCounter = (feed: FeedSourceBase, buffers: readonly Buffer[]) => number;

export interface ValidateFeedDeps {
  /** Overridable fetch — defaults to the SSRF + resource egress guard. */
  fetch?: typeof fetch;
  /** Overridable parse — defaults to the roads domain. */
  count?: RecordCounter;
}

/** A roads feed's readings when it is a flow feed, its situations otherwise. */
const countRoadRecords: RecordCounter = (feed, buffers) => {
  const roadFeed = feed as FeedSource;
  if (feed.produces === "flow") {
    const ctx = { now: new Date().toISOString(), cadenceSec: feed.cadenceSec };
    return buffers.reduce(
      (n, buf) => n + parseFlows(roadFeed, buf, undefined, ctx).observations.length,
      0,
    );
  }
  return parseEvents(roadFeed, buffers).situations.length;
};

/** Scrub any URL token in a message so query-string secrets never surface. */
function redactMessage(message: string): string {
  return message.replace(/https?:\/\/\S+/g, (m) => redactUrl(m));
}

/**
 * Run one feed through the production fetch+parse path and report whether it is
 * alive (yielded ≥1 record). Never throws: every failure — fetch error, non-2xx
 * status, parser throw, or zero records — becomes { ok:false, message }, and
 * the message is redacted. Reused by the scheduled liveness check and by the
 * changed-feed PR job.
 */
export async function validateFeed(
  feed: FeedSourceBase,
  deps: ValidateFeedDeps = {},
): Promise<FeedValidation> {
  const fetchFn = deps.fetch ?? guardedFetch();
  const count = deps.count ?? countRoadRecords;
  const errMsg = (err: unknown) => redactMessage(err instanceof Error ? err.message : String(err));

  // Fetch failures are "upstream" (a flake/outage); parse failures are "parse"
  // (the feed's data is broken) — the changed-feed job annotates them differently.
  let buffers: Buffer[];
  try {
    const result = await fetchAll(feed, fetchFn);
    // "unchanged" means every URL 304'd or the feed was interval-gated — no
    // fresh bytes to parse this cycle. A single-shot check has no prior
    // conditional-GET state, so this path is effectively unreachable here; treat
    // it as zero rows rather than crashing on the type mismatch.
    buffers = result.status === "fetched" ? result.buffers : [];
  } catch (err) {
    return { ok: false, rowCount: 0, failureKind: "upstream", message: errMsg(err) };
  }
  try {
    const rows = count(feed, buffers);
    return rows > 0
      ? { ok: true, rowCount: rows }
      : { ok: false, rowCount: 0, failureKind: "parse", message: "parsed 0 records" };
  } catch (err) {
    return { ok: false, rowCount: 0, failureKind: "parse", message: errMsg(err) };
  }
}
