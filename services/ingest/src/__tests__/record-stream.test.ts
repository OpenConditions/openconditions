import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRecordStream } from "../record-stream.js";

type Rec = Record<string, unknown>;

function situation(id: string, contentHash = "h1"): Rec {
  return { id, class: "situation", kind: "closure", contentHash };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function writer(stalled = false) {
  const frames: string[] = [];
  const pending: Array<() => void> = [];
  const output = new Writable({
    highWaterMark: stalled ? 1 : 16_384,
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      if (stalled) pending.push(callback);
      else callback();
    },
  });
  return { output, frames, drain: () => pending.shift()?.() };
}

const stops: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("public observation SSE lifecycle", () => {
  it("cannot overlap reads or let an older read complete after a newer snapshot", async () => {
    const first = deferred<Rec[]>();
    const { output, frames } = writer();
    const read = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue([situation("a", "h2")]);
    stops.push(startRecordStream({ output, read, pollMs: 10, onError: vi.fn() }));
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([]);
    first.resolve([situation("a")]);
    await settle();
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain('"contentHash":"h2"');
  });

  it("discards a pending read after the connection closes and leaves no polling timer", async () => {
    const pending = deferred<Rec[]>();
    const { output, frames } = writer();
    const read = vi.fn(() => pending.promise);
    const onStop = vi.fn();
    stops.push(startRecordStream({ output, read, pollMs: 10, onError: vi.fn(), onStop }));
    output.destroy();
    await settle();
    pending.resolve([situation("late")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for drain before writing the next frame or polling again", async () => {
    const { output, frames, drain } = writer(true);
    const read = vi.fn().mockResolvedValue([situation("a"), situation("b")]);
    stops.push(
      startRecordStream({ output, read, pollMs: 10, drainTimeoutMs: 100, onError: vi.fn() }),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("id: a\n");
    expect(read).toHaveBeenCalledTimes(1);
    drain();
    await settle();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain("id: b\n");
    expect(read).toHaveBeenCalledTimes(1);
    drain();
    await settle();
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(2);
    expect(frames).toEqual([
      expect.stringContaining("id: a\n"),
      expect.stringContaining("id: b\n"),
      ": ping\n\n",
    ]);
  });

  it("disconnects a writer that never drains without accumulating frames or heartbeats", async () => {
    const { output, frames } = writer(true);
    const read = vi.fn().mockResolvedValue([situation("a"), situation("b")]);
    const onError = vi.fn();
    stops.push(startRecordStream({ output, read, pollMs: 10, drainTimeoutMs: 30, onError }));
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toHaveLength(1);
    expect(output.destroyed).toBe(true);
    expect(output.listenerCount("drain")).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the previous snapshot after a failed read and emits removals on recovery", async () => {
    const { output, frames } = writer();
    const read = vi
      .fn()
      .mockResolvedValueOnce([situation("a")])
      .mockRejectedValueOnce(new Error("temporary DB failure"))
      .mockResolvedValue([]);
    const onError = vi.fn();
    stops.push(startRecordStream({ output, read, pollMs: 10, onError }));
    await vi.advanceTimersByTimeAsync(20);
    expect(frames).toEqual([
      expect.stringContaining("id: a\n"),
      'event: remove\ndata: {"id":"a"}\n\n',
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("names each frame by the record's class and carries the whole record", async () => {
    const { output, frames } = writer();
    stops.push(startRecordStream({ output, read: async () => [situation("a")], onError: vi.fn() }));
    await settle();
    expect(frames).toEqual([
      'id: a\nevent: situation\ndata: {"id":"a","class":"situation","kind":"closure","contentHash":"h1"}\n\n',
    ]);
  });
});
