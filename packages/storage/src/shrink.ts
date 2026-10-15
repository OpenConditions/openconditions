import type { Sql } from "./bulk.js";

/** What shrank: a source's polled change-only series, or its record count. */
export type ShrinkScope = "series" | "records";

/** Consecutive complete polls that must state a shrink before it takes effect. */
export const SHRINK_CONFIRM_POLLS = 3;

/**
 * The least time from the first of those polls to the one the shrink takes
 * effect at, so a feed polled every minute does not confirm a cut-off answer
 * it serves for a few minutes.
 */
export const SHRINK_CONFIRM_SEC = 600;

export interface ShrinkState {
  /** Whether the shrink takes effect at this poll. */
  confirmed: boolean;
  /** Consecutive complete polls that stated it, this one included. */
  polls: number;
  /** When the first of them was. */
  since: string;
}

/**
 * Notes a complete poll of `sourceId` that states a shrink (`stated` of the
 * `held` in effect) and says whether the shrink now takes effect: once
 * {@link SHRINK_CONFIRM_POLLS} consecutive complete polls have stated it,
 * the first at least {@link SHRINK_CONFIRM_SEC} before this one. A confirmed
 * shrink is cleared, so a later one is counted from its own first poll.
 */
export async function noteShrink(
  db: Sql,
  sourceId: string,
  scope: ShrinkScope,
  poll: { stated: number; held: number; now: string },
): Promise<ShrinkState> {
  const [row] = await db<{ polls: number; since: Date }[]>`
    INSERT INTO conditions.source_shrink (source_id, scope, since, polls, stated, held)
    VALUES (${sourceId}, ${scope}, ${poll.now}, 1, ${poll.stated}, ${poll.held})
    ON CONFLICT (source_id, scope) DO UPDATE SET
      polls = conditions.source_shrink.polls + 1,
      stated = excluded.stated, held = excluded.held
    RETURNING polls, since`;
  const since = row!.since.toISOString();
  const confirmed =
    row!.polls >= SHRINK_CONFIRM_POLLS &&
    Date.parse(poll.now) - Date.parse(since) >= SHRINK_CONFIRM_SEC * 1000;
  if (confirmed) await clearShrink(db, sourceId, scope);
  return { confirmed, polls: row!.polls, since };
}

/** Forgets a pending shrink of `sourceId`: a complete poll stated no shrink. */
export async function clearShrink(db: Sql, sourceId: string, scope: ShrinkScope): Promise<void> {
  await db`DELETE FROM conditions.source_shrink WHERE source_id = ${sourceId} AND scope = ${scope}`;
}
