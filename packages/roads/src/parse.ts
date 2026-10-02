import type { Observation } from "@openconditions/core";
import {
  emptyParseOutput,
  type ParseOutput,
  type RecordDraft,
  type SnapshotAccounting,
} from "@openconditions/ingest-framework";
import { parseDatexSnapshot } from "./datex.js";
import { parseDigitrafficSnapshot } from "./digitraffic.js";
import {
  type DescribedFeed,
  type FeedSource,
  feedToSourceDescriptor,
  flowParserFor,
  parserFor,
} from "./feeds.js";
import { enrichFlowsWithBaseline } from "./flow.js";
import { createMeasuredDataParser } from "./measuredData.js";
import type { BaselineMethod, RoadFlow } from "./model.js";
import type { SiteGeometry } from "./siteTable.js";
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

/** One poll of a roads flow feed: its readings, and the congestion situations derived from them. */
export interface FlowParse {
  flows: RoadFlow[];
  situations: RecordDraft[];
}

/**
 * One payload of a roads flow feed. `siteMap` gives sites keyed only by id
 * their geometry. Throws on a hard parse failure (an unreadable document or
 * no recognisable publication), which must never read as "no readings".
 */
export function parseFlows(
  feed: RoadFeed,
  input: string | Buffer,
  siteMap?: Map<string, SiteGeometry>,
): FlowParse {
  const source = feedToSourceDescriptor(feed);
  const { flows, events, failed } = flowParserFor(feed.format)(input, source, siteMap);
  if (failed) throw new Error(`flow parser reported a hard parse failure for source ${feed.id}`);
  return { flows, situations: situationDrafts(events, { source }) };
}

/**
 * A streaming reader of one DATEX II MeasuredData document of a flow feed:
 * write the decoded text in chunks, then close. `failed` is set when the
 * document broke off or could not be read, and the readings are then partial.
 */
export function measuredDataReader(
  feed: RoadFeed,
  siteMap: Map<string, SiteGeometry> | undefined,
  now: () => string,
): { write(chunk: string): void; close(): FlowParse & { failed: boolean } } {
  const source = feedToSourceDescriptor(feed);
  const parser = createMeasuredDataParser(source, siteMap, now);
  return {
    write: (chunk) => parser.write(chunk),
    close: () => {
      const { flows, events, failed } = parser.close();
      return { flows, situations: situationDrafts(events, { source }), failed: failed === true };
    },
  };
}

/**
 * Applies each flow's free-flow baseline (keyed by flow id) where the feed
 * gave none, recomputing its level of service, and drafts the congestion
 * situations the newly derived levels call for.
 */
export function enrichFlows(
  feed: RoadFeed,
  flows: readonly RoadFlow[],
  baselineMap: Map<string, { kph: number; method: BaselineMethod }>,
): FlowParse {
  const source = feedToSourceDescriptor(feed);
  const enriched = enrichFlowsWithBaseline([...flows] as Observation[], baselineMap, source);
  const isFlow = (o: Observation) => o.kind === "measurement";
  return {
    flows: enriched.filter(isFlow) as RoadFlow[],
    situations: situationDrafts(enriched.filter((o) => !isFlow(o)) as unknown as SnapshotEvent[], {
      source,
    }),
  };
}
