import {
  emptyParseOutput,
  type ParseOutput,
  type SnapshotAccounting,
} from "@openconditions/ingest-framework";
import { parseDatexSnapshot } from "./datex.js";
import { parseDigitrafficSnapshot } from "./digitraffic.js";
import { type DescribedFeed, type FeedSource, feedToSourceDescriptor, parserFor } from "./feeds.js";
import type { FlowBaseline, FlowContext, FlowOutput, FlowSites } from "./flow-output.js";
import { flowParserOf } from "./flow-parsers.js";
import { createMeasuredDataParser } from "./measuredData.js";
import { flowOutput } from "./sites/assemble.js";
import { enrichDrafts } from "./sites/enrich.js";
import { situationDrafts } from "./situation/assemble.js";
import {
  type ReconciledRoadSnapshot,
  type RoadSnapshotReport,
  reconcileRoadSnapshots,
  type SnapshotEvent,
} from "./snapshot.js";
import type { SourceDescriptor } from "./types.js";

/** What a roads feed is parsed as: the catalogue fields its parser reads. */
export type RoadFeed = DescribedFeed & Pick<FeedSource, "format" | "snapshot">;

/**
 * The formats whose parsers account for every input record. A source that
 * declares a complete snapshot in one of them is read through the reporting
 * path, which reconciles partitions by source identity and refuses a
 * candidate it cannot fully account for.
 */
const SNAPSHOT_REPORTERS: Record<
  string,
  (input: Buffer, src: SourceDescriptor) => RoadSnapshotReport
> = {
  digitraffic: parseDigitrafficSnapshot,
  datex2: parseDatexSnapshot,
};

/**
 * One poll of a roads event feed as situation drafts. Every payload of the
 * poll is one snapshot: the assembler folds records across all of them. A
 * complete-snapshot source also accounts for every input record; a record it
 * could not place names the situations it belongs to, which the poll must not
 * end. Throws when a complete snapshot cannot be accounted for. `fetchedAt`
 * is the instant the poll fetched the payloads, which drafts are dated by.
 */
export function parseEvents(
  feed: RoadFeed,
  buffers: readonly Buffer[],
  opts: { fetchedAt?: string } = {},
): ParseOutput {
  const source = feedToSourceDescriptor(feed);
  const at = opts.fetchedAt !== undefined ? { fetchedAt: opts.fetchedAt } : {};
  const reporter =
    feed.snapshot?.completeness === "complete" && Object.hasOwn(SNAPSHOT_REPORTERS, feed.format)
      ? SNAPSHOT_REPORTERS[feed.format]
      : undefined;
  const out = emptyParseOutput();
  if (reporter === undefined) {
    const parse = parserFor(feed.format);
    const events: SnapshotEvent[] = buffers.flatMap((b) => parse(b, source));
    out.situations = situationDrafts(events, { source, ...at });
    return out;
  }
  const reports = buffers.map((b) => reporter(b, source));
  const reconciled = reconcileRoadSnapshots(reports);
  // Reconciliation orders by id; the assembler reads document order (a
  // group's first record leads it), so the selected events go back to it.
  const position = new Map<string, number>();
  for (const r of reports.flatMap((report) => report.records)) {
    if (!position.has(r.id)) position.set(r.id, position.size);
  }
  const events = [...reconciled.observations].sort(
    (a, b) => position.get(a.id)! - position.get(b.id)!,
  );
  const members = new Map<string, string[]>();
  out.situations = situationDrafts(events, {
    source,
    records: reconciled.records,
    members,
    ...at,
  });
  out.records = accountingOf(reconciled, source.id, members);
  return out;
}

/**
 * A reconciled snapshot's counts, with the situations and ids of the records
 * it could not place, and how many accepted records each situation folds.
 */
function accountingOf(
  snapshot: ReconciledRoadSnapshot,
  sourceId: string,
  members: ReadonlyMap<string, readonly string[]>,
): SnapshotAccounting {
  const localOf = (id: string) =>
    id.startsWith(`${sourceId}:`) ? id.slice(sourceId.length + 1) : id;
  const unlocatable = snapshot.records.filter((r) => r.disposition === "unlocatable");
  const situations = new Set<string>();
  for (const r of unlocatable) {
    // A grouped record belongs to its source situation; a record split out by
    // nature forms its own. Both are named, so neither can be ended.
    situations.add(`oc:situation:${sourceId}:${localOf(r.id)}`);
    if (r.situationId) situations.add(`oc:situation:${sourceId}:${r.situationId}`);
  }
  return {
    inputCount: snapshot.inputCount,
    uniqueCount: snapshot.uniqueCount,
    duplicates: snapshot.duplicates,
    accepted: snapshot.acceptedIds.length,
    terminal: snapshot.terminalIds.length,
    unlocatable: unlocatable.length,
    unlocatableSituations: [...situations].sort(),
    unlocatableRecords: unlocatable.map((r) => localOf(r.id)).sort(),
    situationRecords: Object.fromEntries(
      [...members].map(([id, events]) => [id, new Set(events).size]),
    ),
  };
}

/**
 * One payload of a roads flow feed as drafts: its measurement sites (with
 * their lane and vehicle-class channels), their `traffic.*` readings, and the
 * congestion situations derived from the levels of service. `sites` is the
 * feed's site table or station registry, when it has one. Throws on a hard
 * parse failure (an unreadable document or no recognisable publication),
 * which must never read as "no readings".
 */
export function parseFlows(
  feed: RoadFeed,
  input: string | Buffer,
  sites: FlowSites | undefined,
  ctx: FlowContext,
): FlowOutput {
  const source = feedToSourceDescriptor(feed);
  const { readings, failed } = flowParserOf(feed.format)(input, source, sites, ctx);
  if (failed) throw new Error(`flow parser reported a hard parse failure for source ${feed.id}`);
  return flowOutput(readings, { source, format: feed.format, ctx });
}

/**
 * A streaming reader of one DATEX II MeasuredData document of a flow feed:
 * write the document in chunks (text, or bytes of its UTF-8 encoding), then
 * close. `failed` is set when the document broke off or could not be read,
 * and the drafts are then partial.
 */
export function measuredDataReader(
  feed: RoadFeed,
  sites: FlowSites | undefined,
  ctx: FlowContext,
): { write(chunk: string | Uint8Array): void; close(): FlowOutput & { failed: boolean } } {
  const source = feedToSourceDescriptor(feed);
  const parser = createMeasuredDataParser(source, sites);
  const decoder = new TextDecoder("utf-8");
  return {
    write: (chunk) =>
      parser.write(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })),
    close: () => {
      const tail = decoder.decode();
      if (tail !== "") parser.write(tail);
      const { readings, failed } = parser.close();
      return {
        ...flowOutput(readings, { source, format: feed.format, ctx }),
        failed: failed === true,
      };
    },
  };
}

/**
 * Applies stored free-flow baselines, keyed by subject key
 * (`feature:<featureId>`), to the site speeds a poll left unclassified (no
 * stated level of service, no free-flow speed of the feed's own): the
 * reading's baseline gains the free-flow speed, its method, the ratio and the
 * level the ratio gives, and a level of queuing or worse drafts a derived
 * congestion situation. Returns the enriched output; the input is not changed.
 */
export function enrichReadings(
  feed: RoadFeed,
  output: FlowOutput,
  baselines: ReadonlyMap<string, FlowBaseline>,
): FlowOutput {
  return enrichDrafts(output, baselines, {
    source: feedToSourceDescriptor(feed),
    format: feed.format,
  });
}
