import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Architecture import boundaries.
 *
 * These were ESLint `no-restricted-syntax` selectors. Biome has no equivalent
 * rule, and its `noRestrictedImports` misses two forms the boundaries have
 * always covered — `require()` and the `import("mod").Type` type expression —
 * so the checks live here, over the TypeScript AST. Working from the AST rather
 * than from text is what keeps a module name inside a comment or a string from
 * being reported.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));

interface Boundary {
  id: string;
  pattern: RegExp;
  message: string;
}

const CONTAINERS: Boundary = {
  id: "containers",
  pattern: /^testcontainers$|^@testcontainers\//,
  message: "Import testcontainers only in *.integration.test.ts or *.integration.ts.",
};

const SPIKE: Boundary = {
  id: "spike",
  pattern: /^@openconditions\/probe-spike(?:\/|$)|^@divviup\/|(?:^|\/)probe-spike(?:\/|$)/,
  message: "Keep experimental probe dependencies in probe-spike or test-only code.",
};

const INGEST: Boundary = {
  id: "ingest",
  pattern:
    /^@openconditions\/ingest(?:\/|$)|(?:^|\/)services\/ingest(?:\/|$)|(?:^|\/)ingest\/src\//,
  message: "Use @openconditions/normalize or @openconditions/storage, not the ingest service.",
};

const TRANSPORT: Boundary = {
  id: "transport",
  pattern:
    /^@openconditions\/federation(?:\/|$)|(?:^|\/)(?:peer-health|peer-blocklist|anomaly)(?:\.[cm]?[tj]s)?$|^\.\/rate(?:\.[cm]?[tj]s)?$/,
  message: "Event truth must remain independent of federation transport health.",
};

/** Files whose conclusions must not depend on federation transport health. */
const TRUTH_PATHS = [
  "packages/core/src/evidence.ts",
  "packages/core/src/crossSourceDedupe.ts",
  "packages/roads/src/evidence-policy.ts",
  "packages/federation/src/filter.ts",
];

const TRUTH_DIRECTORIES = [
  "evidence",
  "reputation",
  "landing",
  "subclaim",
  "reviewer",
  "federation",
].map((area) => `services/contributions-api/src/${area}/`);

const isIntegrationFile = (path: string): boolean =>
  path.endsWith(".integration.ts") || path.endsWith(".integration.test.ts");

/** Test-adjacent code may reach for anything the production paths may not. */
const isTestFile = (path: string): boolean =>
  path.includes("/__tests__/") || path.endsWith(".test.ts") || path.endsWith(".integration.ts");

const isPackageOrServiceSource = (path: string): boolean =>
  /^(?:packages|services)\/[^/]+\/src\//.test(path);

const isTruthPath = (path: string): boolean =>
  TRUTH_PATHS.includes(path) || TRUTH_DIRECTORIES.some((directory) => path.startsWith(directory));

/** Which boundaries a file is held to, widest first. */
export function boundariesFor(path: string): Boundary[] {
  const boundaries: Boundary[] = [];
  if (!isIntegrationFile(path)) boundaries.push(CONTAINERS);
  if (!isTestFile(path)) {
    if (isPackageOrServiceSource(path) && !path.startsWith("packages/probe-spike/")) {
      boundaries.push(SPIKE);
    }
    if (path.startsWith("services/contributions-api/src/")) boundaries.push(INGEST);
    if (isTruthPath(path)) {
      if (!boundaries.includes(INGEST)) boundaries.push(INGEST);
      boundaries.push(TRANSPORT);
    }
  }
  return boundaries;
}

export interface ImportBoundaryViolation {
  file: string;
  line: number;
  specifier: string;
  boundary: string;
  message: string;
}

/** Every module specifier a file names, in any import, export or require form. */
function moduleSpecifiers(source: ts.SourceFile): { text: string; node: ts.Node }[] {
  const found: { text: string; node: ts.Node }[] = [];
  const record = (node: ts.Node | undefined, at: ts.Node): void => {
    if (node !== undefined && ts.isStringLiteralLike(node))
      found.push({ text: node.text, node: at });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression, node);
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) record(node.argument.literal, node);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) record(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** `path` is repo-relative and posix-separated, as the scopes are written. */
export function importBoundaryViolations(source: string, path: string): ImportBoundaryViolation[] {
  const boundaries = boundariesFor(path);
  if (boundaries.length === 0) return [];
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const violations: ImportBoundaryViolation[] = [];
  for (const { text, node } of moduleSpecifiers(parsed)) {
    // One report per specifier, so a name caught by two boundaries is one
    // finding rather than a pile.
    const boundary = boundaries.find((candidate) => candidate.pattern.test(text));
    if (boundary === undefined) continue;
    const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    violations.push({
      file: path,
      line: line + 1,
      specifier: text,
      boundary: boundary.id,
      message: boundary.message,
    });
  }
  return violations;
}

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "drizzle",
]);
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) sourceFiles(path, out);
    } else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

export function checkImportBoundaries(roots = ["packages", "services", "integrations", "scripts"]) {
  const violations: ImportBoundaryViolation[] = [];
  for (const root of roots) {
    for (const path of sourceFiles(root)) {
      violations.push(...importBoundaryViolations(readFileSync(join(ROOT, path), "utf8"), path));
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = checkImportBoundaries();
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} ${violation.specifier} — ${violation.message}`,
    );
  }
  if (violations.length > 0) {
    console.error(`✗ ${violations.length} import boundary violation(s)`);
    process.exit(1);
  }
  console.log("✓ import boundaries respected");
}
