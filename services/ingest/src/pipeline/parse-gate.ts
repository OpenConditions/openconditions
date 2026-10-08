import type { FeedPayloads } from "@openconditions/ingest-framework";

/**
 * Payloads of at least this many bytes (all roles of one poll together) are
 * parsed and written one feed at a time. A national register of this size
 * (IRVE's 158 MB CSV, BNetzA's 55 MB CSV, NDW's and OCPDB's OCPI dumps)
 * turns into hundreds of MB of drafts and stays on the heap until its write
 * commits, so two of them at once can exceed the heap cap.
 */
export const LARGE_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** Serializes the parse-and-write of large payloads across the scheduler's feeds. */
export interface ParseGate {
  /**
   * Runs `task` once no other large payload holds the gate when `bytes`
   * reaches the threshold, and at once when it does not. Waiters run in
   * arrival order; the gate is freed however `task` ends. `label` names the
   * poll in the wait report.
   */
  run<T>(bytes: number, task: () => T | Promise<T>, label?: string): Promise<T>;
}

export interface ParseGateOptions {
  /** Told how long each large payload waited for the gate, in ms. Default: logged above a second. */
  onWait?: (label: string, ms: number) => void;
  now?: () => number;
}

const logWait = (label: string, ms: number) => {
  if (ms >= 1000) console.info(`[gate] ${label} waited ${Math.round(ms / 1000)}s for the gate`);
};

export function createParseGate(
  thresholdBytes = LARGE_PAYLOAD_BYTES,
  opts: ParseGateOptions = {},
): ParseGate {
  const now = opts.now ?? Date.now;
  const onWait = opts.onWait ?? logWait;
  let tail: Promise<void> = Promise.resolve();
  return {
    async run(bytes, task, label = "a poll") {
      if (bytes < thresholdBytes) return task();
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const queued = now();
        await previous;
        onWait(label, now() - queued);
        return await task();
      } finally {
        release();
      }
    },
  };
}

/** The bytes of every payload of every role. */
export function payloadBytes(payloads: FeedPayloads): number {
  let total = 0;
  for (const buffers of Object.values(payloads)) {
    for (const buffer of buffers) total += buffer.length;
  }
  return total;
}
