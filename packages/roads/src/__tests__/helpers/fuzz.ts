import { draftProblems } from "@openconditions/conformance";
import {
  drainSkipped,
  type ParseOutput,
  type SkipCounts,
  skippedRecords,
} from "@openconditions/ingest-framework";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { vi } from "vitest";
import { roadsDomain } from "../../domain.js";
import type { RoadFeed } from "../../feed-schema.js";
import { feedToSourceDescriptor } from "../../feeds.js";
import { situationParserOf } from "../../parse.js";

const registry = buildRegistry([kernelModule, roadsModule]);
export const FETCHED_AT = "2026-10-20T10:00:00.000Z";

/** What one random document made: the parse output, its skips, and every problem found. */
export interface FuzzResult {
  out: ParseOutput;
  skips: SkipCounts;
  problems: string[];
}

/**
 * One document through the feed's format as the pipeline reads it: the
 * domain's format registry, then sealing every draft against the roads
 * model, then the checks sealing does not make.
 */
export function parseFuzzed(feed: RoadFeed, payload: Buffer): FuzzResult {
  drainSkipped(feed.id);
  const format = roadsDomain.formats[feed.format];
  if (format === undefined) throw new Error(`no roads format ${feed.format}`);
  const out = format.parse(
    feed,
    { main: [payload] },
    {
      fetchedAt: FETCHED_AT,
      cadenceSec: 300,
      reference: {},
    },
  );
  const skips = drainSkipped(feed.id);
  const drafts = [...out.situations, ...out.features, ...out.observations, ...out.offers];
  const problems = drafts.flatMap((draft) => {
    let sealed: ReturnType<typeof sealRecord>;
    try {
      sealed = sealRecord(registry, draft, {
        instanceId: "fuzz.test",
        revision: 1,
        recordedAt: FETCHED_AT,
      });
    } catch (error) {
      return [`${String(draft["id"])}: sealing threw ${(error as Error).message}`];
    }
    return sealed.ok
      ? []
      : [`${String(draft["id"])}: ${JSON.stringify(sealed.issues.slice(0, 3))}`];
  });
  problems.push(...draftProblems(drafts));
  const records = out.records;
  if (records !== undefined) {
    const placed = records.accepted + records.terminal + records.unlocatable;
    if (records.inputCount !== records.uniqueCount + records.duplicates)
      problems.push(`accounting: ${JSON.stringify(records)}`);
    if (placed !== records.uniqueCount) problems.push(`accounting: ${JSON.stringify(records)}`);
  }
  return { out, skips, problems };
}

/**
 * The format's own records of one document, before they are folded into
 * situations: each input record is either read into one event or counted as
 * skipped with its reason. `records` is how many the document holds; where
 * it repeats a record under the same id, `distinct` is how many it names, the
 * repeats being read once but each counted if skipped.
 */
export function eventAccounting(
  feed: RoadFeed,
  payload: Buffer,
  records: number,
  distinct = records,
): string[] {
  drainSkipped(feed.id);
  const events = situationParserOf(feed.format)(payload, feedToSourceDescriptor(feed));
  const skipped = skippedRecords(drainSkipped(feed.id));
  const read = new Set(events.map((e) => e.id)).size;
  return read + skipped >= distinct && read + skipped <= records
    ? []
    : [`${records} records (${distinct} distinct), ${read} read, ${skipped} counted as skipped`];
}

/** Silences the parsers' per-document log lines, which thousands of random documents would flood. */
export function quiet(): void {
  for (const level of ["log", "info", "debug", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
}

/** A failure message naming what was done to the document. */
export const report = (applied: readonly string[], problems: readonly string[]) =>
  `mutations:\n  ${applied.join("\n  ")}\nproblems:\n  ${problems.slice(0, 8).join("\n  ")}`;
