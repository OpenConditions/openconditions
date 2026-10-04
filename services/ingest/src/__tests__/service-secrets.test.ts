import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { operatorTokenFromEnv } from "../api/scope.js";

/** A secret mounted the way OpenMapX mounts a vault secret: a file, named by `<KEY>_FILE`. */
function secretFile(name: string, value: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "oc-secret-")), name);
  writeFileSync(file, `${value}\n`);
  return file;
}

describe("ingest service secrets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("the database URL is read from DATABASE_URL_FILE", async () => {
    const url = "postgresql://postgres:pw@postgis:5432/openmapx";
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL_FILE", secretFile("DATABASE_URL", url));
    vi.resetModules();
    const db = await import("../db.js");
    expect(db.DATABASE_URL).toBe(url);
    await db.sql.end();
  });

  test("the operator token is read from OPENCONDITIONS_OPERATOR_TOKEN_FILE", () => {
    const token = "t".repeat(40);
    const env = {
      OPENCONDITIONS_OPERATOR_TOKEN_FILE: secretFile("OPENCONDITIONS_OPERATOR_TOKEN", token),
    };
    expect(operatorTokenFromEnv(env)).toBe(token);
  });

  test("an unreadable operator token file fails boot instead of falling back to public scope", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "oc-secret-")), "absent");
    expect(() => operatorTokenFromEnv({ OPENCONDITIONS_OPERATOR_TOKEN_FILE: missing })).toThrow(
      /OPENCONDITIONS_OPERATOR_TOKEN_FILE .*ENOENT/,
    );
  });

  test("a short operator token from the file still fails boot", () => {
    const env = {
      OPENCONDITIONS_OPERATOR_TOKEN_FILE: secretFile("OPENCONDITIONS_OPERATOR_TOKEN", "short"),
    };
    expect(() => operatorTokenFromEnv(env)).toThrow(/at least 32 characters/);
  });
});
