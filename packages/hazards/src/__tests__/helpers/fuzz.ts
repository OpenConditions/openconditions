import { draftProblems } from "@openconditions/conformance";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type SkipCounts,
  skippedRecords,
} from "@openconditions/ingest-framework";
import { hazardsDomain } from "../../domain.js";
import type { HazardsCatalogFeed } from "../../feed-schema.js";
import { parseContext } from "./hazards-feed.js";
import { sealFailures } from "./seal.js";

/** What one parse of a mutated document gave: its output and skips, or what it threw. */
export interface FuzzRun {
  out?: ParseOutput;
  skipped: SkipCounts;
  error?: unknown;
}

/** The real format of the domain over one poll's payloads, with the skips it recorded. */
export function runFormat(
  format: string,
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  fetchedAt: string,
): FuzzRun {
  __resetSkips();
  try {
    const out = hazardsDomain.formats[format]!.parse(feed, payloads, parseContext(fetchedAt));
    return { out, skipped: drainSkipped(feed.id) };
  } catch (error) {
    return { skipped: drainSkipped(feed.id), error };
  }
}

/**
 * Whether a complete-snapshot output accounts for every source record: each
 * one read is a repeat, terminal, rejected, skipped under a reason, or folded
 * into a situation that was published.
 */
export function accountingGap(out: ParseOutput, skipped: SkipCounts): string | undefined {
  const r = out.records;
  if (r === undefined) return undefined;
  const folded = Object.values(r.situationRecords).reduce((sum, n) => sum + n, 0);
  const accounted =
    r.duplicates +
    r.terminal +
    r.unlocatable +
    (out.rejected ?? 0) +
    skippedRecords(skipped) +
    folded;
  return accounted === r.inputCount
    ? undefined
    : `read ${r.inputCount} records, accounted for ${accounted} (${JSON.stringify({ ...r, situationRecords: undefined, skipped, rejected: out.rejected })})`;
}

/**
 * Whether a CAP output accounts for every message. A message may warn of
 * several hazards, each its own situation, and a hazard that does not read is
 * skipped on its own, so a message is accounted for when it is a repeat,
 * terminal, skipped, or the source of a situation; the count is a floor.
 */
export function capAccountingGap(out: ParseOutput, skipped: SkipCounts): string | undefined {
  const r = out.records;
  if (r === undefined) return "no record accounting";
  const messages = new Set(
    out.situations.map((s) => (s["details"] as { cap: { identifier: string } }).cap.identifier),
  );
  const accounted = r.duplicates + r.terminal + skippedRecords(skipped) + messages.size;
  return accounted >= r.inputCount
    ? undefined
    : `read ${r.inputCount} messages, accounted for ${accounted} (${JSON.stringify({ ...r, situationRecords: undefined, skipped })})`;
}

/** Everything wrong with a run: a throw, a draft that does not seal or is not sound, a record lost. */
export function runProblems(
  run: FuzzRun,
  options: { accounting?: boolean | "cap" } = {},
): string[] {
  if (run.error !== undefined) {
    const e = run.error as Error;
    return [`threw ${e?.stack ?? String(e)}`];
  }
  const out = run.out!;
  const drafts = [...out.situations, ...out.features, ...out.observations, ...out.offers];
  const problems = [
    ...sealFailures(drafts).map((f) => `does not seal: ${JSON.stringify(f).slice(0, 600)}`),
    ...draftProblems(drafts),
  ];
  if (options.accounting ?? true) {
    const gap =
      options.accounting === "cap"
        ? capAccountingGap(out, run.skipped)
        : accountingGap(out, run.skipped);
    if (gap) problems.push(gap);
  }
  return problems;
}
