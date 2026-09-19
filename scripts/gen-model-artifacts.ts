import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSchemaArtifacts, registryMarkdown } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import * as prettier from "prettier";

/**
 * Published model artifacts: the JSON Schemas under
 * packages/model-registry/schemas/ and the generated registry section of
 * docs/model.md, both rendered from the production registry. `--write`
 * regenerates them; without it the script lists stale files and exits 1
 * (pre-commit and the artifacts test).
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const SCHEMA_DIR = "packages/model-registry/schemas";
export const DOC = "docs/model.md";
const START = "<!-- generated:registry:start -->";
const END = "<!-- generated:registry:end -->";

/** Every artifact path (repo-relative) mapped to its rendered content. */
export async function renderModelArtifacts(root = ROOT): Promise<Map<string, string>> {
  const registry = productionRegistry();
  const files = new Map<string, string>();
  for (const [path, json] of jsonSchemaArtifacts(registry)) {
    files.set(`${SCHEMA_DIR}/${path}`, `${JSON.stringify(json, null, 2)}\n`);
  }
  const doc = readFileSync(join(root, DOC), "utf8");
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${DOC} lacks the ${START} … ${END} markers`);
  const spliced = `${doc.slice(0, start + START.length)}\n\n${registryMarkdown(registry)}\n${doc.slice(end)}`;
  const config = (await prettier.resolveConfig(join(root, DOC))) ?? {};
  files.set(DOC, await prettier.format(spliced, { ...config, parser: "markdown" }));
  return files;
}

function committedSchemas(root: string): string[] {
  const dir = join(root, SCHEMA_DIR);
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(root, join(e.parentPath, e.name)));
  } catch {
    return [];
  }
}

/** Artifacts whose committed content differs from the render, plus committed schemas no longer rendered. */
export async function staleModelArtifacts(root = ROOT): Promise<string[]> {
  const rendered = await renderModelArtifacts(root);
  const stale: string[] = [];
  for (const [path, content] of rendered) {
    let current: string | undefined;
    try {
      current = readFileSync(join(root, path), "utf8");
    } catch {
      current = undefined;
    }
    if (current !== content) stale.push(path);
  }
  for (const path of committedSchemas(root)) if (!rendered.has(path)) stale.push(path);
  return stale.sort();
}

async function write(root = ROOT): Promise<void> {
  rmSync(join(root, SCHEMA_DIR), { recursive: true, force: true });
  for (const [path, content] of await renderModelArtifacts(root)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    await write();
    console.log("✓ model artifacts written");
  } else {
    const stale = await staleModelArtifacts();
    if (stale.length > 0) {
      console.error(`✗ stale model artifacts (run pnpm gen:model):\n  ${stale.join("\n  ")}`);
      process.exit(1);
    }
    console.log("✓ model artifacts up to date");
  }
}
