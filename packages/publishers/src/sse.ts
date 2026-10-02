/**
 * Server-Sent Events helpers for the live `/stream` emitter — pure framing
 * and snapshot-diffing so the transport route stays thin and the logic is
 * testable. The route polls the store on an interval and pushes only what
 * changed since the last poll.
 */

type Rec = Record<string, unknown>;

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

/**
 * What a client would see change in a record: its content hash, which covers
 * everything a source said, and its evidence summary, which corroboration
 * changes without a new revision.
 */
export function recordSignature(record: Rec): string {
  const evidence = record["evidence"] as Rec | undefined;
  return `${String(record["contentHash"])}|${JSON.stringify(evidence ?? null)}`;
}

export interface RecordDelta {
  /** New or changed records since the previous snapshot. */
  changed: Rec[];
  /** Ids present last time but gone now. */
  removed: string[];
  /** The new id→signature map to carry into the next diff. */
  next: Map<string, string>;
}

/**
 * Diffs a fresh record set against the previous snapshot's id→signature map.
 * Pure: never mutates `prev`. First call (empty `prev`) reports everything as
 * changed.
 */
export function diffRecords(
  prev: ReadonlyMap<string, string>,
  records: readonly Rec[],
): RecordDelta {
  const next = new Map<string, string>();
  const changed: Rec[] = [];
  for (const record of records) {
    const id = String(record["id"]);
    const signature = recordSignature(record);
    next.set(id, signature);
    if (prev.get(id) !== signature) changed.push(record);
  }
  const removed = [...prev.keys()].filter((id) => !next.has(id));
  return { changed, removed, next };
}
