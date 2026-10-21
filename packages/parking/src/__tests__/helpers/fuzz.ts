import { draftProblems } from "@openconditions/conformance";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type SkipCounts,
  skippedRecords,
} from "@openconditions/ingest-framework";
import { parkingDomain } from "../../domain.js";
import type { ParkingCatalogFeed } from "../../feed-schema.js";
import { parseContext } from "./parking-feed.js";
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
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  fetchedAt: string,
): FuzzRun {
  __resetSkips();
  try {
    const out = parkingDomain.formats[format]!.parse(feed, payloads, parseContext(fetchedAt));
    return { out, skipped: drainSkipped(feed.id) };
  } catch (error) {
    return { skipped: drainSkipped(feed.id), error };
  }
}

/**
 * Everything wrong with a run: a throw, a draft that does not seal or is not
 * sound, or, given the number of source sites, a site neither published nor
 * counted as skipped or rejected. `sites` picks the drafts that stand for
 * one source site each.
 */
export function runProblems(
  run: FuzzRun,
  accounting?: { input: number; sites: (out: ParseOutput) => number },
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
  if (accounting !== undefined) {
    const accounted = accounting.sites(out) + skippedRecords(run.skipped) + (out.rejected ?? 0);
    if (accounted !== accounting.input) {
      problems.push(
        `read ${accounting.input} sites, accounted for ${accounted} (${JSON.stringify({ skipped: run.skipped, rejected: out.rejected })})`,
      );
    }
  }
  return problems;
}
