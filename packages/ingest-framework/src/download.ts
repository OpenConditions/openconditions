import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetch as undiciFetch } from "undici";
import { guardOptionsFromEnv, guardedFetch } from "./egress.js";

const GB = 1024 * 1024 * 1024;

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The URL's last path segment when it's a plain filename (letters, digits,
 * `.`, `-`, `_`), else `"artifact"`. Keeps the extension (osmium infers format
 * from it) while refusing anything that could escape the temp dir.
 */
function safeBasename(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").pop();
    if (name && /^[\w.-]+$/.test(name)) return name;
  } catch {
    // fall through
  }
  return "artifact";
}

export interface DownloadArtifactDeps {
  /**
   * Test seam: the guarded fetch to use. Production omits it and gets a
   * `guardedFetch` built from `guardOptionsFromEnv()` with a raised byte ceiling
   * (so the shared 512MB feed cap is never touched) — reusing the SSRF address
   * validation, per-redirect re-check, and connection pinning.
   */
  fetchImpl?: typeof fetch;
  /** Max streamed bytes. Default `OPENCONDITIONS_DOWNLOAD_MAX_BYTES` or 8GB. */
  maxBytes?: number;
  /** Overall download timeout (ms). Default `OPENCONDITIONS_DOWNLOAD_TIMEOUT_MS` or 30 min. */
  timeoutMs?: number;
  /** Parent dir for the per-download temp dir. Default `os.tmpdir()`. */
  tmpDir?: string;
  /** Env for the defaults. Test seam; production uses `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface DownloadedArtifact {
  /** Absolute path of the downloaded file (inside a fresh temp dir). */
  path: string;
  /** The temp dir to `rm -rf` when done — the caller owns cleanup. */
  dir: string;
  bytes: number;
  md5: string;
}

/**
 * Streams a large trusted artifact (e.g. a Geofabrik `.osm.pbf`) to a temp file.
 * Reuses the SSRF egress guard via `guardedFetch` with a dedicated raised ceiling
 * (never the shared feed cap), hashes while streaming, and — when a `<url>.md5`
 * sidecar exists — verifies it as a truncation defense (mismatch throws; a
 * missing/unreachable sidecar is skipped, not fatal). On any failure the temp dir
 * is removed and the error rethrown; on success the caller must `rm` `dir`.
 */
export async function downloadLargeArtifact(
  url: string,
  deps: DownloadArtifactDeps = {}
): Promise<DownloadedArtifact> {
  const env = deps.env ?? process.env;
  const maxBytes = deps.maxBytes ?? envInt(env, "OPENCONDITIONS_DOWNLOAD_MAX_BYTES", 8 * GB);
  const timeoutMs =
    deps.timeoutMs ?? envInt(env, "OPENCONDITIONS_DOWNLOAD_TIMEOUT_MS", 30 * 60_000);
  const fetchImpl =
    deps.fetchImpl ??
    guardedFetch(undiciFetch as unknown as typeof fetch, { ...guardOptionsFromEnv(env), maxBytes });

  const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "oc-artifact-"));
  // Preserve the URL's basename so downstream tools that infer format from the
  // filename (osmium reads `.osm.pbf`) work; fall back to a safe generic name.
  const path = join(dir, safeBasename(url));

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`download timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  const hash = createHash("md5");
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`download failed for ${url}: HTTP ${res.status}`);
    if (!res.body) throw new Error(`download for ${url} returned no body`);
    const hasher = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      hasher,
      createWriteStream(path),
      { signal: controller.signal }
    );
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const md5 = hash.digest("hex");
  const bytes = (await stat(path)).size;

  try {
    await verifyMd5Sidecar(url, md5, fetchImpl);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { path, dir, bytes, md5 };
}

/**
 * Fetches `<url>.md5` (small, via the same guarded fetch) and compares. Geofabrik
 * sidecars are `"<hexmd5>  <filename>"`. A 404/unreachable sidecar is treated as
 * "no integrity source available" and skipped; a present-but-mismatched digest
 * throws (the downloaded file is truncated/corrupt).
 */
async function verifyMd5Sidecar(
  url: string,
  actualMd5: string,
  fetchImpl: typeof fetch
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`${url}.md5`);
  } catch {
    return; // sidecar unreachable — nothing to verify against
  }
  if (res.status === 404) return;
  if (!res.ok) return;
  const body = (await res.text()).trim();
  const expected = body.split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[0-9a-f]{32}$/.test(expected)) return; // not a usable digest
  if (expected !== actualMd5.toLowerCase()) {
    throw new Error(`md5 mismatch for ${url}: expected ${expected}, got ${actualMd5} (truncated?)`);
  }
}
