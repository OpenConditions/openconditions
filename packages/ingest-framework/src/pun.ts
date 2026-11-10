import { createHash } from "node:crypto";
import { z } from "zod";
import type { FetchFn } from "./catalog/types.js";
import type { FetchResult, FetchState } from "./fetch.js";
import { heldBuffer, holdPayload } from "./held.js";
import { digestPayload } from "./payload.js";
import { punCoordinationDirectory, withPunCoordination } from "./pun-coordination.js";

export const PUN_ROOT = "https://cruscotto-italia.dati.gov.it/data/";
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_SHARD = 8 * 1024 * 1024;
const MAX_TOTAL = 96 * 1024 * 1024;
const manifestSchema = z.object({
  sources: z.object({
    pun: z.object({
      status: z.literal("ok"),
      last_run: z.iso.datetime({ offset: true }),
      files: z
        .array(
          z.object({
            key: z.string().regex(/^pun\/[0-9]{6}\.json$/),
            size: z.number().int().positive().max(MAX_SHARD),
            md5: z.string().regex(/^[a-f0-9]{32}$/),
          }),
        )
        .min(1)
        .max(10000),
    }),
  }),
});

/** Only the PUN generation matters; other products may change during the pass. */
export function punManifest(body: Buffer) {
  if (body.length > MAX_MANIFEST) throw Error("PUN manifest exceeds byte budget");
  const pun = manifestSchema.parse(JSON.parse(body.toString())).sources.pun;
  pun.files.sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(pun.files.map((f) => f.key)).size !== pun.files.length)
    throw Error("PUN duplicate manifest paths");
  if (pun.files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL)
    throw Error("PUN generation exceeds byte budget");
  return pun;
}
export function checkPunShard(body: Buffer, file: ReturnType<typeof punManifest>["files"][number]) {
  if (body.length !== file.size || createHash("md5").update(body).digest("hex") !== file.md5)
    throw Error(`PUN size/digest mismatch: ${file.key}`);
}

// One in-process queue across feeds and fetch states; the persistent lease also
// coordinates participating processes. Operators manage independent NAT traffic.
let turn = Promise.resolve();
let next = 0;
export const PUN_BUDGET = {
  elapsedMs: 4 * 60 * 60 * 1000,
  requests: 30006,
  bytes: 384 * 1024 * 1024,
} as const;

function abortable<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error("PUN aborted"));
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
async function pause(ms: number, signal?: AbortSignal | null) {
  const until = Date.now() + Math.max(0, ms);
  signal?.throwIfAborted();
  while (Date.now() < until) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await abortable(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(60000, until - Date.now()));
        }),
        signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
async function boundedBody(response: Response, limit: number, signal?: AbortSignal | null) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        size += value.length;
        if (size > limit) throw Error("PUN response exceeds byte budget");
        chunks.push(value);
      }
    } finally {
      // Cancellation must not hold the host queue waiting for an uncooperative stream.
      void reader.cancel().catch(() => {});
    }
  return Buffer.concat(chunks);
}
/** Serialize through response consumption, so the budget covers open connections too. */
export function punHostFetch(base: FetchFn, deadline = Date.now() + PUN_BUDGET.elapsedMs): FetchFn {
  let requests = 0;
  let bytes = 0;
  const bounded = Number.isFinite(deadline);
  return (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname !== "cruscotto-italia.dati.gov.it") return base(input, init);
    const signal = init?.signal;
    const job = turn.then(() =>
      withPunCoordination(
        punCoordinationDirectory(),
        async (budget) => {
          next = Math.max(next, budget.next);
          signal?.throwIfAborted();
          for (let attempt = 0; attempt < 3; attempt++) {
            if (next >= deadline)
              throw Error("PUN backoff exceeds acquisition deadline; retry a later poll");
            await pause(next - Date.now(), signal);
            signal?.throwIfAborted();
            next = Date.now() + 1000;
            await budget.reserveUntil(next);
            if (bounded && ++requests > PUN_BUDGET.requests)
              throw Error("PUN request budget exceeded");
            let response: Response;
            try {
              response = await abortable(
                base(input, {
                  ...init,
                  headers: {
                    ...Object.fromEntries(new Headers(init?.headers)),
                    "User-Agent":
                      "OpenConditions-PUN/1.0 (+https://github.com/OpenConditions/openconditions)",
                  },
                }),
                signal,
              );
            } catch (error) {
              next = Math.max(next, Date.now() + 1000);
              await budget.reserveUntil(next);
              throw error;
            }
            // Disk latency before the call must not shorten actual request spacing.
            next = Math.max(next, Date.now() + 1000);
            try {
              await budget.reserveUntil(next);
            } catch (error) {
              void response.body?.cancel().catch(() => {});
              throw error;
            }
            if (response.status === 429 || (!response.ok && response.headers.has("retry-after"))) {
              const retry = response.headers.get("retry-after");
              const seconds = Number(retry);
              const retryDeadline =
                retry && Number.isFinite(seconds)
                  ? Date.now() + Math.max(0, seconds) * 1000
                  : Date.parse(retry ?? "");
              next = Math.max(
                next,
                !Number.isNaN(retryDeadline) ? retryDeadline : Date.now() + 60000 * 2 ** attempt,
              );
              try {
                await budget.reserveUntil(next);
              } catch (error) {
                void response.body?.cancel().catch(() => {});
                throw error;
              }
              if (next >= deadline || attempt === 2) {
                void response.body?.cancel().catch(() => {});
                throw Error("PUN rate limited; retry a later poll");
              }
            }
            const body = await boundedBody(
              response,
              Math.min(
                url.endsWith("manifest.json") ? MAX_MANIFEST : MAX_SHARD,
                bounded ? PUN_BUDGET.bytes - bytes : Number.POSITIVE_INFINITY,
              ),
              signal,
            );
            bytes += body.length;
            if (response.status === 429) continue;
            return new Response([204, 205, 304].includes(response.status) ? null : body, {
              status: response.status,
              headers: response.headers,
            });
          }
          throw Error("PUN retry budget exhausted");
        },
        { deadline: Number.isFinite(deadline) ? deadline : undefined, signal },
      ),
    );
    turn = job.then(
      () => {},
      () => {},
    );
    return abortable(job, signal);
  }) as FetchFn;
}

