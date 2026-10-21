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

/** Any of the three line endings the `text/event-stream` grammar accepts. */
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Serialise a message to the `text/event-stream` wire format (one frame).
 * Data spanning several lines is sent as one `data:` field per line, which a
 * client joins back with line feeds (CR and CRLF arrive as LF). An id with a
 * line break or NUL is left out: a line break would end the field, and the
 * EventSource algorithm ignores an id holding NUL.
 */
export function sseFrame(msg: SseMessage): string {
  const lines: string[] = [];
  if (msg.id && !/[\r\n\0]/.test(msg.id)) lines.push(`id: ${msg.id}`);
  if (msg.event) {
    if (LINE_BREAK.test(msg.event))
      throw new TypeError("an SSE event name cannot hold a line break");
    lines.push(`event: ${msg.event}`);
  }
  const data = typeof msg.data === "string" ? msg.data : (JSON.stringify(msg.data) ?? "null");
  for (const line of data.split(LINE_BREAK)) lines.push(`data: ${line}`);
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
