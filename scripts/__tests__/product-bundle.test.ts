import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("checks owned bundle integrity and readiness claims without conferring operational authority", () => {
  const r = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("test_product_bundle.py", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  expect(r.status, r.stdout + r.stderr).toBe(0);
}, 245000);
