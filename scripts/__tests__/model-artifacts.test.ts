import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOC,
  renderModelArtifacts,
  SCHEMA_DIR,
  staleModelArtifacts,
} from "../gen-model-artifacts.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function snapshot() {
  const root = mkdtempSync(join(tmpdir(), "model-artifacts-"));
  owned.push(root);
  for (const path of [DOC, ".prettierrc.json"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(join(ROOT, path)));
  }
  const files = await renderModelArtifacts(root);
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, files };
}

function verify(root: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const {staleModelArtifacts}=await import(process.argv[1]);
const stale=await staleModelArtifacts(process.argv[2]);
console.log(JSON.stringify(stale));process.exitCode=stale.length?1:0;`,
      new URL("../gen-model-artifacts.ts", import.meta.url).href,
      root,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
}

describe("published model artifacts", () => {
  it("match the registry (run pnpm gen:model after a registry change)", async () => {
    expect(await staleModelArtifacts()).toEqual([]);
  });

  it("rejects byte drift, missing/obsolete schemas and stale generated Markdown without writing", async () => {
    const { root, files } = await snapshot();
    const [changed, missing] = [...files.keys()].filter((path) => path !== DOC);
    const obsolete = `${SCHEMA_DIR}/obsolete-fixture.json`;
    const schema = files.get(changed) as string;
    writeFileSync(join(root, changed), `${schema}\n`);
    expect(JSON.parse(readFileSync(join(root, changed), "utf8"))).toEqual(JSON.parse(schema));
    rmSync(join(root, missing));
    writeFileSync(join(root, obsolete), "{}\n");
    const doc = (files.get(DOC) as string).replace(
      "<!-- generated:registry:start -->",
      "<!-- generated:registry:start -->\n\nStale generated registry.",
    );
    writeFileSync(join(root, DOC), doc);
    const broken = verify(root);
    expect(broken.status, broken.stderr).toBe(1);
    expect(JSON.parse(broken.stdout)).toEqual([changed, missing, obsolete, DOC].sort());
    expect(readFileSync(join(root, changed), "utf8")).toBe(`${schema}\n`);
    expect(readFileSync(join(root, DOC), "utf8")).toBe(doc);
    expect(readFileSync(join(root, obsolete), "utf8")).toBe("{}\n");
    for (const [path, content] of files) writeFileSync(join(root, path), content);
    rmSync(join(root, obsolete));
    const restored = verify(root);
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout)).toEqual([]);
  });

  it("fails missing documentation markers instead of treating the render as empty", async () => {
    const { root } = await snapshot();
    writeFileSync(join(root, DOC), "# No generated registry markers\n");
    await expect(staleModelArtifacts(root)).rejects.toThrow(
      "lacks the <!-- generated:registry:start -->",
    );
  });
});
