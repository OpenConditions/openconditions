import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { RoadFeed } from "./feed-schema.js";
import { feedToSourceDescriptor } from "./feeds.js";
import type { RoadEvent } from "./model.js";
import { roadSnapshotAccounting } from "./parse.js";
import { parseSevasSnapshot } from "./sevas.js";
import { sevasEffects } from "./sevas-effects.js";
import { situationDrafts } from "./situation/assemble.js";
import { reconcileRoadSnapshots } from "./snapshot.js";

/** A counted source snapshot assembled normally, with SEVAS-specific canonical predicates. */
export function parseSevasFeed(
  feed: RoadFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const input = payloads["main"];
  if (input?.length !== 1) throw new Error("sevas: expected one complete source document");
  const source = feedToSourceDescriptor(feed, new Date(ctx.fetchedAt));
  const snapshot = reconcileRoadSnapshots([parseSevasSnapshot(input[0]!, source)]);
  const members = new Map<string, string[]>();
  const output = emptyParseOutput();
  output.situations = situationDrafts(snapshot.observations, {
    source,
    records: snapshot.records,
    members,
    fetchedAt: ctx.fetchedAt,
  });
  const byId = new Map(snapshot.observations.map((e) => [e.id, e as RoadEvent]));
  for (const draft of output.situations) {
    const provenance = draft["provenance"] as { recordId: string };
    const event = byId.get(`${source.id}:${provenance.recordId}`);
    if (!event) throw new Error("sevas: assembled draft lacks source segment");
    draft["effects"] = sevasEffects(event.sourceRaw as Record<string, string>, provenance.recordId);
    draft["severity"] = { label: "unknown" };
    draft["freshness"] = {
      fetchedAt: new Date(ctx.fetchedAt).toISOString(),
      expiresAt: new Date(Date.parse(ctx.fetchedAt) + feed.freshnessWindowSec * 1000).toISOString(),
    };
  }
  output.records = roadSnapshotAccounting(snapshot, source.id, members);
  output.situationsComplete = true;
  return output;
}
