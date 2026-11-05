import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("qualifies only read-only A/B authorities through actual HTTP, archives, Git, Node and BuildKit", () => {
  const r = spawnSync(
    "python3",
    [fileURLToPath(new URL("test_product_qualification.py", import.meta.url))],
    { encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  expect(r.status, r.stdout + r.stderr).toBe(0);
}, 245000);
it("retires tag publisher and confines manual qualification to trusted main read-only tooling", () => {
  const root = new URL("../../", import.meta.url);
  expect(existsSync(new URL(".github/workflows/release.yml", root))).toBe(false);
  const raw = readFileSync(new URL(".github/workflows/product-release.yml", root), "utf8"),
    w = parse(raw);
  expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual(["operation", "version", "notes"]);
  expect(w.permissions).toEqual({ contents: "read" });
  expect(w.concurrency).toEqual({ group: "product-release", "cancel-in-progress": false });
  expect(Object.keys(w.jobs)).toEqual(["qualify", "preparation-pr"]);
  expect(w.jobs.qualify.permissions).toEqual({ contents: "read", actions: "read" });
  expect(w.jobs.qualify.if).toContain("github.workflow_sha == github.sha");
  expect(w.jobs.qualify.if).toContain("github.repository_id == '1276024943'");
  expect(JSON.stringify(w.jobs.qualify)).not.toMatch(
    /packages:|contents: write|pull-requests:|id-token:|push:|gh release|workflow_run|secrets\.(?!GITHUB_TOKEN)/,
  );
  const checkout = w.jobs.qualify.steps[0];
  expect(checkout.with).toMatchObject({
    ref: `\${{ github.sha }}`,
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  for (const step of w.jobs.qualify.steps) if (step.run) expect(step.run).not.toContain("${{");
});
