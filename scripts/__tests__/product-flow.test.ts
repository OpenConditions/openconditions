import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("discovers owning identities and retains pending readiness without fabricated approval", () => {
  const p = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("test_product_flow.py", import.meta.url))],
    { encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
  );
  expect(p.status, p.stdout + p.stderr).toBe(0);
}, 185000);
it("offers only data-only prepare/review with read-only permissions and owned public tool acquisition", () => {
  const w = parse(
    readFileSync(new URL("../../.github/workflows/product-release.yml", import.meta.url), "utf8"),
  );
  expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual(["operation", "version", "notes"]);
  expect(w.on.workflow_dispatch.inputs.operation.options).toEqual(["prepare", "review"]);
  expect(w.jobs.qualify.permissions).toEqual({ contents: "read", actions: "read" });
  for (const step of w.jobs.qualify.steps) if (step.run) expect(step.run).not.toContain("${{");
  expect(JSON.stringify(w)).not.toContain("contents:write");
});
