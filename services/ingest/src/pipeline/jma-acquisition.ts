import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { type JmaFamily, type JmaReport, jmaDataUrl } from "@openconditions/hazards";
import { guardedFetch, type LookupFn } from "@openconditions/ingest-framework";
import { closeJmaNative, type JmaNativeSession, jmaNative } from "./jma-native-process.js";

export interface JmaDownload {
  body: string;
  etag?: string;
  modified?: string;
  checkedAt: number;
  acquiredAt?: number;
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
// Reserve room for the largest next response before touching cache or transport.
// The same budget covers both warning channels, indexes and retained native reports.
export const JMA_TRANSIENT_BYTES = 16_000_000;
export interface JmaInputBudget {
  used: number;
}
export const JMA_DAILY_BYTES = 8_000_000_000;

/** Network policy is fixed here, including a zero-redirect DNS-pinned egress guard. */
export class JmaAcquisition {
  private readonly native: JmaNativeSession;
  private readonly fetch: typeof fetch;
  private retire?: NodeJS.Timeout;
  async close(): Promise<void> {
    clearTimeout(this.retire);
    await closeJmaNative(this.native);
  }
  private idle(): void {
    this.native.child?.unref();
    this.native.child?.channel?.unref();
    this.retire = setTimeout(() => {
      void this.close();
    }, 1000);
    this.retire.unref();
  }
  constructor(
    private readonly store: JmaDownloadStore,
    private readonly egress: string,
    private readonly now: () => number = Date.now,
    transport?: typeof fetch,
    lookup?: LookupFn,
    nativeEntry?: URL,
    private readonly session?: JmaNativeSession,
  ) {
    this.native = session ?? {};
    this.native.entry ??= nativeEntry;
    if (!egress.trim()) throw new Error("JMA: shared egress identity required");
    this.fetch = guardedFetch(
      transport,
      { maxBytes: MAX_BYTES, timeoutMs: 20_000, maxRedirects: 0 },
      {},
      lookup,
    );
  }
  async read(url: string, signal: AbortSignal): Promise<Buffer> {
    clearTimeout(this.retire);
    try {
      return (await this.readDocument(url, signal, { used: 0 })).body;
    } finally {
      await closeJmaNative(this.native);
    }
  }
  private async readDocument(
    url: string,
    signal: AbortSignal,
    budget: JmaInputBudget,
  ): Promise<{ body: Buffer; acquiredAt: number; networkValidated: boolean }> {
    // One retry for transient transport/5xx failures, inside the caller's deadline.
    // Each attempt owns a fresh reservation; an uncertain failure is never refunded.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.readOnce(url, signal, budget);
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
  private async readOnce(
    url: string,
    signal: AbortSignal,
    budget: JmaInputBudget,
  ): Promise<{ body: Buffer; acquiredAt: number; networkValidated: boolean }> {
    await yieldTurn();
    signal.throwIfAborted();
    if (budget.used + MAX_BYTES > JMA_TRANSIENT_BYTES)
      throw new Error("JMA: aggregate transient input ceiling");
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
      if (held && index && (!Number.isFinite(held.checkedAt) || held.checkedAt > at + 60_000))
        throw new Error("JMA: invalid index transport check time");
      const cached = () => {
        if (!held || held.body.length > Math.ceil(MAX_BYTES / 3) * 4)
          throw new Error("JMA: cached payload byte ceiling");
        const bytes = Buffer.byteLength(held.body, "base64");
        if (budget.used + bytes > JMA_TRANSIENT_BYTES)
          throw new Error("JMA: aggregate transient input ceiling");
        const body = Buffer.from(held.body, "base64");
        if (body.length > MAX_BYTES) throw new Error("JMA: cached payload byte ceiling");
        if (budget.used + body.length > JMA_TRANSIENT_BYTES)
          throw new Error("JMA: aggregate transient input ceiling");
        budget.used += body.length;
        return body;
      };
      if (held && (!index || at - held.checkedAt < interval))
        return {
          body: cached(),
          acquiredAt: held.acquiredAt ?? held.checkedAt,
          networkValidated: false,
        };
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
        if (index && (response.status === 200 || response.status === 304)) {
          // HTTP validation age describes transport freshness. Atom updated describes
          // publication activity and can legitimately stay unchanged during quiet periods.
          const maxAge = url.endsWith("_l.xml") ? 7_200_000 : 600_000;
          const ageHeader = response.headers.get("age");
          const dateHeader = response.headers.get("date");
          const age = ageHeader === null ? 0 : Number(ageHeader) * 1000;
          const date = dateHeader === null ? at : Date.parse(dateHeader);
          if (
            (ageHeader !== null && !/^\d+$/.test(ageHeader)) ||
            !Number.isFinite(age) ||
            !Number.isFinite(date) ||
            date > at + 60_000 ||
            Math.max(age, at - date) > maxAge
          ) {
            await response.body?.cancel();
            throw new Error("JMA: stale or invalid index transport metadata");
          }
        }
        if (response.status === 304) {
          complete = true;
          if (!held) throw new Error("JMA: cold 304");
          const body = cached();
          signal.throwIfAborted();
          await save({ ...held, acquiredAt: held.acquiredAt ?? held.checkedAt, checkedAt: at });
          return {
            body,
            acquiredAt: held.acquiredAt ?? held.checkedAt,
            networkValidated: true,
          };
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
            budget.used += part.value.byteLength;
            chunks.push(Buffer.from(part.value));
            await yieldTurn();
            signal.throwIfAborted();
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const body = Buffer.concat(chunks);
        // Cache only complete, usable documents; every selected payload is decoded before publication.
        if (index) {
          const updated = Date.parse(
            (
              await jmaNative(
                { kind: "index", body: body.toString("base64"), families: [] },
                signal,
                this.native,
              )
            ).updated,
          );
          if (updated > at + 60_000) throw new Error("JMA: future index publication");
          if (
            held &&
            updated <
              Date.parse(
                (
                  await jmaNative(
                    { kind: "index", body: cached().toString("base64"), families: [] },
                    signal,
                    this.native,
                  )
                ).updated,
              )
          )
            throw new Error("JMA: backward index publication");
        } else
          await jmaNative(
            {
              kind: "report",
              body: body.toString("base64"),
              family: jmaDataUrl(url).family as JmaFamily,
            },
            signal,
            this.native,
          );
        signal.throwIfAborted();
        await save({
          body: body.toString("base64"),
          checkedAt: at,
          acquiredAt: at,
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
          ...(response.headers.get("last-modified")
            ? { modified: response.headers.get("last-modified")! }
            : {}),
        });
        return { body, acquiredAt: at, networkValidated: true };
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
    budget: JmaInputBudget = { used: 0 },
  ): Promise<{
    reports: { url: string; report: JmaReport }[];
    gap: boolean;
    networkValidated: boolean;
    payloadHashes: string[];
  }> {
    clearTimeout(this.retire);
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const at = this.now();
      const gap = lastSuccess === undefined || at - lastSuccess > 600_000;
      const urls = new Set<string>();
      let networkValidated = true;
      const payloadHashes: string[] = [];
      for (const suffix of gap ? ["_l", ""] : [""]) {
        const document = await this.readDocument(
          `${BASE}${channel}${suffix}.xml`,
          deadline,
          budget,
        );
        networkValidated &&= document.networkValidated;
        const index = await jmaNative(
          { kind: "index", body: document.body.toString("base64"), families },
          deadline,
          this.native,
        );
        if (Date.parse(index.updated) > at + 60_000)
          throw new Error("JMA: future index publication");
        for (const url of index.urls) urls.add(url);
      }
      if (urls.size > 1000) throw new Error("JMA: poll payload count ceiling");
      const reports: { url: string; report: JmaReport }[] = [];
      // Serial downloads bound concurrency and stop the entire poll on any unusable selected document.
      for (const url of [...urls].sort()) {
        const { body, acquiredAt } = await this.readDocument(url, deadline, budget);
        payloadHashes.push(createHash("sha256").update(body).digest("hex"));
        reports.push({
          url,
          report: {
            ...(await jmaNative(
              {
                kind: "report",
                body: body.toString("base64"),
                family: jmaDataUrl(url).family as JmaFamily,
              },
              deadline,
              this.native,
            )),
            messageUrl: url,
            acquiredAt: new Date(acquiredAt).toISOString(),
          },
        });
      }
      if (!this.session) this.idle();
      return { reports, gap, networkValidated, payloadHashes };
    } catch (error) {
      await this.close();
      throw error;
    }
  }
}
