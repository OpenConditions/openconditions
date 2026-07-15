import { describe, expect, it } from "vitest";
import { encodeOutboxCursor, type OutboxEntry, type OutboxPage } from "@openconditions/federation";
import { SseStreamPump } from "../stream-pump.js";

function entry(seq: number, txid = "10"): OutboxEntry {
  return {
    seq,
    txid,
    operation: "create",
    objectId: `o${seq}`,
    canonicalId: null,
    createdAt: "2026-07-13T00:00:00Z",
  };
}

function page(entries: OutboxEntry[], highWaterMark: string): OutboxPage {
  return {
    type: "OrderedCollectionPage",
    partOf: "/peer/stream",
    highWaterMark,
    orderedItems: entries,
  };
}

/** A mock writer whose `write` returns the queued booleans (default true), and
 *  that captures the frames written plus the one-shot drain listener. */
function mockWriter(returns: boolean[] = []) {
  const frames: string[] = [];
  let drain: (() => void) | undefined;
  let drainRegistrations = 0;
  let i = 0;
  return {
    frames,
    fireDrain(): void {
      const cb = drain;
      drain = undefined;
      cb?.();
    },
    hasDrain(): boolean {
      return drain !== undefined;
    },
    get drainRegistrations(): number {
      return drainRegistrations;
    },
    writer: {
      write(frame: string): boolean {
        frames.push(frame);
        const ok = returns[i] ?? true;
        i += 1;
        return ok;
      },
      onceDrain(listener: () => void): void {
        drain = listener;
        drainRegistrations += 1;
      },
    },
  };
}

