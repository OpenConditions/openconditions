import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const checker = join(root, "scripts/check-packed-packages.mjs");
const scratch = mkdtempSync(join(tmpdir(), "oc-packed-tests-"));
const hash = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
let candidate: string;

beforeAll(() => {
  const packed = spawnSync(
    "pnpm",
    ["--dir", "packages/ocpi", "pack", "--pack-destination", scratch],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(packed.status, packed.stdout + packed.stderr).toBe(0);
  candidate = join(scratch, readdirSync(scratch).find((f) => f.endsWith(".tgz"))!);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function check(file: string, expectedHash = hash(file), args: string[] = []) {
  return spawnSync(
    process.execPath,
    [checker, "--tarball", file, "--sha256", expectedHash, ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}

/** Mutate actual packed bytes in owned scratch, then create a real USTAR archive. */
function altered(change: (dir: string) => void): string {
  const dir = mkdtempSync(join(scratch, "case-"));
  const extracted = spawnSync("tar", ["-xzf", candidate, "-C", dir]);
  expect(extracted.status).toBe(0);
  change(join(dir, "package"));
  const out = join(dir, "changed.tgz");
  const packed = spawnSync("tar", ["--format=ustar", "-czf", out, "-C", dir, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(packed.status, packed.stderr?.toString()).toBe(0);
  return out;
}

function manifest(dir: string, edit: (m: Record<string, unknown>) => void) {
  const f = join(dir, "package.json");
  const m = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
  edit(m);
  writeFileSync(f, JSON.stringify(m));
}

describe("public package boundary", () => {
  test("only OCPI is an explicitly qualified public candidate", () => {
    const packages = readdirSync(join(root, "packages")).flatMap((dir) => {
      try {
        return [
          JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) as {
            name: string;
            private?: boolean;
          },
        ];
      } catch {
        return [];
      }
    });
    expect(packages.filter((p) => p.private !== true).map((p) => p.name)).toEqual([
      "@openconditions/ocpi",
    ]);
  });

  test("supplied immutable bytes pass actual ESM/CJS and strict external TypeScript consumers", () => {
    const before = hash(candidate);
    const result = check(candidate);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      sha256: string;
      mode: string;
      consumer: string[];
    };
    expect(receipt.sha256).toBe(before);
    expect(receipt.mode).toBe("supplied");
    expect(receipt.consumer).toEqual(["esm", "cjs", "strict-types"]);
    expect(hash(candidate)).toBe(before);
  }, 150_000);

  test.each([
    [
      "private candidate",
      (d: string) =>
        manifest(d, (m) => {
          m.private = true;
        }),
      /private/,
    ],
    [
      "unknown package",
      (d: string) =>
        manifest(d, (m) => {
          m.name = "@openconditions/core";
        }),
      /not allowlisted/,
    ],
    [
      "foreign scope",
      (d: string) =>
        manifest(d, (m) => {
          m.name = "@other/ocpi";
        }),
      /not allowlisted/,
    ],
    ["missing dist", (d: string) => rmSync(join(d, "dist/index.js")), /missing packed file/],
    ["missing types", (d: string) => rmSync(join(d, "dist/index.d.cts")), /missing packed file/],
    ["missing license", (d: string) => rmSync(join(d, "LICENSE")), /missing packed file/],
    ["missing README", (d: string) => rmSync(join(d, "README.md")), /missing packed file/],
    [
      "legacy entry",
      (d: string) =>
        manifest(d, (m) => {
          m.main = "./dist/absent.cjs";
        }),
      /entry metadata/,
    ],
    [
      "unknown export",
      (d: string) =>
        manifest(d, (m) => {
          m.exports = { ".": "./dist/absent.js" };
        }),
      /exports/,
    ],
    [
      "workspace dependency",
      (d: string) =>
        manifest(d, (m) => {
          m.dependencies = { "@openconditions/core": "workspace:*" };
        }),
      /dependency/,
    ],
    [
      "file dependency",
      (d: string) =>
        manifest(d, (m) => {
          m.dependencies = { x: "file:../x" };
        }),
      /dependency/,
    ],
    [
      "unqualified public dependency",
      (d: string) =>
        manifest(d, (m) => {
          m.dependencies = { "@openconditions/core": "0.1.0" };
        }),
      /dependency/,
    ],
    [
      "helper leak",
      (d: string) =>
        writeFileSync(join(d, "dist/index.js"), 'import "@openconditions/conformance";'),
      /packed code boundary/,
    ],
    [
      "unsupported output",
      (d: string) => writeFileSync(join(d, "unexpected.txt"), "not shipped"),
      /unsupported packed output/,
    ],
  ] as const)("rejects %s through the actual command", (_name, edit, error) => {
    const result = check(altered(edit));
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(error);
  });

  test("actual packed README examples must execute successfully", () => {
    const result = check(
      altered((d) =>
        writeFileSync(
          join(d, "README.md"),
          "```js\nthrow new Error('broken shipped example');\n```\n",
        ),
      ),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/packed README example/);
  }, 150_000);

  test("actual ESM consumer rejects a missing runtime export", () => {
    const result = check(altered((d) => writeFileSync(join(d, "dist/index.js"), "export {};")));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/external esm/);
  }, 150_000);

  test("a receipt destination cannot overwrite the supplied candidate", () => {
    const dir = mkdtempSync(join(scratch, "collision-"));
    const file = join(dir, "qualification.json");
    copyFileSync(candidate, file);
    const before = hash(file);
    const result = check(file, before, ["--output", dir]);
    expect(hash(file)).toBe(before);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/EEXIST/);
  }, 150_000);

  test("rejects a wrong hash before accepting otherwise valid bytes", () => {
    const result = check(candidate, "0".repeat(64));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/hash mismatch/);
  });

  test("missing supplied bytes do not fall back to repacking", () => {
    const result = check(join(scratch, "absent.tgz"), "0".repeat(64));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ENOENT/);
  });

  test("rejects unsupported arguments instead of silently packing source", () => {
    const result = check(candidate, hash(candidate), ["--publish"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsupported argument/);
  });

  test("strict consumer rejects broken declarations even when runtime bytes work", () => {
    const result = check(
      altered((d) =>
        writeFileSync(join(d, "dist/index.d.ts"), "export declare const broken: MissingType;"),
      ),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/external strict types/);
  }, 150_000);

  test("detects original candidate changes during the real consumer install", async () => {
    const file = altered(() => {});
    const child = spawn(process.execPath, [checker, "--tarball", file, "--sha256", hash(file)], {
      cwd: root,
    });
    const deadline = setTimeout(() => child.kill(), 120_000);
    let err = "";
    let changed = false;
    child.stderr.on("data", (data: Buffer) => {
      err += data.toString();
      if (!changed && err.includes("Checking external consumer")) {
        changed = true;
        writeFileSync(file, "replaced after hash check");
      }
    });
    const exit = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
    clearTimeout(deadline);
    expect(changed).toBe(true);
    expect(exit).not.toBe(0);
    expect(err).toMatch(/candidate changed/);
  }, 150_000);
});
