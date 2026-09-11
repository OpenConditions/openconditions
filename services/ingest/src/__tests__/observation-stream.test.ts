import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Observation } from "@openconditions/core";
import { startObservationStream } from "../observation-stream.js";

function event(id: string, dataUpdatedAt = "2026-09-11T12:00:00.000Z"): Observation {
  return {
    id,
    source: "test",
    sourceFormat: "native",
    domain: "roads",
    kind: "event",
    geometry: { type: "Point", coordinates: [13, 52] },
    status: "active",
    origin: { kind: "feed", attribution: { provider: "test", license: "CC0-1.0" } },
    dataUpdatedAt,
    fetchedAt: dataUpdatedAt,
    isStale: false,
  };
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
    const first = deferred<Observation[]>();
    const { output, frames } = writer();
    const read = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue([event("a", "2026-09-11T12:01:00.000Z")]);
    stops.push(startObservationStream({ output, read, pollMs: 10, onError: vi.fn() }));
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([]);
    first.resolve([event("a")]);
    await settle();
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain("2026-09-11T12:01:00.000Z");
  });

  it("discards a pending read after the connection closes and leaves no polling timer", async () => {
    const pending = deferred<Observation[]>();
    const { output, frames } = writer();
    const read = vi.fn(() => pending.promise);
    const onStop = vi.fn();
    stops.push(startObservationStream({ output, read, pollMs: 10, onError: vi.fn(), onStop }));
    output.destroy();
    await settle();
    pending.resolve([event("late")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for drain before writing the next frame or polling again", async () => {
    const { output, frames, drain } = writer(true);
    const read = vi.fn().mockResolvedValue([event("a"), event("b")]);
    stops.push(
      startObservationStream({ output, read, pollMs: 10, drainTimeoutMs: 100, onError: vi.fn() })
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
    const read = vi.fn().mockResolvedValue([event("a"), event("b")]);
    const onError = vi.fn();
    stops.push(startObservationStream({ output, read, pollMs: 10, drainTimeoutMs: 30, onError }));
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
      .mockResolvedValueOnce([event("a")])
      .mockRejectedValueOnce(new Error("temporary DB failure"))
      .mockResolvedValue([]);
    const onError = vi.fn();
    stops.push(startObservationStream({ output, read, pollMs: 10, onError }));
    await vi.advanceTimersByTimeAsync(20);
    expect(frames).toEqual([
      expect.stringContaining("id: a\n"),
      'event: remove\ndata: {"id":"a"}\n\n',
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "preserves the raw-payload opt-in without mutating observations: %s",
    async (includeRaw) => {
      const observation = { ...event("a"), sourceRaw: { upstream: "raw-sentinel" } };
      const { output, frames } = writer();
      stops.push(
        startObservationStream({
          output,
          read: async () => [observation],
          includeRaw,
          onError: vi.fn(),
        })
      );
      await settle();
      expect(frames[0]!.includes("raw-sentinel")).toBe(includeRaw);
      expect(observation.sourceRaw).toEqual({ upstream: "raw-sentinel" });
    }
  );
});