/** An atomic acquisition: no validators or body cache are committed before publication. */
export async function acquirePun(
  base: FetchFn,
  state: FetchState,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(Error("PUN acquisition elapsed deadline exceeded")),
    PUN_BUDGET.elapsedMs,
  );
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = Date.now() + PUN_BUDGET.elapsedMs;
  const host = punHostFetch(base, deadline);
  try {
    return await abortable(acquirePunGeneration(host, state, combined), combined);
  } finally {
    clearTimeout(timer);
  }
}

async function acquirePunGeneration(
  base: FetchFn,
  state: FetchState,
  signal: AbortSignal,
): Promise<FetchResult> {
  const staged = new Map<
    string,
    FetchState["conditional"] extends Map<string, infer V> ? V : never
  >();
  const get = async (url: string, conditional: boolean) => {
    const key = `pun\0${url}`;
    const cached = state.conditional.get(key);
    const headers = new Headers();
    if (conditional && cached?.etag) headers.set("If-None-Match", cached.etag);
    if (conditional && cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);
    const response = await base(url, { headers, signal });
    if (response.status === 304) {
      if (!conditional || !cached?.body) throw Error("PUN 304 without cached body");
      return heldBuffer(cached.body);
    }
    if (!response.ok) throw Error(`PUN HTTP ${response.status}: ${url}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (conditional)
      staged.set(key, {
        body: await holdPayload(body),
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
      });
    return body;
  };
  const first = await get(`${PUN_ROOT}manifest.json`, false);
  const manifest = punManifest(first);
  const buffers = [first];
  const urls = [`${PUN_ROOT}manifest.json`];
  for (const file of manifest.files) {
    const url = PUN_ROOT + file.key;
    const cached = state.conditional.get(`pun\0${url}`)?.body;
    let body: Buffer | undefined;
    if (cached) {
      const candidate = await heldBuffer(cached);
      if (
        candidate.length === file.size &&
        createHash("md5").update(candidate).digest("hex") === file.md5
      )
        body = candidate;
    }
    body ??= await get(url, true);
    checkPunShard(body, file);
    buffers.push(body);
    urls.push(url);
  }
  const last = await get(`${PUN_ROOT}manifest.json`, false);
  if (JSON.stringify(manifest) !== JSON.stringify(punManifest(last)))
    throw Error("PUN generation changed during acquisition");
  buffers.push(last);
  urls.push(`${PUN_ROOT}manifest.json`);
  return {
    status: "fetched",
    bodyFreshness: "acquired",
    validatedAtNetwork: true,
    partitions: { succeeded: manifest.files.length, failed: 0, total: manifest.files.length },
    buffers,
    urls,
    payloads: buffers.map((b, i) => digestPayload(urls[i]!, b)),
    accept: () => {
      for (const key of state.conditional.keys())
        if (key.startsWith("pun\0") && !staged.has(key) && !urls.includes(key.slice(4)))
          state.conditional.delete(key);
      for (const [key, value] of staged) state.conditional.set(key, value);
    },
  };
}
