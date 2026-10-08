import type {
  RecordDraft,
  StatusIndex,
  StatusOutput,
  StatusSubject,
} from "@openconditions/ingest-framework";
import { movedReading } from "./colocate.js";
import type { ChargingFeed } from "./records.js";
import {
  connectorStatusDraft,
  type EvseStatus,
  evseStatusDraft,
  type ReadingContext,
} from "./site.js";

/** A status index as a parse builds it. */
export type StatusIndexDraft = Map<string, StatusSubject[]>;

/** Adds `subject` under `key`, beside any other subject the key already names. */
export function indexStatus(index: StatusIndexDraft, key: string, subject: StatusSubject): void {
  const held = index.get(key);
  if (held === undefined) index.set(key, [subject]);
  else held.push(subject);
}

/** The subjects `key` names; none when the index does not hold it. */
export const subjectsOf = (index: StatusIndex, key: string | undefined): readonly StatusSubject[] =>
  (key === undefined ? undefined : index.get(key)) ?? [];

/** Gathers the status readings of a poll, and the status records it could not place. */
export interface StatusReader {
  /**
   * A reading of `status` on `subject`, as of `at`, the UTC instant the
   * source gives the status; as of the fetch where it gives none.
   */
  read(subject: StatusSubject, status: EvseStatus, at: string | undefined): void;
  /** A status record the index does not name. */
  reject(): void;
  output(): StatusOutput;
}

/**
 * The readings of a poll's statuses, each on its subject as the full parse
 * placed it: one moved onto the site its station merged into keeps the
 * reading id the move gives it, once, as the merge keeps it.
 */
export function statusReader(feed: ChargingFeed, ctx: ReadingContext): StatusReader {
  const observations: RecordDraft[] = [];
  const moved = new Set<string>();
  let rejected = 0;
  return {
    read(subject, status, at) {
      const base = {
        stationId: subject.stationId,
        evseKey: subject.evseKey ?? "",
        status,
        ...(at === undefined ? {} : { at }),
        ...(subject.point === undefined ? {} : { point: subject.point as [number, number] }),
      };
      const reading =
        subject.connectorId === undefined
          ? evseStatusDraft(feed, base, ctx)
          : connectorStatusDraft(feed, { ...base, connectorId: subject.connectorId }, ctx);
      if (subject.featureId === undefined) {
        observations.push(reading);
        return;
      }
      const onSite = movedReading(reading, subject.featureId, subject.componentKey);
      const id = onSite["id"] as string;
      if (moved.has(id)) return;
      moved.add(id);
      observations.push(onSite);
    },
    reject() {
      rejected++;
    },
    output: () => ({ observations, rejected }),
  };
}
