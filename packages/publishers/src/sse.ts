import type { ConditionEvent, Observation } from "@openconditions/core";

/**
 * Server-Sent Events helpers for the live `/stream` emitter — pure framing,
 * filtering, and snapshot-diffing so the transport route stays thin and the
 * logic is testable. The route polls the store on an interval and pushes only
 * what changed since the last poll.
 */

export interface SseMessage {
  event?: string;
  id?: string;
  data: unknown;
}

/** Serialise a message to the `text/event-stream` wire format (one frame). */
export function sseFrame(msg: SseMessage): string {
  const lines: string[] = [];
  if (msg.id) lines.push(`id: ${msg.id}`);
  if (msg.event) lines.push(`event: ${msg.event}`);
  const data = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
  lines.push(`data: ${data}`);
  return `${lines.join("\n")}\n\n`;
}

/** Parse a comma-separated `type` filter; null = no filter (match all). */
export function parseTypeFilter(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set.size > 0 ? set : null;
}

/** A `type` filter applies to events only; measurements have no type. */
export function matchesTypeFilter(o: Observation, types: Set<string> | null): boolean {
  if (!types) return true;
  return o.kind === "event" && types.has((o as ConditionEvent).type);
}

/** Content fingerprint used to detect changes between polls. */
export function streamSignature(o: Observation): string {
  return `${o.dataUpdatedAt}|${o.status}|${o.isStale ? 1 : 0}`;
}

export interface ObservationDelta {
  /** New or content-changed observations since the previous snapshot. */
  changed: Observation[];
  /** Ids present last time but gone now. */
  removed: string[];
  /** The new id→signature map to carry into the next diff. */
  next: Map<string, string>;
}

/**
 * Diffs a fresh observation set against the previous snapshot's id→signature
 * map. Pure: never mutates `prev`. First call (empty `prev`) reports everything
 * as changed.
 */
export function diffObservations(prev: Map<string, string>, next: Observation[]): ObservationDelta {
  const nextMap = new Map<string, string>();
  const changed: Observation[] = [];
  for (const o of next) {
    const sig = streamSignature(o);
    nextMap.set(o.id, sig);
    if (prev.get(o.id) !== sig) changed.push(o);
  }
  const removed: string[] = [];
  for (const id of prev.keys()) {
    if (!nextMap.has(id)) removed.push(id);
  }
  return { changed, removed, next: nextMap };
}
