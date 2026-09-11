import { once } from "node:events";
import type { Writable } from "node:stream";
import type { Observation } from "@openconditions/core";
import { diffObservations, sseFrame } from "@openconditions/publishers";

/** One public SSE connection: poll only after the previous snapshot has been
 * written, and stop buffering when the socket asks for drain. */
export function startObservationStream(options: {
  output: Writable;
  read: () => Promise<Observation[]>;
  includeRaw?: boolean;
  pollMs?: number;
  drainTimeoutMs?: number;
  onError: (error: unknown) => void;
  onStop?: () => void;
}): () => void {
  const { output } = options;
  const cancellation = new AbortController();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let prev = new Map<string, string>();

  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    cancellation.abort();
    output.off("close", stop);
    output.off("error", fail);
    output.destroy();
    options.onStop?.();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    options.onError(error);
    stop();
  };

  const write = async (frame: string): Promise<void> => {
    if (closed) return;
    if (output.write(frame)) return;
    // At most one frame is buffered past the socket's high-water mark. A
    // client that never drains is disconnected rather than retaining the
    // snapshot indefinitely or accumulating heartbeats behind it.
    const deadline = setTimeout(
      () => fail(new Error("public SSE client did not drain within the write deadline")),
      options.drainTimeoutMs ?? 30_000
    );
    deadline.unref();
    try {
      await once(output, "drain", { signal: cancellation.signal });
    } finally {
      clearTimeout(deadline);
    }
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      const obs = await options.read();
      if (closed) return;
      const { changed, removed, next } = diffObservations(prev, obs);
      for (const observation of changed) {
        if (closed) return;
        const { sourceRaw: _raw, ...withoutRaw } = observation as Observation & {
          sourceRaw?: unknown;
        };
        await write(
          sseFrame({
            event: "condition",
            id: observation.id,
            data: options.includeRaw ? observation : withoutRaw,
          })
        );
      }
      for (const id of removed) {
        if (closed) return;
        await write(sseFrame({ event: "remove", data: { id } }));
      }
      if (changed.length === 0 && removed.length === 0) await write(": ping\n\n");
      if (!closed) prev = next;
    } catch (error) {
      if (!closed) options.onError(error);
    } finally {
      if (!closed) {
        timer = setTimeout(() => void tick(), options.pollMs ?? 15_000);
        timer.unref();
      }
    }
  };

  output.once("close", stop);
  output.once("error", fail);
  void tick();
  return stop;
}
