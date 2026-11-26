import { listSituations, type QueryRunner, type SituationQuery } from "@openconditions/core";
import type postgres from "postgres";

const PAGE_SIZE = 5000;
const MAX_SITUATIONS = 20_000;
export const MAX_COMPLETE_FEED_BYTES = 32 * 1024 * 1024;
export const MAX_TRAFF_BYTES = MAX_COMPLETE_FEED_BYTES;
export const MAX_CIFS_BYTES = MAX_COMPLETE_FEED_BYTES;

export class CompleteFeedTooLargeError extends Error {
  constructor(feedName: string) {
    super(`${feedName} feed too large; narrow the bbox, source or time filters`);
  }
}

export class TraffFeedTooLargeError extends CompleteFeedTooLargeError {
  constructor() {
    super("TraFF");
  }
}

export class CifsFeedTooLargeError extends CompleteFeedTooLargeError {
  constructor() {
    super("CIFS");
  }
}

/** Read a bounded, consistent public snapshot; never return a successful partial feed. */
export async function readCompletePublicSnapshot(
  sql: postgres.Sql,
  query: Omit<SituationQuery, "scope" | "cursor" | "limit"> & { at: Date },
  tooLarge: () => CompleteFeedTooLargeError = () => new CompleteFeedTooLargeError("Feed"),
): Promise<Record<string, unknown>[]> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const db: QueryRunner = {
      execute: async <T>(text: string, params?: unknown[]) =>
        (await tx.unsafe(text, params as never)) as T,
    };
    const out: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    do {
      const read: Awaited<ReturnType<typeof listSituations>> = await listSituations(db, {
        ...query,
        scope: "public",
        limit: Math.min(PAGE_SIZE, MAX_SITUATIONS - out.length),
        ...(cursor === null ? {} : { cursor }),
      });
      out.push(...read.records);
      cursor = read.next;
      if (cursor !== null && out.length >= MAX_SITUATIONS) throw tooLarge();
    } while (cursor !== null);
    return out;
  });
}

/** Read a bounded, consistent public snapshot for TraFF; never return a successful partial feed. */
export async function readTraffSnapshot(
  sql: postgres.Sql,
  query: Omit<SituationQuery, "scope" | "cursor" | "limit"> & { at: Date },
): Promise<Record<string, unknown>[]> {
  return readCompletePublicSnapshot(sql, query, () => new TraffFeedTooLargeError());
}

/** Read a bounded, consistent public snapshot for CIFS; never return a successful partial feed. */
export async function readCifsSnapshot(
  sql: postgres.Sql,
  query: Omit<SituationQuery, "scope" | "cursor" | "limit" | "simplify"> & { at: Date },
): Promise<Record<string, unknown>[]> {
  return readCompletePublicSnapshot(sql, query, () => new CifsFeedTooLargeError());
}
