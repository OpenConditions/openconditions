import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEMA_WAIT_TIMEOUT_MS,
  expectedSchemaVersion,
  schemaWaitTimeoutMs,
} from "../db/schema-version.js";

const folder = fileURLToPath(new URL("../../drizzle/", import.meta.url));

describe("expectedSchemaVersion", () => {
  it("is the last journal entry's tag and time", () => {
    const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const last = journal.entries.at(-1)!;
    expect(expectedSchemaVersion(folder)).toEqual({ tag: last.tag, when: last.when });
  });

  it("refuses a folder without a journal", () => {
    expect(() => expectedSchemaVersion(fileURLToPath(new URL(".", import.meta.url)))).toThrow(
      /ENOENT/,
    );
  });
});

describe("schemaWaitTimeoutMs", () => {
  const variable = "OPENCONDITIONS_SCHEMA_WAIT_TIMEOUT_MS";

  it("defaults to five minutes when unset or empty", () => {
    expect(DEFAULT_SCHEMA_WAIT_TIMEOUT_MS).toBe(300_000);
    expect(schemaWaitTimeoutMs({}, variable)).toBe(300_000);
    expect(schemaWaitTimeoutMs({ [variable]: "" }, variable)).toBe(300_000);
    expect(schemaWaitTimeoutMs({ [variable]: "  " }, variable)).toBe(300_000);
  });

  it("takes a whole number of milliseconds", () => {
    expect(schemaWaitTimeoutMs({ [variable]: "900000" }, variable)).toBe(900_000);
    expect(schemaWaitTimeoutMs({ [variable]: " 1 " }, variable)).toBe(1);
  });

  it.each(["0", "-5", "1.5", "5m", "1e6", "Infinity"])("refuses %j", (raw) => {
    expect(() => schemaWaitTimeoutMs({ [variable]: raw }, variable)).toThrow(
      `${variable} must be a whole number of milliseconds above 0, got "${raw}"`,
    );
  });
});
