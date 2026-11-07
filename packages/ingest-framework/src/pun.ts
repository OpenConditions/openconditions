import { createHash } from "node:crypto";
import { z } from "zod";
import type { FetchFn } from "./catalog/types.js";
import type { FetchResult, FetchState } from "./fetch.js";
import { heldBuffer, holdPayload } from "./held.js";
import { digestPayload } from "./payload.js";

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

// One queue for every fetchEndpoint caller on this host, across feeds and fetch states.
// Processes sharing an egress IP must use a single acquiring worker (see qualification notes).
let turn = Promise.resolve();
let next = 0;
async function pause(ms: number) {
  const until = Date.now() + Math.max(0, ms);
  while (Date.now() < until) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(60000, until - Date.now())));
  }
}
async function boundedBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw Error("PUN response exceeds byte budget");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
  return Buffer.concat(chunks);
}
/** Serialize through response consumption, so the budget covers open connections too. */
export function punHostFetch(base: FetchFn): FetchFn {
  return (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname !== "cruscotto-italia.dati.gov.it") return base(input, init);
    const job = turn.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await pause(next - Date.now());
        next = Date.now() + 1000;
        const response = await base(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            "User-Agent":
              "OpenConditions-PUN/1.0 (+https://github.com/OpenConditions/openconditions)",
          },
        });
        const body = await boundedBody(
          response,
          url.endsWith("manifest.json") ? MAX_MANIFEST : MAX_SHARD,
        );
        if (response.status === 429) {
          const retry = response.headers.get("retry-after");
          const seconds = Number(retry);
          const deadline =
            retry && Number.isFinite(seconds)
              ? Date.now() + Math.max(0, seconds) * 1000
              : Date.parse(retry ?? "");
          next = Math.max(
            next,
            Number.isFinite(deadline) ? deadline : Date.now() + 60000 * 2 ** attempt,
          );
          if (attempt === 2) throw Error("PUN rate limited; retry a later poll");
          continue;
        }
        return new Response([204, 205, 304].includes(response.status) ? null : body, {
          status: response.status,
          headers: response.headers,
        });
      }
      throw Error("PUN retry budget exhausted");
    });
    turn = job.then(
      () => {},
      () => {},
    );
    return job;
  }) as FetchFn;
}

/** An atomic acquisition: no validators or body cache are committed before publication. */
export async function acquirePun(base: FetchFn, state: FetchState): Promise<FetchResult> {
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
    const response = await base(url, { headers });
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
    const body = await get(url, true);
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
