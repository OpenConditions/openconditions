import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check, commit, fixture, put, run } from "./docker-context-fixtures.js";

const owned: string[] = [];
afterEach(() => {
  for (const p of owned.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup() {
  const f = fixture();
  owned.push(f.repo);
  return f;
}
function fakeDocker(body: string) {
  const bin = mkdtempSync(join(tmpdir(), "oc-context-tool-"));
  owned.push(bin);
  put(bin, "docker", `#!${process.execPath}\n${body}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

describe("Docker context command failure honesty", () => {
  it("rejects missing commits before starting BuildKit", () => {
    const { repo, a } = setup();
    const r = check(repo, a, "1".repeat(40), fakeDocker("throw new Error('should not start')"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("commit");
  });
  it("rejects malformed identities without interpreting shell text", () => {
    const { repo, a } = setup();
    const r = check(repo, a, "$(touch escaped)");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("40 lowercase hex");
  });
  it("fails actionably when Docker is missing", () => {
    const { repo, a } = setup();
    const bin = mkdtempSync(join(tmpdir(), "oc-context-no-docker-"));
    owned.push(bin);
    for (const tool of ["git", "tar"]) symlinkSync(run(repo, "which", [tool]), join(bin, tool));
    const r = check(repo, a, a, { ...process.env, PATH: bin });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docker buildx");
  });
  it.each(["process.exit(17)", "process.exit(0)"])(
    "rejects failed or absent exports (%s)",
    (body) => {
      const { repo, a } = setup();
      const r = check(repo, a, a, fakeDocker(body));
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
    },
  );
  it("rejects an export symlink without following it", () => {
    const { repo, a } = setup();
    const body = `const fs=require('node:fs'); const path=require('node:path'); const arg=process.argv.find(x=>x.startsWith('type=local,dest=')); if(arg){const p=arg.slice('type=local,dest='.length); fs.mkdirSync(p,{recursive:true});fs.symlinkSync('/etc/passwd',path.join(p,'escape')); const m=process.argv[process.argv.indexOf('--metadata-file')+1]; fs.writeFileSync(m,JSON.stringify({'buildx.build.ref':'fixture/build/ref'}));}`;
    const r = check(repo, a, a, fakeDocker(body));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("regular");
  });
  it("does not claim or retain a partial failed export or modify the source/index", () => {
    const { repo, a } = setup();
    const scratch = mkdtempSync(join(tmpdir(), "oc-context-cleanup-"));
    owned.push(scratch);
    const index = readFileSync(join(repo, ".git/index"));
    const source = readFileSync(join(repo, "package.json"));
    const env = fakeDocker(
      `const fs=require('node:fs'); const arg=process.argv.find(x=>x.startsWith('type=local,dest=')); if(arg){const p=arg.slice('type=local,dest='.length); fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/partial','partial');} process.exit(17);`,
    );
    const r = check(repo, a, a, { ...env, TMPDIR: scratch });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(readdirSync(scratch)).toEqual([]);
    expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
    expect(readFileSync(join(repo, "package.json"))).toEqual(source);
    expect(run(repo, "git", ["rev-parse", "HEAD"])).toBe(a);
  });
  it.each(["{}", "not-json"])("rejects malformed BuildKit metadata: %s", (metadata) => {
    const { repo, a } = setup();
    const body = `const fs=require('node:fs'); const m=process.argv[process.argv.indexOf('--metadata-file')+1]; fs.writeFileSync(m,${JSON.stringify(metadata)});`;
    const r = check(repo, a, a, fakeDocker(body));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("BuildKit");
  });
  it("rejects export-ignore archives that omit committed input", () => {
    const { repo, a } = setup();
    put(repo, ".gitattributes", "package.json export-ignore\n");
    const r = check(repo, a, commit(repo));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
  it("rejects tracked symlinks before archive extraction", () => {
    const { repo, a } = setup();
    symlinkSync("/etc/passwd", join(repo, "escape"));
    const b = commit(repo);
    const r = check(repo, a, b);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("regular Git");
  });
  it.each([
    "services/ingest/Dockerfile",
    ".dockerignore",
    "services/openlr-resolver/.dockerignore",
    ".github/workflows/release.yml",
  ])("rejects changed build controls: %s", (path) => {
    const { repo, a } = setup();
    put(repo, path, `${readFileSync(join(repo, path), "utf8")}\n# changed\n`);
    const r = check(repo, a, commit(repo));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("build control changed");
  });
  it("rejects a producer using the wrong context", () => {
    const { repo } = setup();
    const p = ".github/workflows/release.yml";
    put(
      repo,
      p,
      readFileSync(join(repo, p), "utf8").replace(
        "context: services/openlr-resolver",
        "context: .",
      ),
    );
    const a = commit(repo);
    const r = check(repo, a, a);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("producer");
  });
});
