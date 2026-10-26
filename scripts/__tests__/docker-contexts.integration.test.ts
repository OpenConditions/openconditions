import { chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check, commit, fixture, images, put } from "./docker-context-fixtures.js";

const owned: string[] = [];
afterEach(() => {
  for (const p of owned.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup() {
  const f = fixture();
  owned.push(f.repo);
  return f;
}
function result(r: ReturnType<typeof check>) {
  expect(r.error).toBeUndefined();
  expect(r.stderr, r.stderr).toBe("");
  return JSON.parse(r.stdout);
}

describe("real BuildKit effective contexts (Docker required)", () => {
  it("keeps all four contexts equal after excluded metadata edits and preserves genuine inputs", () => {
    const { repo, a } = setup();
    for (const p of [
      "extension.json",
      ...["ingest", "ingest-heavy", "contributions-api", "federation"].map(
        (i) => `services/${i}/service.json`,
      ),
      "docs/release-notes/fixture.json",
      "advisor-plans/private.txt",
      "plans/private.txt",
    ])
      put(repo, p, '{"version":"fixture-b"}\n');
    // Untracked local data never enters either archived source snapshot.
    const b = commit(repo);
    put(repo, "local-build-scratch/secret", "untracked\n");
    const r = check(repo, a, b);
    const report = result(r);
    expect(r.status, r.stdout).toBe(0);
    expect(report.equal).toBe(true);
    expect(report.images.map((i: { image: string }) => i.image)).toEqual(images);
    for (const image of report.images) {
      expect(image.a.inventorySha256).toBe(image.b.inventorySha256);
      expect(image.a.files).toBeGreaterThan(5);
      const paths = image.a.inventory.map((entry: { path: string }) => entry.path);
      expect(paths).not.toEqual(expect.arrayContaining(["extension.json"]));
      expect(
        paths.some((p: string) => /^(advisor-plans|plans|docs\/release-notes)\//.test(p)),
      ).toBe(false);
      expect(
        paths.some(
          (p: string) =>
            p.includes("untracked-secret") ||
            p.includes("local-build-scratch") ||
            p === ".env.private",
        ),
      ).toBe(false);
      expect(paths.some((p: string) => /^services\/[^/]+\/service.json$/.test(p))).toBe(false);
    }
  }, 180_000);

  it("rejects code, locks, feeds and mode changes in the applicable root/service contexts", () => {
    const { repo, a } = setup();
    for (const p of [
      "packages/core/src/index.ts",
      "packages/core/src/- ü\nname.ts",
      "pnpm-lock.yaml",
      "feeds/roads/de.jsonc",
      "services/openlr-resolver/app/__main__.py",
      "services/openlr-resolver/requirements.txt",
    ])
      put(repo, p, "changed\n");
    chmodSync(join(repo, "services/ingest/src/index.ts"), 0o755);
    const r = check(repo, a, commit(repo));
    const report = result(r);
    expect(r.status).toBe(1);
    expect(report.equal).toBe(false);
    for (const image of report.images) {
      const paths = image.differences;
      if (image.image === "ingest") {
        expect(
          image.a.inventory.find((e: { path: string }) => e.path === "services/ingest/src/index.ts")
            .mode,
        ).toBe(0o644);
        expect(
          image.b.inventory.find((e: { path: string }) => e.path === "services/ingest/src/index.ts")
            .mode,
        ).toBe(0o755);
        expect(paths).toContain("packages/core/src/- ü\nname.ts");
      }
      if (image.image === "openlr-resolver")
        expect(paths).toEqual(expect.arrayContaining(["app/__main__.py", "requirements.txt"]));
      else
        expect(paths).toEqual(
          expect.arrayContaining([
            "packages/core/src/index.ts",
            "pnpm-lock.yaml",
            "feeds/roads/de.jsonc",
            "services/ingest/src/index.ts",
          ]),
        );
    }
  }, 180_000);

  it("uses Dockerfile-specific ignore precedence, not the adjacent service .dockerignore", () => {
    const { repo } = setup();
    put(repo, "services/ingest/Dockerfile.dockerignore", "extension.json\n");
    const a = commit(repo);
    put(repo, "services/ingest/service.json", "changed\n");
    const r = check(repo, a, commit(repo));
    const report = result(r);
    expect(r.status).toBe(1);
    expect(
      report.images.find((i: { image: string }) => i.image === "ingest").differences,
    ).toContain("services/ingest/service.json");
    expect(
      report.images.find((i: { image: string }) => i.image === "federation").differences,
    ).toEqual([]);
  }, 180_000);

  it("retains package manifests, migrations, feeds, nested licenses and notices", () => {
    const { repo, a } = setup();
    for (const p of [
      "package.json",
      "packages/core/drizzle/001.sql",
      "packages/core/LICENSE",
      "packages/core/NOTICE",
      "services/openlr-resolver/LICENSE",
      "services/openlr-resolver/NOTICE",
    ])
      put(repo, p, `${readFileSync(join(repo, p), "utf8")}changed\n`);
    const r = check(repo, a, commit(repo));
    const report = result(r);
    expect(r.status).toBe(1);
    expect(report.images[0].differences).toEqual(
      expect.arrayContaining([
        "package.json",
        "packages/core/drizzle/001.sql",
        "packages/core/LICENSE",
        "packages/core/NOTICE",
      ]),
    );
    expect(report.images[3].differences).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]));
  }, 180_000);
});
