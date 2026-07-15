import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The write-normalization seam was extracted into @openconditions/normalize to
// remove a service→service import: contributions-api must never again reach into
// the ingest service for normalizeObservation/resolveInstanceId/WriterContext.
// (contributions-api still legitimately imports ./pipeline/write-postgis — the
// content-hash toRow — from @openconditions/ingest; only the normalize seam
// moved.) These guards keep the boundary from silently regressing.

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("contributions-api normalize import boundary", () => {
  const files = walk(SRC);

  it("no source file imports the normalize seam from @openconditions/ingest", () => {
    const offenders = files.filter((file) =>
      readFileSync(file, "utf8").includes("@openconditions/ingest/pipeline/normalize")
    );
    expect(
      offenders,
      `normalize now lives in @openconditions/normalize:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the write-normalization symbols come from @openconditions/normalize", () => {
    const importers = files.filter((file) =>
      /from ["']@openconditions\/normalize["']/.test(readFileSync(file, "utf8"))
    );
    expect(importers.length).toBeGreaterThan(0);
  });
});
