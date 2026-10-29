import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChildFeed, resolveWithSnapshot } from "../catalog/resolvers.js";
import type { FetchFn } from "../catalog/types.js";

const roots: string[] = [];
const handles: FileHandle[] = [];
const live: ChildFeed[] = [
  {
    qualifier: "owned",
    name: "Owned",
    selectionState: "discovered",
    endpoints: { main: { url: "https://owned.invalid/data", cadenceSec: 60 } },
  },
];
const bytes = `${JSON.stringify(live, null, 2)}\n`;
const noNetwork: FetchFn = async () => {
  throw new Error("no provider requests allowed");
};
const parent = { endpoints: { main: { url: "https://owned.invalid/catalogue", cadenceSec: 60 } } };

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  const opened = handles.splice(0);
  try {
    for (const handle of opened)
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
  } finally {
    await Promise.allSettled(opened.map((handle) => handle.close()));
    for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "oc-snapshot-files-"));
  roots.push(root);
  const snapshot = join(root, "snapshot.json");
  const other = join(root, "owned-sentinel.txt");
  fs.writeFileSync(snapshot, `old${" ".repeat(512)}`, { mode: 0o600 });
  fs.writeFileSync(other, "OWNED-SENTINEL");
  return { root, snapshot, other };
}

const run = (snapshotPath: string) =>
  resolveWithSnapshot(
    { id: "owned-fixture", snapshotPath, snapshot: [], resolve: async () => live },
    parent,
    noNetwork,
  );

/** Schedule replacement at the old check/use or new open boundary; all I/O is real. */
function beforeOpen(snapshot: string, change: () => void) {
  const exists = fs.existsSync;
  const open = fsp.open;
  let changed = false;
  const once = () => {
    if (!changed) {
      changed = true;
      change();
    }
  };
  vi.spyOn(fs, "existsSync").mockImplementation((path) => {
    const found = exists(path);
    if (path === snapshot && found) once();
    return found;
  });
  vi.spyOn(fsp, "open").mockImplementation(async (path, ...args) => {
    if (path === snapshot) once();
    const handle = await open(path, ...args);
    if (path === snapshot) handles.push(handle);
    return handle;
  });
  syncBuiltinESMExports();
  return () => changed;
}

describe("catalogue snapshot file boundaries", () => {
  it("rewrites and shortens the ordinary snapshot without changing its mode or live children", async () => {
    const { snapshot } = fixture();
    const mode = fs.statSync(snapshot).mode & 0o777;
    beforeOpen(snapshot, () => {});
    expect(await run(snapshot)).toBe(live);
    expect(fs.readFileSync(snapshot, "utf8")).toBe(bytes);
    expect(fs.statSync(snapshot).mode & 0o777).toBe(mode);
    expect(handles).toHaveLength(1);
  });

  it("leaves a missing snapshot absent and quiet", async () => {
    const { snapshot } = fixture();
    fs.unlinkSync(snapshot);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(snapshot)).toBe(live);
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not rewrite an existing leaf symlink target", async () => {
    const { snapshot, other } = fixture();
    fs.unlinkSync(snapshot);
    fs.symlinkSync(other, snapshot);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(snapshot)).toBe(live);
    expect(fs.readFileSync(other, "utf8")).toBe("OWNED-SENTINEL");
    expect(fs.lstatSync(snapshot).isSymbolicLink()).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not rewrite another file swapped in as a symlink before open", async () => {
    const { snapshot, other } = fixture();
    const changed = beforeOpen(snapshot, () => {
      fs.unlinkSync(snapshot);
      fs.symlinkSync(other, snapshot);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(snapshot)).toBe(live);
    expect(changed()).toBe(true);
    expect(fs.readFileSync(other, "utf8")).toBe("OWNED-SENTINEL");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not recreate a snapshot removed before open", async () => {
    const { snapshot } = fixture();
    const changed = beforeOpen(snapshot, () => fs.unlinkSync(snapshot));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(snapshot)).toBe(live);
    expect(changed()).toBe(true);
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not overwrite a different regular file substituted before open", async () => {
    const { root, snapshot, other } = fixture();
    const changed = beforeOpen(snapshot, () => {
      fs.renameSync(snapshot, join(root, "original.json"));
      fs.renameSync(other, snapshot);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(snapshot)).toBe(live);
    expect(changed()).toBe(true);
    expect(fs.readFileSync(snapshot, "utf8")).toBe("OWNED-SENTINEL");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps a later pathname replacement untouched while updating the opened snapshot inode", async () => {
    const { root, snapshot, other } = fixture();
    const original = join(root, "opened.json");
    let changed = false;
    const change = () => {
      changed = true;
      fs.renameSync(snapshot, original);
      fs.symlinkSync(other, snapshot);
    };
    const open = fsp.open;
    const write = fsp.writeFile;
    vi.spyOn(fsp, "writeFile").mockImplementation(async (path, ...args) => {
      if (path === snapshot && !changed) change();
      return write(path, ...args);
    });
    vi.spyOn(fsp, "open").mockImplementation(async (path, ...args) => {
      const handle = await open(path, ...args);
      if (path === snapshot) {
        handles.push(handle);
        if (!changed) change();
      }
      return handle;
    });
    syncBuiltinESMExports();
    expect(await run(snapshot)).toBe(live);
    expect(changed).toBe(true);
    expect(fs.readFileSync(other, "utf8")).toBe("OWNED-SENTINEL");
    expect(fs.readFileSync(original, "utf8")).toBe(bytes);
  });
  it("rejects a non-regular snapshot without changing it", async () => {
    const { snapshot } = fixture();
    fs.unlinkSync(snapshot);
    fs.mkdirSync(snapshot);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(snapshot)).toBe(live);
    expect(fs.statSync(snapshot).isDirectory()).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each(["writeFile", "truncate"] as const)(
    "closes the checked handle after a %s error and keeps live children",
    async (stage) => {
      const { snapshot } = fixture();
      const open = fsp.open;
      const failure = new Error("owned fixture I/O failure");
      let attempts = 0;
      vi.spyOn(fsp, "open").mockImplementation(async (path, ...args) => {
        const handle = await open(path, ...args);
        if (path === snapshot) {
          handles.push(handle);
          vi.spyOn(handle, stage).mockImplementation(async () => {
            attempts++;
            throw failure;
          });
        }
        return handle;
      });
      syncBuiltinESMExports();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await run(snapshot)).toBe(live);
      expect(handles).toHaveLength(1);
      expect(attempts).toBe(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![1]).toBe(failure.message);
    },
  );
});
