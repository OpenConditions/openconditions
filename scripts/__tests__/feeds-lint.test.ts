import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintFeeds } from "../feeds-lint.js";
import { FEEDS_DIR } from "../lib/catalog-paths.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("feeds:lint", () => {
  it("finds no error in the repo catalogue", () => {
    expect(lintFeeds(FEEDS_DIR).errors).toEqual([]);
  });

  it("reports a syntax error and a lint error as errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "feeds-lint-"));
    dirs.push(dir);
    mkdirSync(join(dir, "roads"));
    writeFileSync(join(dir, "roads", "nl.jsonc"), '{ "feeds": [ }');
    expect(lintFeeds(dir).errors.join("\n")).toMatch(/nl\.jsonc:1:/);

    writeFileSync(join(dir, "roads", "nl.jsonc"), '{ "feeds": [] }');
    expect(lintFeeds(dir).errors).toEqual([
      `${join(dir, "roads", "nl.jsonc")}: $schema must be "../schema/roads.schema.json"`,
    ]);
  });
});
