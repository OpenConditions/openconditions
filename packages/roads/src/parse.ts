import {
  emptyParseOutput,
  type ParseOutput,
  type SnapshotAccounting,
} from "@openconditions/ingest-framework";
import { parseAutobahn } from "./autobahn.js";
import { parseDatexSituations, parseDatexSnapshot } from "./datex.js";
import { parseDigitraffic, parseDigitrafficSnapshot } from "./digitraffic.js";
import type { RoadFeed } from "./feed-schema.js";
import { type DescribedFeed, feedToSourceDescriptor } from "./feeds.js";
import { parseFlatJson } from "./flatjson.js";
import type { FlowBaseline, FlowContext, FlowOutput, FlowSites } from "./flow-output.js";
import { flowParserOf } from "./flow-parsers.js";
import { parseGddkia } from "./gddkia.js";
import { parseGeoJson } from "./geojson.js";
import { parseIbi511, parseIbi511Conditions } from "./ibi511.js";
import { parseLtaIncidents } from "./lta.js";
import { createMeasuredDataParser } from "./measuredData.js";
import { parseOhgoEvents } from "./ohgo-events.js";
import { parseOpen511 } from "./open511.js";
import { flowOutput } from "./sites/assemble.js";
import { enrichDrafts } from "./sites/enrich.js";
import { situationDrafts } from "./situation/assemble.js";
import {
  type ReconciledRoadSnapshot,
  type RoadSnapshotReport,
  reconcileRoadSnapshots,
  type SnapshotEvent,
} from "./snapshot.js";
import { parseTrafikverket } from "./trafikverket.js";
import type { SourceDescriptor } from "./types.js";
import { parseVicDisruptions } from "./vic-disruptions.js";
import { parseWzdx } from "./wzdx.js";

/** What a roads feed is parsed as: the catalogue fields its parser reads. */
export type ParsedFeed = DescribedFeed & Pick<RoadFeed, "format" | "snapshot">;

type SituationParser = typeof parseDatexSituations;

/** The situation parser of every situation format. */
const SITUATION_PARSERS = {
  datex2: parseDatexSituations,
  open511: parseOpen511,
  wzdx: parseWzdx,
  geojson: parseGeoJson,
  ibi511: parseIbi511 as SituationParser,
  "ibi511-conditions": parseIbi511Conditions as SituationParser,
  lta: parseLtaIncidents as SituationParser,
  gddkia: parseGddkia,
  flatjson: parseFlatJson as SituationParser,
  trafikverket: parseTrafikverket as SituationParser,
  autobahn: parseAutobahn,
  digitraffic: parseDigitraffic,
  "ohgo-events": parseOhgoEvents as SituationParser,
  "vic-disruptions": parseVicDisruptions as SituationParser,
} satisfies Record<string, SituationParser>;

/** Every situation format; the wire formats `SITUATION_PARSERS` reads. */
export const SITUATION_FORMAT_CODES = Object.keys(SITUATION_PARSERS) as SituationFormatCode[];

export type SituationFormatCode = keyof typeof SITUATION_PARSERS;

/** The situation parser of a format; throws when no situation parser reads it. */
export function situationParserOf(format: string): SituationParser {
  if (!Object.hasOwn(SITUATION_PARSERS, format)) {
    throw new Error(`No situation parser registered for format: ${format}`);
  }
  return SITUATION_PARSERS[format as SituationFormatCode];
}

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
  feed: ParsedFeed,
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
    const parse = situationParserOf(feed.format);
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
  feed: ParsedFeed,
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
  feed: ParsedFeed,
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
  feed: ParsedFeed,
  output: FlowOutput,
  baselines: ReadonlyMap<string, FlowBaseline>,
): FlowOutput {
  return enrichDrafts(output, baselines, {
    source: feedToSourceDescriptor(feed),
    format: feed.format,
  });
}
