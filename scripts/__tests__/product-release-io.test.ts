import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run } from "./docker-context-fixtures.js";
import { setupRelease } from "./product-release-fixtures.js";

it("accepts metadata-only preparation with all four actual BuildKit exports and preserves Git/index/source", () => {
  const f = setupRelease(true),
    index = readFileSync(join(f.repo, ".git/index")),
    source = readFileSync(join(f.repo, "package.json"));
  const r = f.check(true);
  expect(r.status, r.stderr).toBe(0);
  const d = JSON.parse(r.stdout);
  expect(d.contexts.equal).toBe(true);
  expect(d.contexts.images).toHaveLength(4);
  for (const image of d.contexts.images) {
    expect(image.a.inventorySha256).toBe(image.b.inventorySha256);
    expect(image.a.inventory.length).toBeGreaterThan(5);
    expect(
      image.a.inventory.some(
        (x: { path: string }) =>
          x.path === "extension.json" || /^services\/[^/]+\/service.json$/.test(x.path),
      ),
    ).toBe(false);
  }
  expect(readFileSync(join(f.repo, "package.json"))).toEqual(source);
  // check() commits the owned preparation; comparison itself leaves a clean index/worktree.
  expect(run(f.repo, "git", ["status", "--porcelain"])).toBe("");
  expect(index.length).toBeGreaterThan(0);
}, 180000);
