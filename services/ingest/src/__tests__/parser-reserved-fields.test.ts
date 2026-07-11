import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Trust-boundary guard: the commons federation/privacy fields are set in exactly
 * ONE place (normalizeObservation). A parser that assigns one of them — directly
 * or via an object literal — would smuggle authority past the seam, so this test
 * scans every parser/catalog source under packages/roads/src and fails if any of
 * them names a reserved field on the left of a `:` or `=`.
 */
const RESERVED = [
  "instanceId",
  "canonicalId",
  "phenomenonFingerprint",
  "privacyClass",
  "kAnonymity",
  "dpEpsilon",
  "dpDelta",
] as const;

const FIELDS = RESERVED.join("|");
// Catches both dot/bare-identifier assignments (`obs.privacyClass =`,
// `privacyClass:`) and bracket-notation string literals (`obs["privacyClass"] =`,
// `["privacyClass"]:`) so a parser cannot smuggle a reserved field past the seam
// through computed access.
const RESERVED_ASSIGNMENT = new RegExp(
  `(?:\\b(?:${FIELDS})\\s*[:=])|(?:\\[\\s*["'](?:${FIELDS})["']\\s*\\]\\s*[:=])`
);

const ROADS_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/roads/src"
);

/**
 * Only test files may legitimately name a reserved field. model.ts/types.ts are
 * NOT exempt: the roads model reuses core's Observation type and declares none of
 * these fields, so it must stay clean too — the seam (normalizeObservation) is the
 * one writer.
 */
function isAllowlisted(path: string): boolean {
  return path.includes("__tests__") || path.includes(".test.");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("parsers never assign commons provenance fields", () => {
  it("no packages/roads/src parser names a reserved field on an assignment/literal", () => {
    const offenders: string[] = [];
    for (const file of walk(ROADS_SRC)) {
      if (isAllowlisted(file)) continue;
      const src = readFileSync(file, "utf8");
      src.split(/\r?\n/).forEach((line, i) => {
        if (RESERVED_ASSIGNMENT.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `A parser assigns a reserved commons field. These are set centrally in ` +
        `normalizeObservation (see services/ingest/src/pipeline/normalize.ts), never by a parser:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });
});
