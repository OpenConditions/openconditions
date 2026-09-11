import type { GeoJsonGeometry } from "@openconditions/core";
import type { OpenLrLocation } from "./decode.js";

export type { GeoJsonGeometry };

/** Contract for a map-matching client that resolves an OpenLR location to geometry. */
export interface MapMatchClient {
  /**
   * Resolve an OpenLR location to a GeoJSON geometry via the remote resolver.
   *
   * Returns null when the resolver finds no match (HTTP 404) or when the
   * location cannot be projected onto the road network.
   */
  resolve(loc: OpenLrLocation, signal?: AbortSignal): Promise<GeoJsonGeometry | null>;
}

export interface ResolverClientOptions {
  /** Total request deadline, including response body consumption. */
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function readGeometry(body: unknown): GeoJsonGeometry {
  const geometry = (body as { geometry?: unknown } | null)?.geometry;
  if (geometry == null) {
    throw new Error("openlr-resolver returned a 200 response with no geometry field");
  }
  const line = geometry as { type?: unknown; coordinates?: unknown };
  if (
    line.type !== "LineString" ||
    !Array.isArray(line.coordinates) ||
    line.coordinates.length < 2 ||
    !line.coordinates.every(
      (point: unknown) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        point.length <= 3 &&
        point.every((n: unknown) => typeof n === "number" && Number.isFinite(n)) &&
        Math.abs(point[0]) <= 180 &&
        Math.abs(point[1]) <= 90
    )
  ) {
    throw new Error("openlr-resolver returned invalid LineString geometry");
  }
  return geometry as GeoJsonGeometry;
}

/**
 * Create an HTTP client that delegates map-matching to the openlr-resolver
 * service at `baseUrl`.
 *
 * Wire contract: POST <baseUrl>/resolve
 *   body: { location: OpenLrLocation }
 *   response 200: { geometry: GeoJSON, confidence: number }
 *   response 404: no match
 */
export function createResolverClient(
  baseUrl: string,
  options: ResolverClientOptions = {}
): MapMatchClient {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/resolve`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxResponseBytes ?? 1_048_576;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new Error("Invalid openlr-resolver request limits");
  }
  return {
    async resolve(loc, callerSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort(callerSignal?.reason);
      if (callerSignal?.aborted) abort();
      else callerSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error("openlr-resolver deadline exceeded")),
        timeoutMs
      );
      const signal = controller.signal;
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let res: Response | undefined;
      try {
        signal.throwIfAborted();
        res = await Promise.race([
          fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ location: loc }),
            signal,
          }),
          aborted,
        ]);
        if (res.status === 404) return null;
        if (!res.ok)
          throw new Error(`openlr-resolver responded with ${res.status} ${res.statusText}`);
        if (Number(res.headers.get("content-length")) > maxBytes) {
          throw new Error("openlr-resolver response exceeds byte limit");
        }
        if (!res.body) throw new Error("openlr-resolver returned an empty body");
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = "";
        for (;;) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new Error("openlr-resolver response exceeds byte limit");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        return readGeometry(JSON.parse(text));
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", abort);
        signal.removeEventListener("abort", onAbort);
        if (reader) void reader.cancel().catch(() => {});
        else if (res?.body) void res.body.cancel().catch(() => {});
        controller.abort();
      }
    },
  };
}
