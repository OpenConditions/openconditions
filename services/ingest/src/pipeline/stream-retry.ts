/** Transient undici/socket error codes + messages that a re-fetch usually clears. */
const TRANSIENT_CODES = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);

const TRANSIENT_MESSAGES = ["terminated", "other side closed", "socket hang up", "fetch failed"];

/**
 * True for the mid-stream socket drops seen on large NDW downloads — undici's
 * `TypeError: terminated` whose cause is `SocketError: other side closed`
 * (UND_ERR_SOCKET), plus the usual connection-reset family. These clear on a
 * re-fetch (undici has evicted the dropped socket, so a stale keep-alive
 * connection is not reused), unlike an HTTP 4xx/5xx or a parse error, which are
 * bugs/permanent and must not be retried. Walks the `cause` chain (bounded).
 */
export function isTransientSocketError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e != null && depth < 8; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    if (TRANSIENT_MESSAGES.some((m) => msg.includes(m))) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

interface RetryOpts {
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Runs a streaming fetch+parse attempt with bounded retries on transient socket
 * drops. Each retry calls `fn` fresh — a fresh connection (the dropped socket is
 * evicted) and a fresh parser — so a mid-stream `other side closed` is re-fetched
 * rather than lost as a skipped cycle. Non-transient errors (HTTP status, empty
 * body, parse failures) throw immediately, and the final transient error is
 * rethrown so the caller's last-good handling still applies.
 */
export async function withStreamRetry<T>(
  fn: () => Promise<T>,
  label: string,
  { retries = 2, baseDelayMs = 250 }: RetryOpts = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransientSocketError(err)) throw err;
      const delayMs = baseDelayMs * 2 ** attempt;
      console.warn(
        `[ingest] ${label}: transient stream error on attempt ${attempt + 1}/${retries + 1}, retrying in ${delayMs}ms:`,
        err instanceof Error ? err.message : err
      );
      await sleep(delayMs);
    }
  }
}
