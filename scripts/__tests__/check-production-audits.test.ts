import { describe, expect, it, vi } from "vitest";
import {
  type AuditCommandResult,
  type AuditRunner,
  checkProductionAudits,
} from "../check-production-audits.js";

const cleanPnpm = JSON.stringify({
  actions: [],
  advisories: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  },
});

const cleanPip = JSON.stringify({
  dependencies: [{ name: "fastapi", version: "1.0.0", vulns: [] }],
  fixes: [],
});

function result(stdout: string, status = 0, stderr = ""): AuditCommandResult {
  return { status, stdout, stderr };
}

function runner(javascript: AuditCommandResult, python: AuditCommandResult): AuditRunner {
  return vi.fn((_command, args) => (args.includes("audit") ? javascript : python));
}

describe("production dependency audits", () => {
  it("accepts only clean JavaScript and Python scanner results", () => {
    const run = runner(result(cleanPnpm), result(cleanPip, 0, "No known vulnerabilities found"));

    expect(checkProductionAudits(run)).toEqual([
      { ecosystem: "javascript", dependencies: undefined, vulnerabilities: 0 },
      { ecosystem: "python", dependencies: 1, vulnerabilities: 0 },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects an advisory even if the scanner exits successfully", () => {
    const vulnerable = JSON.stringify({
      advisories: { "GHSA-test": { severity: "high" } },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      },
    });

    expect(() => checkProductionAudits(runner(result(vulnerable), result(cleanPip)))).toThrow(
      "JavaScript production audit found 1 vulnerability",
    );
  });

  it("rejects malformed scanner output instead of treating it as clean", () => {
    expect(() => checkProductionAudits(runner(result("{}"), result(cleanPip)))).toThrow(
      "malformed JavaScript production audit output",
    );
  });

  it("rejects a scanner subprocess failure without echoing arbitrary output", () => {
    const run = runner(
      { status: null, stdout: "", stderr: "token=do-not-print", error: new Error("spawn failed") },
      result(cleanPip),
    );

    expect(() => checkProductionAudits(run)).toThrow("JavaScript production audit did not run");
    expect(() => checkProductionAudits(run)).not.toThrow("do-not-print");
  });

  it("rejects Python vulnerabilities and a non-zero clean-looking scan", () => {
    const vulnerable = JSON.stringify({
      dependencies: [
        {
          name: "fastapi",
          version: "1.0.0",
          vulns: [{ id: "PYSEC-test", fix_versions: ["1.0.1"] }],
        },
      ],
      fixes: [],
    });
    expect(() => checkProductionAudits(runner(result(cleanPnpm), result(vulnerable, 1)))).toThrow(
      "Python production audit found 1 vulnerability",
    );
    expect(() => checkProductionAudits(runner(result(cleanPnpm), result(cleanPip, 2)))).toThrow(
      "Python production audit failed with exit code 2",
    );
  });
});
