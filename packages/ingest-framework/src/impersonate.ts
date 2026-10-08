/**
 * A fetch that presents a real browser's TLS and HTTP fingerprint through
 * `impit`, for the upstreams that serve a bot-mitigation challenge to Node's
 * own fingerprint (Open Charge Map behind Cloudflare). It keeps the egress
 * guard's promises: https only, every hop checked for private addresses by
 * name and by DNS, redirects followed by hand, a total deadline, and a byte
 * cap on the body.
 */

import {
  assertPublicUrl,
  BODY_HEADERS,
  CROSS_HOST_HEADERS,
  type FetchGuardOptions,
  guardOptionsFromEnv,
  type LookupFn,
  resolvePublicIps,
  withinDeadline,
} from "./egress.js";

/** What the guard needs of an impersonating client; `impit`'s `Impit` satisfies it. */
export interface ImpersonationClient {
  fetch(
    resource: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
      redirect?: "manual";
    },
  ): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }>;
}

export interface ImpersonationOptions {
  /** Replaces the `impit` client (tests). */
  client?: ImpersonationClient;
  /** Replaces DNS resolution (tests). */
  lookup?: LookupFn;
  /** Replaces the guard caps read from the environment. */
  guard?: FetchGuardOptions;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let shared: Promise<ImpersonationClient> | undefined;

/** One shared client: it owns a connection pool, so it is built once, on first use. */
function defaultClient(): Promise<ImpersonationClient> {
  shared ??= import("impit").then(
    ({ Impit }) => new Impit({ browser: "chrome", timeout: 30_000 }) as ImpersonationClient,
  );
  return shared;
}

/** The host of a URL for an error message: a query string can carry a credential. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the upstream";
  }
}

/** Bound the streamed bytes and the time the body may take. */
function capBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  url: string,
  done: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = 0;
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown) => {
    controller.error(error);
    void reader.cancel(error).catch(() => {});
    done();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => fail(controller, signal.reason), { once: true });
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          done();
          return;
        }
        seen += chunk.value.byteLength;
        if (seen > maxBytes) {
          throw new Error(`response body exceeded ${maxBytes} bytes for ${hostOf(url)}`);
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        fail(controller, error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
      done();
    },
  });
}

/**
 * The impersonating fetch. Callers wrap it like any other base fetch, so the
 * feed's authorization applies on top of it.
 */
export function guardedImpersonatingFetch(options: ImpersonationOptions = {}): typeof fetch {
  const guard = options.guard ?? guardOptionsFromEnv();
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`fetch timed out after ${guard.timeoutMs}ms`)),
      guard.timeoutMs,
    );
    timer.unref();
    const finish = () => clearTimeout(timer);
    const signal = init?.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller.signal;
    try {
      let url = input instanceof Request ? input.url : String(input);
      let method = init?.method ?? "GET";
      let headers = Object.fromEntries(new Headers(init?.headers));
      // The client sends text only: a form becomes its encoding, as fetch
      // sends it; any other body would go out empty, so it is refused.
      let body: string | undefined;
      if (typeof init?.body === "string") body = init.body;
      else if (init?.body instanceof URLSearchParams) {
        body = init.body.toString();
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        }
      } else if (init?.body !== undefined && init.body !== null) {
        throw new Error("an impersonated request carries a text or form body only");
      }
      const client = options.client ?? (await defaultClient());

      for (let hop = 0; hop <= guard.maxRedirects; hop++) {
        assertPublicUrl(url, guard.allowedHosts);
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") {
          throw new Error("Impersonated requests must use https");
        }
        const host = parsed.hostname.replace(/^\[|\]$/g, "");
        // Residual risk: impit resolves the name again when it connects and
        // cannot be pinned to these addresses, so a short-TTL name could pass
        // this check and then resolve to a private address. The undici guard
        // closes that window; this path cannot.
        await withinDeadline(
          resolvePublicIps(host, options.lookup, {
            allowPrivate: guard.allowedHosts?.has(host.toLowerCase()) ?? false,
          }),
          signal,
        );

        const res = await client.fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal,
          redirect: "manual",
        });

        if (REDIRECT_STATUSES.has(res.status)) {
          const location = res.headers.get("location");
          void res.body?.cancel().catch(() => {});
          if (!location) throw new Error(`redirect ${res.status} without Location`);
          const next = new URL(location, url);
          // As fetch does: 303 always becomes a GET, 301 and 302 do for a POST.
          if (
            res.status === 303 ||
            ((res.status === 301 || res.status === 302) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
            // The body's own headers go with it.
            headers = Object.fromEntries(
              Object.entries(headers).filter(([k]) => !BODY_HEADERS.has(k.toLowerCase())),
            );
          }
          if (next.host !== parsed.host) {
            // A body may be a credential itself (an OAuth client secret).
            if (body !== undefined) {
              throw new Error(`redirect ${res.status} would send the request body to another host`);
            }
            headers = Object.fromEntries(
              Object.entries(headers).filter(([k]) => CROSS_HOST_HEADERS.has(k.toLowerCase())),
            );
          }
          url = next.toString();
          continue;
        }

        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > guard.maxBytes) {
          void res.body?.cancel().catch(() => {});
          throw new Error(`Content-Length ${declared} exceeds max ${guard.maxBytes}`);
        }
        const bodiless = res.status === 204 || res.status === 304;
        if (bodiless || !res.body) {
          void res.body?.cancel().catch(() => {});
          finish();
          return new Response(null, { status: res.status, headers: res.headers });
        }
        return new Response(capBody(res.body, guard.maxBytes, signal, url, finish), {
          status: res.status,
          headers: res.headers,
        });
      }
      throw new Error(`too many redirects (>${guard.maxRedirects})`);
    } catch (error) {
      finish();
      throw error;
    }
  }) as typeof fetch;
}
