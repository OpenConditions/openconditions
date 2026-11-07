import {
  type JmaFamily,
  type JmaReport,
  jmaDataUrl,
  readJmaIndex,
  readJmaReport,
} from "@openconditions/hazards";
import { guardedFetch, type LookupFn } from "@openconditions/ingest-framework";

export interface JmaDownload {
  body: string;
  etag?: string;
  modified?: string;
  checkedAt: number;
}
export interface JmaDownloadStore {
  /** Serializes a URL across workers; commits cache independently of canonical publication. */
  withUrl<T>(
    url: string,
    action: (
      held: JmaDownload | undefined,
      save: (value: JmaDownload) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
  reserve(egress: string, day: string, cap: number): Promise<void>;
  settle(egress: string, day: string, reserved: number, received: number): Promise<void>;
}
const BASE = "https://www.data.jma.go.jp/developer/xml/feed/";
const INDEXES = new Set(
  ["extra.xml", "extra_l.xml", "eqvol.xml", "eqvol_l.xml"].map((n) => BASE + n),
);
const MAX_BYTES = 8_000_000;
export const JMA_DAILY_BYTES = 8_000_000_000;

/** Network policy is fixed here, including a zero-redirect DNS-pinned egress guard. */
export class JmaAcquisition {
  private readonly fetch: typeof fetch;
  constructor(
    private readonly store: JmaDownloadStore,
    private readonly egress: string,
    private readonly now: () => number = Date.now,
    transport?: typeof fetch,
    lookup?: LookupFn,
  ) {
    if (!egress.trim()) throw new Error("JMA: shared egress identity required");
    this.fetch = guardedFetch(
      transport,
      { maxBytes: MAX_BYTES, timeoutMs: 20_000, maxRedirects: 0 },
      {},
      lookup,
    );
  }
  async read(url: string, signal: AbortSignal): Promise<Buffer> {
    // One retry for transient transport/5xx failures, inside the caller's deadline.
    // Each attempt owns a fresh reservation; an uncertain failure is never refunded.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.readOnce(url, signal);
      } catch (error) {
        if (
          attempt >= 1 ||
          signal.aborted ||
          !(
            error instanceof TypeError ||
            (error instanceof Error && /^JMA: HTTP 5\d\d$/.test(error.message))
          )
        )
          throw error;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 250);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
  }
  private async readOnce(url: string, signal: AbortSignal): Promise<Buffer> {
    if (!INDEXES.has(url)) jmaDataUrl(url);
    return this.store.withUrl(url, async (held, save) => {
      signal.throwIfAborted();
      const index = INDEXES.has(url);
      const at = this.now();
      if (!index) {
        const stamp = /\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(url)!;
        const published = Date.parse(
          `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`,
        );
        if (!Number.isFinite(published) || published < at - 45 * 86_400_000)
          throw new Error("JMA: message outside bounded download horizon");
      }
      const interval = url.endsWith("_l.xml") ? 3_600_000 : 60_000;
      if (held && (!index || at - held.checkedAt < interval))
        return Buffer.from(held.body, "base64");
      const headers = new Headers();
      if (held?.etag) headers.set("If-None-Match", held.etag);
      if (held?.modified) headers.set("If-Modified-Since", held.modified);
      const day = new Date(at).toISOString().slice(0, 10);
      // Reservations survive process death; they remain distinguishable from received bytes.
      await this.store.reserve(this.egress, day, MAX_BYTES);
      let received = 0;
      let complete = false;
      try {
        const response = await this.fetch(url, { headers, signal, redirect: "error" });
        if (response.status === 304) {
          complete = true;
          if (!held) throw new Error("JMA: cold 304");
          await save({ ...held, checkedAt: at });
          return Buffer.from(held.body, "base64");
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`JMA: HTTP ${response.status}`);
        }
        if (!response.body) throw new Error("JMA: missing response body");
        const chunks: Buffer[] = [];
        const reader = response.body.getReader();
        try {
          for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) {
              complete = true;
              break;
            }
            received += part.value.byteLength;
            if (received > MAX_BYTES) throw new Error("JMA: payload byte ceiling");
            chunks.push(Buffer.from(part.value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const body = Buffer.concat(chunks);
        // Cache only complete, usable documents; every selected payload is decoded before publication.
        if (index) readJmaIndex(body, []);
        else readJmaReport(body, jmaDataUrl(url).family as JmaFamily);
        await save({
          body: body.toString("base64"),
          checkedAt: at,
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
          ...(response.headers.get("last-modified")
            ? { modified: response.headers.get("last-modified")! }
            : {}),
        });
        return body;
      } finally {
        // A transport/guard failure can hide bytes it consumed internally. Keep that
        // reservation outstanding, rather than inventing a zero-byte successful refund.
        if (complete) await this.store.settle(this.egress, day, MAX_BYTES, received);
      }
    });
  }
  async poll(
    channel: "extra" | "eqvol",
    families: readonly JmaFamily[],
    lastSuccess: number | undefined,
    signal: AbortSignal,
  ): Promise<{ reports: { url: string; report: JmaReport }[]; gap: boolean }> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const at = this.now();
    const gap = lastSuccess === undefined || at - lastSuccess > 600_000;
    const urls = new Set<string>();
    for (const suffix of gap ? ["_l", ""] : [""]) {
      const index = readJmaIndex(
        await this.read(`${BASE}${channel}${suffix}.xml`, deadline),
        families,
      );
      if (
        Date.parse(index.updated) > at + 60_000 ||
        at - Date.parse(index.updated) > (suffix ? 7_200_000 : 600_000)
      )
        throw new Error("JMA: aged or future index");
      for (const url of index.urls) urls.add(url);
    }
    if (urls.size > 1000) throw new Error("JMA: poll payload count ceiling");
    const reports: { url: string; report: JmaReport }[] = [];
    // Serial downloads bound concurrency and stop the entire poll on any unusable selected document.
    for (const url of [...urls].sort()) {
      const body = await this.read(url, deadline);
      reports.push({
        url,
        report: { ...readJmaReport(body, jmaDataUrl(url).family as JmaFamily), messageUrl: url },
      });
    }
    return { reports, gap };
  }
}