describe("SseStreamPump — backpressure pause/resume", () => {
  it("pauses on the first write that returns false and does NOT advance the cursor past un-written entries", async () => {
    const w = mockWriter([false]); // the FIRST write signals a full buffer
    const entries = [entry(1), entry(2), entry(3)];
    const pump = new SseStreamPump(
      {
        readPage: async () => page(entries, encodeOutboxCursor({ txid: "10", seq: 99 })),
        writer: w.writer,
        formatEntry: (e) => `data:${e.seq}\n\n`,
      },
      "0.0"
    );

    await pump.tick();

    // Only the first entry was written (backpressure stopped the tick there).
    expect(w.frames).toEqual(["data:1\n\n"]);
    expect(pump.isPaused).toBe(true);
    expect(w.hasDrain()).toBe(true);
    // The cursor sits ON entry 1 (the last written), NEVER past 2/3, and NEVER
    // at the scanned frontier (99) — un-written entries are re-read next tick.
    expect(pump.currentCursor).toBe(encodeOutboxCursor({ txid: "10", seq: 1 }));
  });

  it("while paused, a tick is a no-op (no read, no write, cursor frozen)", async () => {
    const w = mockWriter([false]);
    let reads = 0;
    const pump = new SseStreamPump(
      {
        readPage: async () => {
          reads += 1;
          return page([entry(1), entry(2)], "10.50");
        },
        writer: w.writer,
        formatEntry: (e) => `data:${e.seq}\n\n`,
      },
      "0.0"
    );

    await pump.tick(); // pauses on entry 1
    expect(reads).toBe(1);
    const cursorWhilePaused = pump.currentCursor;

    await pump.tick(); // paused → must be a no-op
    expect(reads).toBe(1); // no second read
    expect(w.frames).toEqual(["data:1\n\n"]); // no further writes
    expect(pump.currentCursor).toBe(cursorWhilePaused);
  });

  it("drain resumes and delivers exactly the un-written remainder (no skip, no re-send)", async () => {
    // First tick: read [1,2,3], write 1 (ok=false) → pause on 1.
    // After drain: read strictly-after-1 → [2,3], both written ok.
    const w = mockWriter([false, true, true]);
    const pages: OutboxPage[] = [
      page([entry(1), entry(2), entry(3)], "10.99"),
      page([entry(2), entry(3)], "10.99"),
    ];
    let call = 0;
    const seenCursors: string[] = [];
    const pump = new SseStreamPump(
      {
        readPage: async (cursor) => {
          seenCursors.push(cursor);
          return pages[call++]!;
        },
        writer: w.writer,
        formatEntry: (e) => `data:${e.seq}\n\n`,
      },
      "0.0"
    );

    await pump.tick();
    expect(pump.isPaused).toBe(true);
    expect(w.frames).toEqual(["data:1\n\n"]);

    // Drain fires the one-shot listener, which clears `paused` and runs a
    // catch-up tick from the UN-advanced cursor (10.1).
    w.fireDrain();
    await Promise.resolve(); // let the async catch-up tick settle
    await new Promise((r) => setTimeout(r, 0));

    expect(pump.isPaused).toBe(false);
    // The catch-up read started strictly after entry 1, so 1 is never re-sent
    // and 2/3 are never skipped.
    expect(seenCursors).toEqual(["0.0", encodeOutboxCursor({ txid: "10", seq: 1 })]);
    expect(w.frames).toEqual(["data:1\n\n", "data:2\n\n", "data:3\n\n"]);
    expect(pump.currentCursor).toBe("10.99"); // fully drained → scanned frontier
  });

  it("a fully-written tick advances the cursor to the scanned frontier (over trailing filtered gaps)", async () => {
    const w = mockWriter([true, true]);
    const pump = new SseStreamPump(
      {
        // orderedItems ends at seq 2, but the scan frontier (a trailing
        // filtered-out row) is 10.7 — a completed tick advances over the gap.
        readPage: async () => page([entry(1), entry(2)], "10.7"),
        writer: w.writer,
        formatEntry: (e) => `data:${e.seq}\n\n`,
      },
      "0.0"
    );

    await pump.tick();
    expect(pump.isPaused).toBe(false);
    expect(w.frames).toEqual(["data:1\n\n", "data:2\n\n"]);
    expect(pump.currentCursor).toBe("10.7");
  });

  it("an empty scan advances the cursor to the (advanced) frontier without writing", async () => {
    const w = mockWriter();
    const pump = new SseStreamPump(
      {
        readPage: async () => page([], "10.42"),
        writer: w.writer,
        formatEntry: (e) => `data:${e.seq}\n\n`,
      },
      "0.0"
    );

    await pump.tick();
    expect(w.frames).toEqual([]);
    expect(pump.isPaused).toBe(false);
    expect(pump.currentCursor).toBe("10.42");
  });

  it("a second tick() while the first's read is in flight is a no-op (no duplicate write, one drain listener)", async () => {
    // A slow DB read (>poll interval) or the interval landing inside a drain
    // catch-up would otherwise let two ticks read the same cursor concurrently
    // and both write the page → duplicate frames + stacked drain listeners.
    const w = mockWriter([false, false]);
    let release!: () => void;
    let reads = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pump = new SseStreamPump(
      {
        readPage: async () => {
          reads += 1;
          await gate; // hold the first read open
          return page([entry(1), entry(2)], "10.99");
        },
        writer: w.writer,
        formatEntry: (e) => `data:${e.seq}\n\n`,
      },
      "0.0"
    );

    const first = pump.tick(); // enters, read is now in flight (awaiting the gate)
    const second = pump.tick(); // must bail immediately on the inFlight guard
    await second;
    expect(reads).toBe(1); // the second tick never read
    expect(w.frames).toEqual([]); // nothing written yet

    release();
    await first;
    // Only the first tick wrote, and it registered exactly ONE drain listener.
    expect(w.frames).toEqual(["data:1\n\n"]);
    expect(w.drainRegistrations).toBe(1);
    expect(pump.currentCursor).toBe(encodeOutboxCursor({ txid: "10", seq: 1 }));
  });

  it("stop() makes an in-flight and every subsequent tick a no-op (no write against a closed socket)", async () => {
    const w = mockWriter([true, true]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pump = new SseStreamPump(
      {
        readPage: async () => {
          await gate;
          return page([entry(1), entry(2)], "10.9");
        },
        writer: w.writer,
        formatEntry: (e) => `data:${e.seq}\n\n`,
      },
      "0.0"
    );

    const inflight = pump.tick(); // read in flight
    pump.stop(); // connection closed mid-read
    release();
    await inflight;
    expect(w.frames).toEqual([]); // the page read after stop() is dropped

    await pump.tick(); // subsequent ticks are no-ops too
    expect(w.frames).toEqual([]);
  });

  it("a read error leaves the cursor and paused-state untouched (logged, not thrown)", async () => {
    const w = mockWriter();
    const errors: unknown[] = [];
    const pump = new SseStreamPump(
      {
        readPage: async () => {
          throw new Error("poll failed");
        },
        writer: w.writer,
        formatEntry: (e) => `data:${e.seq}\n\n`,
        onError: (err) => errors.push(err),
      },
      "3.3"
    );

    await expect(pump.tick()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(pump.currentCursor).toBe("3.3");
    expect(pump.isPaused).toBe(false);
  });
});
