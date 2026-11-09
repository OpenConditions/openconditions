/** One poll's cumulative wire budget, shared by every role and fan-out request. */
export function acquisitionBudget(
  limits: { requests: number; bytes: number; deadlineSec: number },
  fetch: typeof globalThis.fetch,
  parent?: AbortSignal,
) {
  const controller = new AbortController();
  let requests = 0;
  let bytes = 0;
  const stop = (reason: unknown) => controller.abort(reason);
  const cancel = () => stop(parent!.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const timer = setTimeout(
    () => stop(new Error("acquisition deadline exceeded")),
    limits.deadlineSec * 1000,
  );
  timer.unref();
  const check = () => controller.signal.throwIfAborted();
  const fail = (message: string): never => {
    stop(new Error(message));
    check();
    throw new Error(message);
  };
  const bounded: typeof globalThis.fetch = async (input, init) => {
    check();
    if (++requests > limits.requests) fail("acquisition request budget exceeded");
    const signal = init?.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller.signal;
    const response = await fetch(input, { ...init, signal });
    check();
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          check();
          const next = await reader.read();
          if (next.done) {
            target.close();
            return;
          }
          bytes += next.value.byteLength;
          if (bytes > limits.bytes) fail("acquisition byte budget exceeded");
          target.enqueue(next.value);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          target.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetch: bounded,
    signal: controller.signal,
    check,
    close() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    },
  };
}
