import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * BINDING GREP-GUARD (ADR §8): PEER HEALTH IS SEPARATE FROM EVENT TRUTH.
 *
 * No module that decides an event's TRUTH — evidence state, confidence,
 * routing eligibility, reporter reputation, or the federated-ingest trust
 * boundary — may import a peer-health, rate, blocklist, or anomaly transport
 * signal. A misbehaving peer's events are never auto-judged false; only
 * transport controls (rate, block) apply. If this test fails, a truth path
 * started reading a transport signal — revert it.
 *
 * The scan is over whole IMPORT/EXPORT-FROM statements (multi-line joined), and
 * the forbidden set is the transport SYMBOLS plus the module specifiers
 * (including the barrel `@openconditions/federation`), so a barrel import like
 * `import { getPeerHealth } from "@openconditions/federation"` — on one line or
 * split across several — fails the guard.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Source trees + files that compute EVENT TRUTH and must stay health-blind. */
const TRUTH_PATHS = [
  "packages/core/src/evidence.ts",
  "packages/core/src/crossSourceDedupe.ts",
  "packages/roads/src/evidence-policy.ts",
  "packages/federation/src/filter.ts",
  "services/contributions-api/src/evidence",
  "services/contributions-api/src/reputation",
  "services/contributions-api/src/landing",
  "services/contributions-api/src/subclaim",
  "services/contributions-api/src/reviewer",
  // The federated-ingest trust boundary itself: the one place peer events cross
  // into the evidence world — it must apply transport controls WITHOUT ever
  // reading a peer-health signal to judge those events.
  "services/contributions-api/src/federation",
];

/**
 * Tokens a truth-path import statement must never contain: the transport
 * SYMBOLS (caught even through the barrel), the transport module specifiers,
 * and the barrel specifier itself (truth modules stay federation-transport
 * blind).
 */
const FORBIDDEN = [
  // Transport symbols (barrel or relative).
  "getPeerHealth",
  "computePeerHealth",
  "recordPeerFailure",
  "recordAvailability",
  "setEffectiveTierUntil",
  "peerHealth",
  "isPeerBlocked",
  "blockPeer",
  "unblockPeer",
  "listBlockedPeers",
  "detectAnomaly",
  "peerWindowStats",
  "createInMemoryRateLimiter",
  "ratePolicyForTier",
  // Transport module specifiers.
  "peer-health",
  "peer-blocklist",
  "./anomaly",
  "./rate",
  // The federation transport barrel — truth modules must not reach into it.
  "@openconditions/federation",
];

function collectTsFiles(absPath: string): string[] {
  const stat = statSync(absPath);
  if (stat.isFile()) {
    return absPath.endsWith(".ts") ? [absPath] : [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(absPath)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const child = join(absPath, entry);
    if (statSync(child).isDirectory()) {
      out.push(...collectTsFiles(child));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(child);
    }
  }
  return out;
}

/**
 * Extracts whole import/export-from statements (multi-line named-import blocks
 * joined), plus side-effect and dynamic imports, so a symbol split across lines
 * cannot escape the scan.
 */
function importStatements(source: string): string[] {
  const stmts: string[] = [];
  const fromImport = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["'][^"']+["']/g;
  const dynamic = /\b(?:require|import)\s*\(\s*["'][^"']+["']\s*\)/g;
  const sideEffect = /\bimport\s*["'][^"']+["']/g;
  for (const re of [fromImport, dynamic, sideEffect]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      stmts.push(match[0].replace(/\s+/g, " "));
    }
  }
  return stmts;
}

describe("peer health is separate from event truth", () => {
  const files = TRUTH_PATHS.flatMap((rel) => collectTsFiles(join(REPO_ROOT, rel)));

  it("scans a non-trivial set of truth-computing files", () => {
    expect(files.length).toBeGreaterThan(6);
  });

  it("no evidence/reputation/confidence/routing/ingest module imports a transport signal", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const statement of importStatements(source)) {
        if (FORBIDDEN.some((token) => statement.includes(token))) {
          offenders.push(`${file}: ${statement.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catches a barrel import of a transport symbol (single-line and multi-line)", () => {
    // Proves the guard would fire on the regression class it exists to catch —
    // without adding any such import to the real tree.
    const singleLine = `import { getPeerHealth } from "@openconditions/federation";`;
    const multiLine = [
      "import {",
      "  something,",
      "  detectAnomaly,",
      '} from "@openconditions/federation";',
    ].join("\n");
    for (const sample of [singleLine, multiLine]) {
      const hit = importStatements(sample).some((statement) =>
        FORBIDDEN.some((token) => statement.includes(token))
      );
      expect(hit).toBe(true);
    }
  });
});
