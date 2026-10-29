import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { verifyRegistryMetadata } from "../tuf/verify.js";
import { buildRepo, sampleEntry } from "./tuf-fixture.js";

const owned: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), "oc-root-bootstrap-"));
  owned.push(directory);
  const registryDir = join(directory, "registry");
  fs.mkdirSync(registryDir);
  fs.writeFileSync(join(registryDir, "owned.yaml"), stringify(sampleEntry("owned")));
  const repo = await buildRepo({ registryDir, repoDir: join(directory, "repo") });
  return { directory, registryDir, repo };
}

describe("TUF root cache bootstrap", () => {
  it("preserves a verified newer root created by a competing bootstrap", async () => {
    const { directory, registryDir, repo } = await fixture();
    const newer = await buildRepo({
      registryDir,
      repoDir: join(directory, "newer"),
      keys: repo.keys,
      rootVersion: 2,
    });
    const verifiedCache = join(directory, "verified-cache");
    await verifyRegistryMetadata(newer.repoDir, repo.rootBytes, {
      cacheDir: verifiedCache,
      env: "test",
    });
    const winner = fs.readFileSync(join(verifiedCache, "root.json"));
    expect(JSON.parse(winner.toString()).signed.version).toBe(2);
    const cacheDir = join(directory, "racing-cache");
    const rootPath = join(cacheDir, "root.json");
    const write = fs.writeFileSync;
    let interleaved = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation((path, ...args) => {
      if (path === rootPath && !interleaved) {
        interleaved = true;
        // Only this boundary is scheduled: every read/write and TUF check is real.
        write(rootPath, winner, { flag: "wx" });
      }
      return write(path, ...args);
    });
    syncBuiltinESMExports();
    const entries = await verifyRegistryMetadata(repo.repoDir, repo.rootBytes, {
      cacheDir,
      env: "test",
    });
    expect(interleaved).toBe(true);
    expect(entries.map((entry) => entry.id)).toEqual(["owned"]);
    const retained = fs.readFileSync(rootPath);
    expect(JSON.parse(retained.toString()).signed.version).toBe(2);
    expect(retained).toEqual(winner);
  });

  it("does not create a target through a dangling bootstrap symlink", async () => {
    const { directory, repo } = await fixture();
    const cacheDir = join(directory, "symlink-cache");
    fs.mkdirSync(cacheDir);
    const target = join(directory, "must-remain-absent.json");
    fs.symlinkSync(target, join(cacheDir, "root.json"));
    const result = await verifyRegistryMetadata(repo.repoDir, repo.rootBytes, {
      cacheDir,
      env: "test",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(fs.existsSync(target)).toBe(false);
    expect(result).toMatchObject({ code: "ENOENT" });
    expect(fs.lstatSync(join(cacheDir, "root.json")).isSymbolicLink()).toBe(true);
  });
  it("propagates bootstrap write errors without a retry", async () => {
    const { directory, repo } = await fixture();
    const cacheDir = join(directory, "error-cache");
    const rootPath = join(cacheDir, "root.json");
    const write = fs.writeFileSync;
    const failure = Object.assign(new Error("owned fixture I/O failure"), { code: "EIO" });
    let attempts = 0;
    vi.spyOn(fs, "writeFileSync").mockImplementation((path, ...args) => {
      if (path === rootPath) {
        attempts++;
        throw failure;
      }
      return write(path, ...args);
    });
    syncBuiltinESMExports();
    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir, env: "test" }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(fs.existsSync(rootPath)).toBe(false);
  });
});
