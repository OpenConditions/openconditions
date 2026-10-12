import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AuditCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type AuditRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => AuditCommandResult;

export interface AuditSummary {
  ecosystem: "javascript" | "python";
  dependencies: number | undefined;
  vulnerabilities: number;
}

type Ecosystem = AuditSummary["ecosystem"];
type JsonObject = Record<string, unknown>;

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const resolverRoot = path.join(repoRoot, "services/openlr-resolver");

const defaultRunner: AuditRunner = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
};

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(text: string, ecosystem: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`malformed ${ecosystem} production audit output`);
  }
}

function javascriptVulnerabilities(text: string): number {
  const value = json(text, "JavaScript");
  if (!object(value) || !object(value.advisories) || !object(value.metadata)) {
    throw new Error("malformed JavaScript production audit output");
  }
  const vulnerabilities = value.metadata.vulnerabilities;
  if (!object(vulnerabilities)) {
    throw new Error("malformed JavaScript production audit output");
  }
  const severities = ["info", "low", "moderate", "high", "critical"];
  const counts = severities.map((severity) => vulnerabilities[severity]);
  if (counts.some((count) => !Number.isInteger(count) || (count as number) < 0)) {
    throw new Error("malformed JavaScript production audit output");
  }
  return Math.max(
    Object.keys(value.advisories).length,
    counts.reduce<number>((sum, count) => sum + (count as number), 0),
  );
}

function pythonAudit(text: string): { dependencies: number; vulnerabilities: number } {
  const value = json(text, "Python");
  if (!object(value) || !Array.isArray(value.dependencies)) {
    throw new Error("malformed Python production audit output");
  }
  let vulnerabilities = 0;
  for (const dependency of value.dependencies) {
    if (!object(dependency) || !Array.isArray(dependency.vulns)) {
      throw new Error("malformed Python production audit output");
    }
    vulnerabilities += dependency.vulns.length;
  }
  return { dependencies: value.dependencies.length, vulnerabilities };
}

function commandFailure(ecosystem: string, result: AuditCommandResult): never {
  if (result.status === null || result.error) {
    throw new Error(`${ecosystem} production audit did not run`);
  }
  throw new Error(`${ecosystem} production audit failed with exit code ${result.status}`);
}

function plural(count: number): string {
  return count === 1 ? "vulnerability" : "vulnerabilities";
}

/** Runs the repository's two production dependency scanners and accepts only zero findings. */
export function checkProductionAudits(
  runner: AuditRunner = defaultRunner,
  ecosystems: readonly Ecosystem[] = ["javascript", "python"],
): AuditSummary[] {
  const summaries: AuditSummary[] = [];
  for (const ecosystem of ecosystems) {
    if (ecosystem === "javascript") {
      const result = runner("pnpm", ["audit", "--prod", "--json"], repoRoot);
      if (result.status === null || result.error) commandFailure("JavaScript", result);
      const vulnerabilities = javascriptVulnerabilities(result.stdout);
      if (vulnerabilities > 0) {
        throw new Error(
          `JavaScript production audit found ${vulnerabilities} ${plural(vulnerabilities)}`,
        );
      }
      if (result.status !== 0) commandFailure("JavaScript", result);
      summaries.push({ ecosystem, dependencies: undefined, vulnerabilities });
      continue;
    }

    const localPython = path.join(resolverRoot, ".venv/bin/python");
    const result = runner(
      existsSync(localPython) ? localPython : "python",
      ["-m", "pip_audit", "--requirement", "requirements.txt", "--format", "json"],
      resolverRoot,
    );
    if (result.status === null || result.error) commandFailure("Python", result);
    const parsed = pythonAudit(result.stdout);
    if (parsed.vulnerabilities > 0) {
      throw new Error(
        `Python production audit found ${parsed.vulnerabilities} ${plural(parsed.vulnerabilities)}`,
      );
    }
    if (result.status !== 0) commandFailure("Python", result);
    summaries.push({ ecosystem, ...parsed });
  }
  return summaries;
}

function selectedEcosystems(args: readonly string[]): Ecosystem[] {
  if (args.length === 0) return ["javascript", "python"];
  if (args.length === 1 && args[0] === "--javascript") return ["javascript"];
  if (args.length === 1 && args[0] === "--python") return ["python"];
  throw new Error("usage: check-production-audits [--javascript|--python]");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    for (const summary of checkProductionAudits(
      defaultRunner,
      selectedEcosystems(process.argv.slice(2)),
    )) {
      const dependencies =
        summary.dependencies === undefined ? "" : ` across ${summary.dependencies} dependencies`;
      console.log(
        `${summary.ecosystem}: ${summary.vulnerabilities} production vulnerabilities${dependencies}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "production audit failed");
    process.exitCode = 1;
  }
}
