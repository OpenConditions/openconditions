import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { RawTier } from "@openconditions/core/server";
import type postgres from "postgres";
import { inScope, type SourceScope } from "../ingest-role.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One archived payload as eviction sees it. */
export interface HeldPayload {
  sourceId: string;
  hash: string;
  tier: RawTier;
  /** When it was last fetched: the time windows are measured against. */
  lastSeenAt: number;
  bytesStored: number;
  /** Pinned, read by its source's latest publication, or the base of a delta patch still held. */
  protected: boolean;
}

export interface EvictionPolicy {
  now: number;
  /** Every distinct payload of a source is kept this long. */
  hotHours: number;
  /** Beyond the hot window, one payload per hour is kept this long. */
  thinDays: { situation: number; observation: number };
  /** Total bytes the archive may hold; 0 = no cap. */
  maxBytes: number;
}

export interface EvictionPlan {
  evict: HeldPayload[];
  /**
   * The cap rung that was needed: 0 none, 1 shortened thinned windows,
   * 2 thinned further, 3 cut into the hot window.
   */
  rung: 0 | 1 | 2 | 3;
  /** Sources that lost payloads from their hot window (rung 3). */
  hotEvicted: string[];
}

/** Payloads every source keeps however old: its newest distinct few. */
const ALWAYS_NEWEST = 3;

interface Rules {
  thinDays: { situation: number; observation: number };
  /** One payload kept per bucket of this size in the thinned window. */
  bucketMs: number;
}

/**
 * What the tiers keep under `rules`, before the cap: per source, the newest
 * three and every protected payload always; a `hot` payload for the hot
 * window; a `reference` payload only among its source's newest three; a
 * situation or observation payload for the hot window, then the newest of
 * each bucket for its tier's thinned window.
 */
function keepByTiers(
  bySource: ReadonlyMap<string, readonly HeldPayload[]>,
  policy: EvictionPolicy,
  rules: Rules,
) {
  const keep = new Set<HeldPayload>();
  const hot = policy.hotHours * HOUR_MS;
  for (const list of bySource.values()) {
    const buckets = new Set<string>();
    list.forEach((r, i) => {
      const age = policy.now - r.lastSeenAt;
      if (i < ALWAYS_NEWEST || r.protected) {
        keep.add(r);
        return;
      }
      if (r.tier === "reference") return;
      if (age <= hot) {
        keep.add(r);
        return;
      }
      if (r.tier === "hot") return;
      if (age > rules.thinDays[r.tier] * DAY_MS) return;
      const bucket = `${r.tier}:${Math.floor(r.lastSeenAt / rules.bucketMs)}`;
      if (!buckets.has(bucket)) {
        buckets.add(bucket);
        keep.add(r);
      }
    });
  }
  return keep;
}

/** Each source's payloads, newest first. */
function newestFirstBySource(rows: readonly HeldPayload[]) {
  const bySource = new Map<string, HeldPayload[]>();
  for (const r of rows) {
    const list = bySource.get(r.sourceId);
    if (list) list.push(r);
    else bySource.set(r.sourceId, [r]);
  }
  for (const list of bySource.values()) list.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return bySource;
}

const bytes = (rows: Iterable<HeldPayload>) => {
  let n = 0;
  for (const r of rows) n += r.bytesStored;
  return n;
};

/**
 * Which payloads to evict. First the tiers' own windows; then, while the
 * archive is still over the cap, the ladder — each rung only while needed,
 * never below a source's newest three or a protected payload:
 *  1. shorten the thinned windows a day at a time, observation feeds before
 *     situation feeds, down to one day past the hot window;
 *  2. thin the thinned windows further, to one payload per 6 hours, then
 *     per day, then drop what is left of them, oldest first;
 *  3. cut into the hot window, oldest first, observation feeds first — the
 *     only rung that loses replayable recent history, so the sources that
 *     lost a hot-window payload are reported.
 */
