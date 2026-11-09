import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetchState } from "@openconditions/ingest-framework";
import { expect, test, vi } from "vitest";
import { loadAcquisitionCache, saveAcquisitionCache } from "./acquisition-cache.js";
import { createRoleState } from "./run.js";

const race = vi.hoisted(() => ({ afterStat: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const result = await fs.stat(...args);
      await race.afterStat?.();
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
        const result = await stat(...args);
        await race.afterStat?.();
        return result;
      }) as typeof handle.stat;
      return handle;
    },
  };
});

test("refuses a cache that grows after its size check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-cache-growth-"));
  const path = join(dir, "cache");
  try {
    await saveAcquisitionCache(path, "config", createRoleState(), createFetchState());
    const file = await open(path, "r");
    try {
      expect(typeof (await file.stat({ bigint: true })).size).toBe("bigint");
      expect(typeof (await file.stat()).size).toBe("number");
    } finally {
      await file.close();
    }
    race.afterStat = () => appendFile(path, Buffer.from([0]));
    expect(await loadAcquisitionCache(path, "config")).toBeUndefined();
  } finally {
    race.afterStat = undefined;
    await rm(dir, { recursive: true });
  }
});

test("restart restores exact buffers, item clocks and validators, but not pacing queues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-dwd-cache-"));
  try {
    const path = join(dir, "cache");
    const roles = createRoleState();
    const state = createFetchState();
    roles.items.tu = new Map([
      [
        "https://example.org/a",
        { at: 10, version: "v1", body: { data: Buffer.from("zip"), gzipped: false, bytes: 3 } },
      ],
    ]);
    state.conditional.set("key", { etag: "v1" });
    await saveAcquisitionCache(path, "config", roles, state);
    const restored = await loadAcquisitionCache(path, "config");
    expect(restored?.roles).toEqual(roles);
    expect(restored?.state.conditional).toEqual(state.conditional);
    expect(restored?.state.pacers.size).toBe(0);
    expect(await loadAcquisitionCache(path, "changed")).toBeUndefined();
    await writeFile(path, "interrupted");
    expect(await loadAcquisitionCache(path, "config")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true });
  }
});
