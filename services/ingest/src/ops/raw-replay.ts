import { readRawPayload } from "@openconditions/ingest-framework";
import { contentHash } from "@openconditions/model";
import type { MapMatchClient } from "@openconditions/openlr";
import type postgres from "postgres";
import { parseEventFeed } from "../pipeline/parse.js";
import { stampAttribution } from "../pipeline/publish.js";
import { resolveOpenLr } from "../pipeline/resolve.js";
import type { DomainFeedSource } from "../pipeline/run.js";

type Rec = Record<string, unknown>;

/** What one archived poll reads as now, against what it stored then. */
export interface ReplayedPoll {
  attemptId: number;
  attemptedAt: string;
  /** Hashes of the poll's payloads the archive no longer holds; the poll is then not diffed. */
  unavailable: string[];
  /** Situations the current parser drafts exactly as stored. */
  same: number;
  /** Situations it drafts with different content. */
  changed: string[];
  /** Situations it drafts that the poll did not store. */
  created: string[];
  /** Situations the poll stored that it no longer drafts. */
  gone: string[];
  /** Situations it drafted that OpenLR resolution could not place. */
  unplaced: string[];
}

export interface ReplayReport {
  polls: ReplayedPoll[];
}

/**
 * Re-parses the archived payloads of each published poll of `feed` since
 * `from` with the current parser, and compares the drafts with the
 * situations that poll left stored: what the source's live set was when the
 * poll finished, by content hash. A poll whose payloads were evicted is
 * listed but not compared. Writes nothing.
 */
export async function replayRaw(
  sql: postgres.Sql,
  opts: {
    feed: DomainFeedSource;
    from: Date;
    to?: Date;
    dir: string;
    openlrClient?: MapMatchClient | null;
  },
): Promise<ReplayReport> {
  const { feed } = opts;
  if (feed.produces === "flow") {
    throw new Error(`${feed.id} is a flow feed; replay covers event feeds`);
  }
  // A revision is stamped with the writer's clock, as an attempt's start is;
  // `finished_at` is the database's. So the state a poll left is bounded by the
  // next attempt's start, never by its own finish.
  const attempts = await sql<
    { id: string; attempted_at: Date; until: Date | null; payload_hashes: string[] }[]
  >`
    SELECT id, attempted_at, until, payload_hashes FROM (
      SELECT id, attempted_at, published, payload_hashes,
             lead(attempted_at) OVER (ORDER BY attempted_at, id) AS until
        FROM conditions.source_poll_attempt WHERE source = ${feed.id}) a
     WHERE published AND payload_hashes IS NOT NULL
       AND attempted_at >= ${opts.from} AND attempted_at <= ${opts.to ?? new Date()}
     ORDER BY attempted_at, id`;
  const polls: ReplayedPoll[] = [];
  for (const attempt of attempts) {
    const poll: ReplayedPoll = {
      attemptId: Number(attempt.id),
      attemptedAt: attempt.attempted_at.toISOString(),
      unavailable: [],
      same: 0,
      changed: [],
      created: [],
      gone: [],
      unplaced: [],
    };
    polls.push(poll);
    const blobs = await sql<{ hash: string; storage_key: string; evicted: boolean }[]>`
      SELECT hash, storage_key, evicted_at IS NOT NULL AS evicted FROM conditions.raw_payload
       WHERE source_id = ${feed.id} AND hash = ANY(${attempt.payload_hashes}::text[])`;
    const byHash = new Map(blobs.filter((b) => !b.evicted).map((b) => [b.hash, b.storage_key]));
    poll.unavailable = attempt.payload_hashes.filter((h) => !byHash.has(h));
    if (poll.unavailable.length > 0) continue;
    const buffers = await Promise.all(
      attempt.payload_hashes.map((h) => readRawPayload(opts.dir, byHash.get(h)!)),
    );

    const parsed = parseEventFeed(feed, buffers, { fetchedAt: poll.attemptedAt });
    const { resolved, unlocatable } = await resolveOpenLr(
      parsed.situations,
      opts.openlrClient ?? null,
    );
    poll.unplaced = unlocatable;
    const drafts = new Map(
      resolved.map((d) => [String(d["id"]), contentHash(stampAttribution(d, feed))]),
    );

    // The source's live situations as the poll left them: each one's latest
    // revision recorded before the next attempt began, unless that is a tombstone.
    const stored = await sql<{ id: string; hash: string; tombstoned: boolean }[]>`
      SELECT DISTINCT ON (r.situation_id) r.snapshot ->> 'id' AS id,
             r.snapshot ->> 'contentHash' AS hash, r.snapshot ? 'tombstone' AS tombstoned
        FROM conditions.situation_revision r
        JOIN conditions.situation s ON s.id = r.situation_id
       WHERE s.source_id = ${feed.id}
         AND (${attempt.until}::timestamptz IS NULL OR r.recorded_at < ${attempt.until})
       ORDER BY r.situation_id, r.revision DESC`;
    const live = new Map(stored.filter((s) => !s.tombstoned).map((s) => [s.id, s.hash]));
    for (const [id, hash] of drafts) {
      const was = live.get(id);
      if (was === undefined) poll.created.push(id);
      else if (was === hash) poll.same++;
      else poll.changed.push(id);
    }
    const unplaced = new Set(unlocatable);
    poll.gone = [...live.keys()].filter((id) => !drafts.has(id) && !unplaced.has(id));
    for (const list of [poll.changed, poll.created, poll.gone]) list.sort();
  }
  return { polls };
}