export function planEviction(rows: readonly HeldPayload[], policy: EvictionPolicy): EvictionPlan {
  const rules: Rules = { thinDays: { ...policy.thinDays }, bucketMs: HOUR_MS };
  const bySource = newestFirstBySource(rows);
  let keep = keepByTiers(bySource, policy, rules);
  const over = () => policy.maxBytes > 0 && bytes(keep) > policy.maxBytes;
  let rung: EvictionPlan["rung"] = 0;

  // The thinned windows count from now, like the hot window: the shortest keeps
  // one day of thinned payloads beyond the hot window.
  const shortest = Math.ceil(policy.hotHours / 24) + 1;
  for (const tier of ["observation", "situation"] as const) {
    while (over() && rules.thinDays[tier] > shortest) {
      rung = 1;
      rules.thinDays[tier] -= 1;
      keep = keepByTiers(bySource, policy, rules);
    }
  }
  for (const bucketMs of [6 * HOUR_MS, DAY_MS]) {
    if (!over()) break;
    rung = 2;
    rules.bucketMs = bucketMs;
    keep = keepByTiers(bySource, policy, rules);
  }
  const hotEvicted = new Set<string>();
  if (over()) {
    const untouchable = new Set<HeldPayload>();
    for (const list of bySource.values()) {
      for (const r of list.slice(0, ALWAYS_NEWEST)) untouchable.add(r);
    }
    const inHot = (r: HeldPayload) => policy.now - r.lastSeenAt <= policy.hotHours * HOUR_MS;
    const order = { observation: 0, hot: 1, situation: 2, reference: 3 };
    // What the thinned windows still keep goes first, then the hot windows.
    const candidates = [...keep]
      .filter((r) => !r.protected && !untouchable.has(r))
      .sort(
        (a, b) =>
          Number(inHot(a)) - Number(inHot(b)) ||
          order[a.tier] - order[b.tier] ||
          a.lastSeenAt - b.lastSeenAt,
      );
    let total = bytes(keep);
    for (const r of candidates) {
      if (total <= policy.maxBytes) break;
      keep.delete(r);
      total -= r.bytesStored;
      if (inHot(r)) {
        rung = 3;
        hotEvicted.add(r.sourceId);
      }
    }
  }
  return {
    evict: rows.filter((r) => !keep.has(r)),
    rung,
    hotEvicted: [...hotEvicted].sort(),
  };
}

/** The eviction policy from the environment (`OPENCONDITIONS_RAW_*`). */
export function evictionPolicyFromEnv(
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): EvictionPolicy {
  const read = (key: string, fallback: number) => {
    const raw = env[key];
    const n = raw == null || raw === "" ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    now: now.getTime(),
    hotHours: read("OPENCONDITIONS_RAW_HOT_HOURS", 48),
    thinDays: {
      situation: read("OPENCONDITIONS_RAW_THIN_DAYS_SITUATION", 14),
      observation: read("OPENCONDITIONS_RAW_THIN_DAYS_OBSERVATION", 7),
    },
    maxBytes: read("OPENCONDITIONS_RAW_MAX_BYTES", 10 * 1024 ** 3),
  };
}

export interface EvictionResult extends EvictionPlan {
  /** Index rows of payloads evicted longer ago than the history window, removed. */
  purged: number;
}

/**
 * Applies the eviction plan to the archive: deletes each evicted blob and
 * marks its index row `evicted_at` (the row stays, so a record's raw
 * reference still names what it was read from), warns on the sources that
 * lost hot-window payloads, and removes the index rows of payloads evicted
 * more than `historyDays` ago. A payload fetched again since the plan was
 * made is kept; `evict` lists what was evicted. `dryRun` only plans.
 *
 * `scope` limits all of it, the cap included, to the sources whose payloads
 * lie in `dir`: those of the feeds this process polls, when another ingest
 * process archives its feeds' payloads on its own volume.
 */
