import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deserialize, serialize } from "node:v8";
import { createFetchState, type FetchState } from "@openconditions/ingest-framework";
import type { RoleState } from "./run.js";

const MAX_BYTES = 32 * 1024 * 1024;
/** Disposable local cache: publication authority remains in PostgreSQL. */
export async function loadAcquisitionCache(path: string, config: string) {
  try {
    const info = await stat(path);
    if (info.size > MAX_BYTES || Date.now() - info.mtimeMs > 86400_000) return undefined;
    const value = deserialize(await readFile(path));
    if (
      value.version !== 1 ||
      value.config !== config ||
      !(value.conditional instanceof Map) ||
      !value.roles?.items
    )
      return undefined;
    const state = createFetchState();
    state.conditional = value.conditional;
    state.sourceConfig = value.sourceConfig;
    return { roles: value.roles as RoleState, state };
  } catch {
    return undefined;
  }
}
export async function saveAcquisitionCache(
  path: string,
  config: string,
  roles: RoleState,
  state: FetchState,
) {
  const bytes = serialize({
    version: 1,
    config,
    roles,
    conditional: state.conditional,
    sourceConfig: state.sourceConfig,
  });
  if (bytes.length > MAX_BYTES) throw new Error("acquisition cache size budget exceeded");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}
