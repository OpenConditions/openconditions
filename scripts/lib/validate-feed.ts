import { fetchAll, guardedFetch, redactUrl } from "@openconditions/ingest-framework";
import type { FeedSourceBase, ParserFn } from "@openconditions/ingest-framework";
import { feedToSourceDescriptor, parserFor as roadsParserFor } from "@openconditions/roads";
import type { FeedSource, SourceDescriptor } from "@openconditions/roads";

export type FeedFailureKind = "upstream" | "parse";

/** Canonical liveness verdict — the shape plan 09's changed-feed CI also imports. */
export interface FeedValidation {
  ok: boolean;
  rowCount: number;
  failureKind?: FeedFailureKind; // present iff !ok — distinguishes an upstream flake from broken data
  message?: string; // redacted
}

export interface ValidateFeedDeps {
  /** Overridable fetch — defaults to the L10 SSRF+resource guard. */
  fetch?: typeof fetch;
  /** Overridable parser dispatch — defaults to the roads domain. */
  parserFor?: (format: string) => ParserFn;
}

const defaultParserFor = roadsParserFor as unknown as (format: string) => ParserFn;

/** Scrub any URL token in a message so query-string secrets never surface. */
function redactMessage(message: string): string {
  return message.replace(/https?:\/\/\S+/g, (m) => redactUrl(m));
}

/**
 * Run one feed through the production fetch+parse path and report whether it is
 * alive (yielded ≥1 observation). Never throws: every failure — fetch error,
 * non-2xx status, parser throw, or zero rows — becomes { ok:false, message }, and
 * the message is redacted. Reused by the scheduled liveness check and by the
 * changed-feed PR job (plan 09).
 */
export async function validateFeed(
  feed: FeedSourceBase,
  deps: ValidateFeedDeps = {}
): Promise<FeedValidation> {
  const fetchFn = deps.fetch ?? guardedFetch();
  const parserForFn = deps.parserFor ?? defaultParserFor;
  const errMsg = (err: unknown) => redactMessage(err instanceof Error ? err.message : String(err));

  // Fetch failures are "upstream" (a flake/outage); parse failures are "parse"
  // (the feed's data is broken) — plan 09 annotates the two differently.
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
    const descriptor = feedToSourceDescriptor(feed as FeedSource) as SourceDescriptor;
    const parse = parserForFn(feed.format);
    let count = 0;
    for (const buf of buffers) {
      count += parse(buf, descriptor as never).length;
    }
    return count > 0
      ? { ok: true, rowCount: count }
      : { ok: false, rowCount: 0, failureKind: "parse", message: "parsed 0 observations" };
  } catch (err) {
    return { ok: false, rowCount: 0, failureKind: "parse", message: errMsg(err) };
  }
}
