import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("creates only exact preparation Git/PR payloads, reuses identical retries and stops conflicts/drift", () => {
  const p = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("test_preparation_pr.py", import.meta.url))],
    { encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  expect(p.status, p.stdout + p.stderr).toBe(0);
}, 245000);
it("grants write permissions only to successful trusted-main preparation PR creation", () => {
  const w = parse(
    readFileSync(new URL("../../.github/workflows/product-release.yml", import.meta.url), "utf8"),
  );
  expect(w.jobs.qualify.permissions).toEqual({ contents: "read", actions: "read" });
  expect(w.jobs["preparation-pr"].permissions).toEqual({
    contents: "write",
    "pull-requests": "write",
    actions: "read",
  });
  expect(w.jobs["preparation-pr"].if).toContain("inputs.operation == 'prepare'");
  expect(w.jobs["preparation-pr"].if).toContain("needs.qualify.result == 'success'");
  expect(w.jobs["preparation-pr"].if).toContain("github.workflow_sha == github.sha");
  expect(JSON.stringify(w)).not.toContain("id-token");
});
