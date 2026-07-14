import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SERVICES_DIR = join(REPO_ROOT, "services");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const PACKAGE_NAME = "@openconditions/probe-spike";
const VDAF_MARKER = "@divviup";
const SPIKE_DIR = join(PACKAGES_DIR, "probe-spike");
const SKIP = new Set(["node_modules", "dist", ".turbo", "coverage"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry)) {
      out.push(full);
    }
  }
}

/** Every package.json under a workspace root (skipping node_modules etc.). */
function packageManifests(root: string): string[] {
  const files: string[] = [];
  walk(root, files);
  return files.filter((f) => basename(f) === "package.json");
}

describe("isolation: the draft-09 VDAF spike never enters a production dependency tree", () => {
  it("nothing under services/* references @openconditions/probe-spike", () => {
    const files: string[] = [];
    walk(SERVICES_DIR, files);
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((f) => readFileSync(f, "utf8").includes(PACKAGE_NAME));
    expect(offenders).toEqual([]);
  });

  it("no package.json under services/* declares an @divviup dependency", () => {
    const offenders = packageManifests(SERVICES_DIR).filter((f) =>
      readFileSync(f, "utf8").includes(VDAF_MARKER)
    );
    expect(offenders).toEqual([]);
  });

  it("no package.json under packages/* except probe-spike declares an @divviup dependency", () => {
    const offenders = packageManifests(PACKAGES_DIR).filter(
      (f) => dirname(f) !== SPIKE_DIR && readFileSync(f, "utf8").includes(VDAF_MARKER)
    );
    expect(offenders).toEqual([]);
  });
});
