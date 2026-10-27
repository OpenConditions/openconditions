import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("validates trusted-main authority through real HTTP and filesystem fixtures", () => {
  const result = spawnSync(
    "python3",
    [fileURLToPath(new URL("test_trusted_main_images.py", import.meta.url)), "-v"],
    {
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 125_000);
