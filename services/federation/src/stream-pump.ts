/**
 * The SSE live-loop pump for `/peer/stream`, extracted from the route so the
 * backpressure logic is unit-testable with an injected writer (a real socket is
 * awkward to stall on demand).
 *
 * BACKPRESSURE (why this exists). The stream re-polls the outbox every tick and
 * writes one frame per entry. `reply.raw.write()` returns `false` when the
 * socket's internal buffer has passed its high-water mark — the signal to STOP
 * and wait for `"drain"`. Ignoring it lets a slow/stalled peer accumulate an
 * unbounded page in the process's heap. So the pump: (a) caps each tick's page
 * (an explicit `limit`, set by the route); (b) on the first `write()` that
 * returns `false`, stops writing the rest of the page, marks itself `paused`,
 * and registers a ONE-SHOT `drain` listener that resumes with a catch-up tick.
 *
 * CURSOR SAFETY (load-bearing). The `(txid, seq)` cursor advances ONLY over
 * entries actually written. A paused tick leaves its remaining entries
 * un-advanced, so they are re-read (strictly after the last written entry) on
 * the next tick — no entry is skipped and none is re-sent. Only a FULLY written
 * tick advances to the scan frontier ({@link OutboxPage.highWaterMark}), which
 * preserves the existing pull semantics of stepping over trailing filtered-out
 * rows.
 */
import { encodeOutboxCursor, type OutboxEntry, type OutboxPage } from "@openconditions/federation";

/** The socket surface the pump drives — the two `reply.raw` calls it needs. */
export interface StreamWriter {
  /** Writes one frame; returns `false` when the socket buffer is full. */
  write(frame: string): boolean;
  /** Registers a ONE-SHOT drain listener (fires once when the buffer empties). */
  onceDrain(listener: () => void): void;
}

export interface StreamPumpDeps {
  /** Reads the next (already limit-capped, filter/tier-scoped) page strictly
   *  after `cursor`. */
  readPage(cursor: string): Promise<OutboxPage>;
  /** The socket sink. */
  writer: StreamWriter;
  /** Serialises one entry into its SSE frame. */
  formatEntry(entry: OutboxEntry): string;
  /** Called on a read error (the tick swallows it — a transient poll failure
   *  must not tear the stream down; the next tick retries from the same cursor). */
  onError?(err: unknown): void;
}

/**
 * A stateful pump over the outbox for one SSE connection. Holds the push-channel
 * cursor and the paused flag; `tick()` is safe to call on an interval.
 */
export class SseStreamPump {
  private cursor: string;
  private paused = false;
  private inFlight = false;
  private stopped = false;

  constructor(
    private readonly deps: StreamPumpDeps,
    startCursor: string
  ) {
    this.cursor = startCursor;
  }

  /** Whether the last tick hit backpressure and is waiting for `drain`. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** The current push-channel cursor (what the peer resumes from). */
  get currentCursor(): string {
    return this.cursor;
  }

  /**
   * Terminally stops the pump: any in-flight or subsequent tick returns without
   * reading/writing. Called from the route's connection-close handler so a drain
   * catch-up racing the close cannot poll or write against a destroyed response.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Polls one page and writes it, honouring backpressure. A no-op while paused
   * (the drain listener owns resumption), while stopped, or while a prior tick is
   * still in flight (the interval and the drain catch-up both call this — without
   * the guard they could read the same cursor concurrently and double-deliver).
   * The cursor advances only over entries actually written; a fully written tick
   * advances to the scan frontier.
   */
  async tick(): Promise<void> {
    if (this.paused || this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      let page: OutboxPage;
      try {
        page = await this.deps.readPage(this.cursor);
      } catch (err) {
        this.deps.onError?.(err);
        return;
      }
      if (this.stopped) return; // closed while the read was in flight

      for (const entry of page.orderedItems) {
        const ok = this.deps.writer.write(this.deps.formatEntry(entry));
        // The frame was buffered regardless of `ok` (false only signals the buffer
        // is now over its high-water mark), so the cursor includes this entry.
        this.cursor = encodeOutboxCursor({ txid: entry.txid, seq: entry.seq });
        if (!ok) {
          this.paused = true;
          this.deps.writer.onceDrain(() => {
            this.paused = false;
            void this.tick(); // catch up from the un-advanced remainder
          });
          return;
        }
      }

      // Every scanned entry was written: step over the scan frontier too, so a
      // trailing filtered-out row does not strand the cursor behind it.
      this.cursor = page.highWaterMark;
    } finally {
      this.inFlight = false;
    }
  }
}
