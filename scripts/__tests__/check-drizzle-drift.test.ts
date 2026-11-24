import { describe, expect, it } from "vitest";
import { type DriftSteps, driftProblems } from "../check-drizzle-drift.js";

// Output shapes as drizzle-kit 0.31 prints them.
const config =
  "No config path provided, using default 'drizzle.config.ts'\nReading config file '/repo/packages/core/drizzle.config.ts'\n";
const fine = { status: 0, output: `${config}Everything's fine 🐶🔥\n` };
const tables = "source 34 columns 0 indexes 0 fks\n";
const clean: DriftSteps = {
  check: fine,
  generate: { status: 0, output: `${config}${tables}\nNo schema changes, nothing to migrate 😴\n` },
  status: { status: 0, output: "" },
};

describe("driftProblems", () => {
  it("accepts migrations that match the schema code", () => {
    expect(driftProblems(clean)).toEqual([]);
  });

  it("refuses a rename prompt drizzle-kit declined without a TTY, although it exited 0", () => {
    const problems = driftProblems({
      ...clean,
      generate: {
        status: 0,
        output: `${config}${tables}Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false). This can happen when running in CI, piped input, or non-interactive shells.\n    at render10 (bin.cjs:1450:31)\n`,
      },
    });
    expect(problems.some((p) => p.includes("Interactive prompts require a TTY"))).toBe(true);
    expect(problems.some((p) => p.includes("No schema changes, nothing to migrate"))).toBe(true);
  });

  it("refuses a new migration file", () => {
    const problems = driftProblems({
      ...clean,
      generate: {
        status: 0,
        output: `${config}${tables}[✓] Your SQL migration file ➜ drizzle/0002_famous_domino.sql 🚀\n`,
      },
      status: {
        status: 0,
        output:
          " M packages/core/drizzle/meta/_journal.json\n?? packages/core/drizzle/0002_famous_domino.sql\n?? packages/core/drizzle/meta/0002_snapshot.json\n",
      },
    });
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain("?? packages/core/drizzle/0002_famous_domino.sql");
  });

  it("refuses schema code that fails to load, although drizzle-kit exited 0", () => {
    const problems = driftProblems({
      ...clean,
      generate: {
        status: 0,
        output: `${config}Error: Cannot find module './does-not-exist.js'\nRequire stack:\n- /repo/packages/core/src/db/schema.ts\n`,
      },
    });
    expect(problems.some((p) => p.includes("Cannot find module"))).toBe(true);
  });

  it("refuses uncommitted changes in the migrations folder", () => {
    expect(
      driftProblems({
        ...clean,
        status: { status: 0, output: " M packages/core/drizzle/0001_database_objects.sql\n" },
      }),
    ).toEqual([
      "packages/core/drizzle differs from what Git holds:\n M packages/core/drizzle/0001_database_objects.sql",
    ]);
  });

  it("refuses a failing git status even without output", () => {
    expect(
      driftProblems({
        ...clean,
        status: { status: 128, output: "" },
      }),
    ).toEqual(["git status --porcelain -- packages/core/drizzle exited with 128"]);
  });

  it("refuses a drizzle-kit run that timed out or was not found", () => {
    const problems = driftProblems({
      ...clean,
      check: { status: null, error: "spawnSync pnpm ETIMEDOUT", output: "" },
    });
    expect(problems).toEqual([
      "drizzle-kit check did not run: spawnSync pnpm ETIMEDOUT",
      'drizzle-kit check did not report "Everything\'s fine"',
    ]);
  });

  it("refuses a nonzero exit and a check that did not confirm the snapshots", () => {
    const problems = driftProblems({
      ...clean,
      check: { status: 1, output: `${config}Error: snapshot collision\n` },
    });
    expect(problems).toEqual([
      "drizzle-kit check exited with 1",
      "drizzle-kit check reported: Error: snapshot collision",
      'drizzle-kit check did not report "Everything\'s fine"',
    ]);
  });
});
