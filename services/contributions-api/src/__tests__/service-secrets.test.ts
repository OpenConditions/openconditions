import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { resolveGrantSecret } from "../attester/grant.js";
import { resolveReviewerToken } from "../reviewer/auth.js";

/** A secret mounted the way OpenMapX mounts a vault secret: a file, named by `<KEY>_FILE`. */
function secretFile(name: string, value: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "oc-secret-")), name);
  writeFileSync(file, `${value}\n`);
  return file;
}

describe("contributions-api secrets", () => {
  test("the grant secret is read from OPENCONDITIONS_GRANT_SECRET_FILE", () => {
    const warn = vi.fn();
    const env = {
      NODE_ENV: "production",
      OPENCONDITIONS_GRANT_SECRET_FILE: secretFile("OPENCONDITIONS_GRANT_SECRET", "from-file"),
    };
    expect(new TextDecoder().decode(resolveGrantSecret(env, warn))).toBe("from-file");
    expect(warn).not.toHaveBeenCalled();
  });

  test("the reviewer token is read from OPENCONDITIONS_REVIEWER_TOKEN_FILE", () => {
    const warn = vi.fn();
    const env = {
      NODE_ENV: "production",
      OPENCONDITIONS_REVIEWER_TOKEN_FILE: secretFile("OPENCONDITIONS_REVIEWER_TOKEN", "reviewer"),
    };
    expect(resolveReviewerToken(env, warn)).toBe("reviewer");
    expect(warn).not.toHaveBeenCalled();
  });

  test("a set but unreadable secret file is reported as such, not as a missing secret", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "oc-secret-")), "absent");
    expect(() =>
      resolveGrantSecret({ OPENCONDITIONS_GRANT_SECRET_FILE: missing }, vi.fn()),
    ).toThrow(/OPENCONDITIONS_GRANT_SECRET_FILE .*ENOENT/);
    expect(() =>
      resolveReviewerToken({ OPENCONDITIONS_REVIEWER_TOKEN_FILE: missing }, vi.fn()),
    ).toThrow(/OPENCONDITIONS_REVIEWER_TOKEN_FILE .*ENOENT/);
  });
});
