import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** What one command of the gate did: its exit, any failure to run it, and its combined output. */
export interface StepResult {
  status: number | null;
  error?: string;
  output: string;
}

export interface DriftSteps {
  check: StepResult;
  generate: StepResult;
  status: StepResult;
}

const MIGRATIONS = "packages/core/drizzle";
const TIMEOUT_MS = 120_000;

/**
 * Why the migrations do not match the schema code, or nothing when they do.
 * drizzle-kit exits 0 when it refuses a prompt (it has no TTY in CI) and when
 * the schema code fails to load, writing nothing either way, so its exit code
 * and an unchanged folder alone prove nothing: it must also say so.
 */
export function driftProblems(steps: DriftSteps): string[] {
  const problems: string[] = [];
  const named = [
    ["drizzle-kit check", steps.check],
    ["drizzle-kit generate", steps.generate],
    [`git status --porcelain -- ${MIGRATIONS}`, steps.status],
  ] as const;
  for (const [name, step] of named) {
    if (step.error) problems.push(`${name} did not run: ${step.error}`);
    else if (step.status !== 0) problems.push(`${name} exited with ${step.status ?? "a signal"}`);
  }
  for (const [name, step] of named.slice(0, 2)) {
    for (const line of step.output.split("\n")) {
      if (/\bError\b|TTY/.test(line)) problems.push(`${name} reported: ${line.trim()}`);
    }
  }
  if (!steps.check.output.includes("Everything's fine")) {
    problems.push('drizzle-kit check did not report "Everything\'s fine"');
  }
  if (!steps.generate.output.includes("No schema changes, nothing to migrate")) {
    problems.push('drizzle-kit generate did not report "No schema changes, nothing to migrate"');
  }
  const changed = steps.status.output.split("\n").filter((line) => line.trim() !== "");
  if (changed.length > 0) {
    problems.push(`${MIGRATIONS} differs from what Git holds:\n${changed.join("\n")}`);
  }
  return problems;
}

function run(command: string, args: string[], cwd: string): StepResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const error = result.error ? result.error.message : undefined;
  return error === undefined
    ? { status: result.status, output }
    : { status: result.status, error, output };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const core = fileURLToPath(new URL("../packages/core/", import.meta.url));
  const check = run("pnpm", ["exec", "drizzle-kit", "check"], core);
  const generate = run("pnpm", ["exec", "drizzle-kit", "generate"], core);
  const status = run("git", ["status", "--porcelain", "--", MIGRATIONS], root);
  const problems = driftProblems({ check, generate, status });
  if (problems.length > 0) {
    console.error(`${check.output}${generate.output}`);
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error("See docs/database-migrations.md.");
    process.exitCode = 1;
  } else {
    console.log("✓ migrations match the schema code");
  }
}
