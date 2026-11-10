import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { vi } from "vitest";

// Test-only, synthetic input: retain bounded fatal bytes without logging the IPC payload/env.
export function oomTrace() {
  const start = performance.now();
  const events: object[] = [];
  let stderr = Buffer.alloc(0);
  let stderrBytes = 0;
  let fatalSeen = false;
  const record = (event: string, metadata: object = {}) => {
    if (events.length < 32)
      events.push({ event, ms: Math.round(performance.now() - start), ...metadata });
  };
  return {
    record,
    stderr(pid: number | undefined, chunk: Buffer) {
      if (!stderrBytes) record("stderr", { pid });
      stderrBytes += chunk.length;
      stderr = Buffer.concat([stderr, chunk]).subarray(-16_384);
      if (!fatalSeen && stderr.includes("FATAL ERROR")) {
        fatalSeen = true;
        record("fatal-stderr", { pid });
      }
    },
    snapshot: () => ({ events, stderrBytes, stderrTail: stderr.toString("utf8") }),
  };
}

export function observeOomFork(signal: AbortSignal) {
  const trace = oomTrace();
  const abort = () => trace.record("abort");
  signal.addEventListener("abort", abort, { once: true });
  const originalFork = childProcess.fork;
  const restores: (() => void)[] = [];
  const fork = vi.spyOn(childProcess, "fork").mockImplementation((entry, argsOrOptions) => {
    if (Array.isArray(argsOrOptions)) throw new Error("Unexpected JMA fork arguments");
    const options = argsOrOptions as childProcess.ForkOptions | undefined;
    const child = originalFork(entry, { ...options, stdio: ["ignore", "inherit", "pipe", "ipc"] });
    const pid = child.pid;
    trace.record("fork", {
      pid,
      execArgv: options?.execArgv,
      emptyNodeOptions: options?.env?.NODE_OPTIONS === "",
    });
    const data = (chunk: Buffer) => trace.stderr(pid, chunk);
    child.stderr!.on("data", data);
    const message = (value: unknown) => {
      if (value === "started") trace.record("started", { pid });
    };
    child.on("message", message);
    const exit = (code: number | null, signal: NodeJS.Signals | null) =>
      trace.record("exit", { pid, code, signal });
    child.once("exit", exit);
    const send = child.send;
    const sendSpy = vi.spyOn(child, "send").mockImplementation((...args) => {
      trace.record("send", {
        pid,
        bytes: typeof args[0] === "string" ? Buffer.byteLength(args[0]) : undefined,
      });
      return send.apply(child, args);
    });
    restores.push(() => {
      sendSpy.mockRestore();
      child.stderr!.off("data", data);
      child.off("message", message);
      child.off("exit", exit);
    });
    return child;
  });
  syncBuiltinESMExports();
  const linux: Record<string, string> = {};
  if (process.platform === "linux") {
    for (const path of ["/proc/self/limits", "/proc/sys/kernel/core_pattern"]) {
      try {
        const raw = readFileSync(path, "utf8");
        linux[path] = (
          path.endsWith("limits")
            ? (raw.split("\n").find((line) => line.startsWith("Max core file size")) ?? "missing")
            : raw
        ).slice(0, 1024);
      } catch {
        linux[path] = "unavailable";
      }
    }
  }
  return {
    record: trace.record,
    snapshot: () => ({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      linux,
      ...trace.snapshot(),
    }),
    restore() {
      fork.mockRestore();
      syncBuiltinESMExports();
      for (const restore of restores) restore();
      signal.removeEventListener("abort", abort);
    },
  };
}
