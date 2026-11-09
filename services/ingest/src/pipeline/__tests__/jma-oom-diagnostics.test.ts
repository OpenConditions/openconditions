import childProcess from "node:child_process";
import { expect, test } from "vitest";
import { observeOomFork, oomTrace } from "./jma-oom-diagnostics.js";

test("OOM trace bounds event count and raw stderr while retaining fatal tail and byte count", () => {
  const trace = oomTrace();
  trace.stderr(123, Buffer.alloc(20_000, 120));
  const fatal = Buffer.from("FATAL ERROR: JavaScript heap out of memory\n");
  trace.stderr(123, fatal);
  for (let i = 0; i < 100; i++) trace.record("synthetic", { pid: 123 });
  const snapshot = trace.snapshot();
  expect(snapshot.events).toHaveLength(32);
  expect(snapshot.events[0]).toMatchObject({ event: "stderr", pid: 123, ms: expect.any(Number) });
  expect(snapshot.stderrBytes).toBe(20_000 + fatal.length);
  expect(Buffer.byteLength(snapshot.stderrTail)).toBe(16_384);
  expect(snapshot.stderrTail.endsWith(fatal.toString())).toBe(true);
});

test("OOM observer records cancellation and restores the fork and abort listener", () => {
  const fork = childProcess.fork;
  const controller = new AbortController();
  const observer = observeOomFork(controller.signal);
  try {
    controller.abort();
    expect(observer.snapshot().events).toEqual([expect.objectContaining({ event: "abort" })]);
  } finally {
    observer.restore();
  }
  expect(childProcess.fork).toBe(fork);
  const later = new AbortController();
  const restored = observeOomFork(later.signal);
  restored.restore();
  later.abort();
  expect(restored.snapshot().events).toEqual([]);
  expect(childProcess.fork).toBe(fork);
});
