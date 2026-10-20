import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

/**
 * Official schemas are fetched at test time rather than vendored: several
 * standards bodies publish them without any licence or redistribution terms,
 * so this repository does not copy them. Each file is pinned by its SHA-256, so
 * a changed upstream file fails the check instead of silently moving the
 * schema the code is held to. A file found in the cache with its pinned
 * checksum is not downloaded again.
 */

/** One schema file served at its own URL. */
export interface PinnedFile {
  /** The name the file is known by: an `xs:include`/`xs:import` or `$ref` names it so. */
  name: string;
  url: string;
  sha256: string;
}

/** Schema files taken from a zip archive, pinned by member so a repack does not matter. */
export interface PinnedArchive {
  url: string;
  /** SHA-256 per member path inside the archive. */
  members: Readonly<Record<string, string>>;
  /** The names the members are known by, where a member's path is not its name. */
  rename?: Readonly<Record<string, string>>;
}

/** A standard's schema set, cached under its `id`. */
export interface PinnedSet {
  /** A cache directory name: a standard and version, such as `datex2-v3.7`. */
  id: string;
  files?: readonly PinnedFile[];
  archives?: readonly PinnedArchive[];
}

/** A fetched schema file, as text. */
export interface SchemaFile {
  fileName: string;
  contents: string;
}

const CACHE_ROOT = fileURLToPath(
  new URL("../../../node_modules/.cache/conformance/", import.meta.url),
);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Answers worth asking again for: the host was busy or briefly failing. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * A file's bytes. The Internet Archive, which serves several pins, answers
 * an occasional request with a 502 or drops the connection, so a transient
 * failure is tried twice more before it fails the check.
 */
export async function download(url: string, attempts = 3): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let failure: unknown;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "OpenConditions schema check" },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      failure = error;
    }
    if (res !== undefined && !res.ok) {
      failure = new Error(`${url}: HTTP ${res.status}`);
      if (!TRANSIENT_STATUSES.has(res.status)) throw failure;
    }
    if (attempt >= attempts) throw failure;
    await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
  }
}

/** The stored or deflated members of a zip archive, by path. */
export function unzip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip archive");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    out.set(name, method === 0 ? data : new Uint8Array(inflateRawSync(data)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** A cache file name for a schema name, which may hold path separators. */
const cacheName = (name: string) => name.replaceAll("/", "__");

async function cached(dir: string, name: string, sha: string): Promise<Uint8Array | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(join(dir, cacheName(name))));
    return sha256(bytes) === sha ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function store(dir: string, name: string, bytes: Uint8Array, sha: string): Promise<void> {
  const actual = sha256(bytes);
  if (actual !== sha) {
    throw new Error(`${name}: SHA-256 ${actual}, pinned ${sha}; the upstream schema changed`);
  }
  const tmp = join(dir, `${cacheName(name)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, bytes);
  await rename(tmp, join(dir, cacheName(name)));
}

/**
 * A pinned set's files by name, from the cache or downloaded into it. Throws
 * when a file cannot be fetched or does not match its checksum.
 */
export async function pinnedBytes(set: PinnedSet): Promise<Map<string, Uint8Array>> {
  const dir = join(CACHE_ROOT, set.id);
  await mkdir(dir, { recursive: true });
  const out = new Map<string, Uint8Array>();
  for (const file of set.files ?? []) {
    let bytes = await cached(dir, file.name, file.sha256);
    if (!bytes) {
      bytes = await download(file.url);
      await store(dir, file.name, bytes, file.sha256);
    }
    out.set(file.name, bytes);
  }
  for (const archive of set.archives ?? []) {
    const nameOf = (member: string) => archive.rename?.[member] ?? member;
    const found = await Promise.all(
      Object.entries(archive.members).map(
        async ([member, sha]) => [member, await cached(dir, nameOf(member), sha)] as const,
      ),
    );
    if (found.every(([, bytes]) => bytes)) {
      for (const [member, bytes] of found) out.set(nameOf(member), bytes!);
      continue;
    }
    const members = unzip(await download(archive.url));
    for (const [member, sha] of Object.entries(archive.members)) {
      const bytes = members.get(member);
      if (!bytes) throw new Error(`${archive.url} has no ${member}`);
      await store(dir, nameOf(member), bytes, sha);
      out.set(nameOf(member), bytes);
    }
  }
  return out;
}

/** A pinned set's files as text, in the order the set lists them. */
export async function pinnedFiles(set: PinnedSet): Promise<SchemaFile[]> {
  const decoder = new TextDecoder();
  return [...(await pinnedBytes(set))].map(([fileName, bytes]) => ({
    fileName,
    contents: decoder.decode(bytes),
  }));
}

/**
 * A pinned set's files, or why they could not be had. CI always runs the
 * schema checks, so there a failure throws; an offline local run gets the
 * reason, to skip the checks with.
 */
export async function pinnedOrUnavailable(
  set: PinnedSet,
): Promise<{ files: SchemaFile[] } | { unavailable: string }> {
  try {
    return { files: await pinnedFiles(set) };
  } catch (error) {
    if (process.env["CI"]) throw error;
    return {
      unavailable: `${set.id} schemas unavailable (${(error as Error).message}); run once online to cache them`,
    };
  }
}

/** One pinned file of a set, parsed as JSON. */
export async function pinnedJson<T = unknown>(set: PinnedSet, name: string): Promise<T> {
  const file = (await pinnedFiles(set)).find((f) => f.fileName === name);
  if (!file) throw new Error(`${set.id} pins no ${name}`);
  return JSON.parse(file.contents) as T;
}
