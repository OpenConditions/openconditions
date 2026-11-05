import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("discovers owning identities and gives a simple explicit publication action", () => {
  const p = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("test_product_flow.py", import.meta.url))],
    { encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
  );
  expect(p.status, p.stdout + p.stderr).toBe(0);
}, 185000);
it("keeps prepare/review validation read-only and inputs data-only and owned public tool acquisition", () => {
  const w = parse(
    readFileSync(new URL("../../.github/workflows/product-release.yml", import.meta.url), "utf8"),
  );
  expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual(["operation", "version", "notes"]);
  expect(w.on.workflow_dispatch.inputs.operation.options).toEqual(["prepare", "review", "publish"]);
  expect(w.jobs.qualify.permissions).toEqual({ contents: "read", actions: "read" });
  for (const step of w.jobs.qualify.steps) if (step.run) expect(step.run).not.toContain("${{");
  expect(Object.keys(w.jobs)).toEqual(["qualify", "publication", "preparation-pr"]);
  expect(w.jobs.publication.environment).toBe("product-release");
  expect(w.jobs.publication.permissions).toEqual({
    contents: "write",
    packages: "write",
    actions: "read",
  });
  expect(w.jobs.publication.if).toContain("inputs.operation == 'publish'");
});

it("executes owned PostgreSQL recovery and native rehearsal refusal controls", () => {
  const p = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("test_product_rehearsal.py", import.meta.url))],
    { encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  expect(p.status, p.stdout + p.stderr).toBe(0);
}, 245000);

it("publishes exact bytes through owned HTTP/Git/OCI and stops conflicts", () => {
  const p = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("test_product_publication.py", import.meta.url))],
    { encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  expect(p.status, p.stdout + p.stderr).toBe(0);
}, 245000);
