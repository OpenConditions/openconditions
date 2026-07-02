import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import type { z } from "zod";

/**
 * Load every `*.json5` array file in `dir`, validate each element against
 * `schema`, and return the flattened, typed feed list. Synchronous so it can
 * initialize a module-level `const` without top-level await. Aggregates every
 * validation failure into one error (file name + element index + zod issue
 * path) so a contributor sees all problems at once instead of one-per-run.
 */
export function loadFeedFiles<T>(dir: string, schema: z.ZodType<T>): T[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json5"))
    .sort();

  const out: T[] = [];
  const errors: string[] = [];

  for (const file of files) {
    let data: unknown;
    try {
      data = JSON5.parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      errors.push(`${file}: not valid JSON5 — ${(err as Error).message}`);
      continue;
    }
    if (!Array.isArray(data)) {
      errors.push(`${file}: top-level value must be an array of feeds`);
      continue;
    }
    data.forEach((row, i) => {
      const res = schema.safeParse(row);
      if (res.success) {
        out.push(res.data);
        return;
      }
      for (const issue of res.error.issues) {
        const path = issue.path.length ? issue.path.join(".") : "(root)";
        errors.push(`${file}[${i}]: ${path} — ${issue.message}`);
      }
    });
  }

  if (errors.length > 0) {
    throw new Error(`Invalid feed data file(s):\n  ${errors.join("\n  ")}`);
  }
  return out;
}