export async function evictRawPayloads(
  sql: postgres.Sql,
  opts: {
    dir: string;
    policy: EvictionPolicy;
    historyDays: number;
    dryRun?: boolean;
    scope?: SourceScope;
  },
): Promise<EvictionResult> {
  const rows = await sql<
    {
      source_id: string;
      hash: string;
      url_key: string;
      tier: RawTier;
      last_seen_at: Date;
      bytes_stored: string;
      pinned: boolean;
      is_base: boolean;
    }[]
  >`
    SELECT p.source_id, p.hash, p.url_key, p.tier, p.last_seen_at, p.bytes_stored,
           p.pinned_reason IS NOT NULL AS pinned,
           EXISTS (SELECT 1 FROM conditions.raw_payload d
                    WHERE d.source_id = p.source_id AND d.base_hash = p.hash
                      AND d.evicted_at IS NULL) AS is_base
      FROM conditions.raw_payload p
     WHERE p.evicted_at IS NULL AND ${inScope(sql, "p.source_id", opts.scope)}`;
  // The payloads what is live now was read from: those of each source's
  // latest published poll. A history row names its poll's payload too, but
  // history is what the tiers' windows thin; only the live state is kept
  // whatever its age.
  const sources = [...new Set(rows.map((r) => r.source_id))];
  const published = await sql<{ source: string; hash: string }[]>`
    SELECT s.source, unnest(a.payload_hashes) AS hash
      FROM unnest(${sources}::text[]) AS s(source)
     CROSS JOIN LATERAL (
       SELECT payload_hashes FROM conditions.source_poll_attempt
        WHERE source = s.source AND published AND payload_hashes IS NOT NULL
        ORDER BY attempted_at DESC LIMIT 1) a`;
  const live = new Set(published.map((r) => `${r.source}\n${r.hash}`));
  // A poll also reads what it holds from earlier ones: a site table, a role
  // not due, a URL that failed. That is the newest payload of each URL a
  // source fetched: a site table's however long ago, since it may answer
  // unchanged for weeks; a feed's while within its tier's thinned window, so
  // a URL no longer asked (a date in its path) lets its payload go. A `hot`
  // payload is not kept past its window for this.
  const newestOfUrl = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.source_id}\n${r.url_key}`;
    const newest = newestOfUrl.get(key);
    if (!newest || r.last_seen_at > newest.last_seen_at) newestOfUrl.set(key, r);
  }
  for (const r of newestOfUrl.values()) {
    const age = opts.policy.now - r.last_seen_at.getTime();
    if (
      r.tier === "reference" ||
      ((r.tier === "situation" || r.tier === "observation") &&
        age <= opts.policy.thinDays[r.tier] * DAY_MS)
    ) {
      live.add(`${r.source_id}\n${r.hash}`);
    }
  }
  const held = rows.map((r) => ({
    sourceId: r.source_id,
    hash: r.hash,
    tier: r.tier,
    lastSeenAt: r.last_seen_at.getTime(),
    bytesStored: Number(r.bytes_stored),
    protected: r.pinned || r.is_base || live.has(`${r.source_id}\n${r.hash}`),
  }));
  const plan = planEviction(held, opts.policy);
  if (opts.dryRun) return { ...plan, purged: 0 };

  const at = new Date(opts.policy.now);
  const evicted: HeldPayload[] = [];
  for (const r of plan.evict) {
    // The row stays locked until its blob is gone, so a poll fetching the
    // payload meanwhile waits and then archives it afresh. One fetched since
    // the plan was made is kept.
    const done = await sql.begin(async (tx) => {
      const [row] = await tx<{ storage_key: string }[]>`
        SELECT storage_key FROM conditions.raw_payload
         WHERE source_id = ${r.sourceId} AND hash = ${r.hash} AND evicted_at IS NULL
           AND date_trunc('milliseconds', last_seen_at) <= ${new Date(r.lastSeenAt)}
           FOR UPDATE`;
      if (!row) return false;
      await tx`
        UPDATE conditions.raw_payload SET evicted_at = ${at}
         WHERE source_id = ${r.sourceId} AND hash = ${r.hash}`;
      await rm(join(opts.dir, row.storage_key), { force: true });
      return true;
    });
    if (done) evicted.push(r);
  }
  if (plan.hotEvicted.length > 0) {
    console.warn(
      `[raw] over the cap: hot-window payloads evicted for ${plan.hotEvicted.join(", ")}`,
    );
    await sql`
      UPDATE conditions.source_status SET raw_hot_evicted_at = ${at}
       WHERE source = ANY(${plan.hotEvicted})`;
  }
  const purged = await sql`
    DELETE FROM conditions.raw_payload
     WHERE evicted_at < ${new Date(opts.policy.now - opts.historyDays * DAY_MS)}
       AND ${inScope(sql, "source_id", opts.scope)}`;
  return { ...plan, evict: evicted, purged: purged.count };
}
