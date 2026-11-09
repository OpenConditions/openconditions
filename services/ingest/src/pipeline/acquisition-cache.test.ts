import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetchState } from "@openconditions/ingest-framework";
import { expect, test } from "vitest";
import { loadAcquisitionCache, saveAcquisitionCache } from "./acquisition-cache.js";
import { createRoleState } from "./run.js";

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
