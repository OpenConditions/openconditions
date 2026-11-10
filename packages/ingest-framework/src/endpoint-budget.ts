import type { FetchFn } from "./catalog/types.js";

/** Tighten the caller's egress limits for a bulk endpoint, including the streamed body. */
export function budgetFetch(
  base: FetchFn,
  budget: { maxBytes: number; deadlineSec: number },
): FetchFn {
  return async (url, init) => {
    const controller = new AbortController();
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("endpoint budget deadline exceeded");
        controller.abort(error);
        reject(error);
      }, budget.deadlineSec * 1000);
    });
    const clear = () => clearTimeout(timer);
    try {
      const response = await Promise.race([base(url, { ...init, signal }), deadline]);
      const declared = Number(response.headers.get("content-length"));
      if (declared > budget.maxBytes) {
        const error = new Error("endpoint byte budget exceeded");
        controller.abort(error);
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      if (!response.body) {
        clear();
        return response;
      }
      const reader = response.body.getReader();
      let bytes = 0;
      const capped = new Response(
        new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              const part = await Promise.race([reader.read(), deadline]);
              if (part.done) {
                clear();
                stream.close();
                return;
              }
              bytes += part.value.byteLength;
              if (bytes > budget.maxBytes) throw new Error("endpoint byte budget exceeded");
              stream.enqueue(part.value);
            } catch (error) {
              clear();
              controller.abort(error);
              void reader.cancel().catch(() => {});
              stream.error(error);
            }
          },
          async cancel(reason) {
            clear();
            controller.abort(reason);
            await reader.cancel(reason);
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
      Object.defineProperty(capped, "url", { value: response.url });
      return capped;
    } catch (error) {
      clear();
      controller.abort(error);
      throw error;
    }
  };
}
