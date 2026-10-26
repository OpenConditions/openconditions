import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve("scripts/check-staged.mjs");
const roots: string[] = [];
function command(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oc-staged-test-"));
  roots.push(root);
  command(root, ["init", "-q"]);
  command(root, ["config", "user.name", "Fixture"]);
  command(root, ["config", "user.email", "fixture@example.invalid"]);
  command(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "biome.json"), readFileSync("biome.json"));
  writeFileSync(join(root, ".prettierrc.json"), '{"printWidth":100,"tabWidth":2}\n');
  writeFileSync(join(root, ".prettierignore"), "generated.md\n");
  command(root, ["add", "."]);
  command(root, ["commit", "-qm", "fixture"]);
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  return { root, scratch };
}
function stage(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  command(root, ["add", "--", path]);
}
function run(root: string, scratch: string, script = helper) {
  const index = readFileSync(join(root, ".git/index"));
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: scratch, NODE_DISABLE_COMPILE_CACHE: "1" },
  });
  expect(readdirSync(scratch)).toEqual([]);
  return { ...result, index, output: result.stdout + result.stderr };
}
function unchanged(root: string, index: Buffer) {
  expect(readFileSync(join(root, ".git/index"))).toEqual(index);
}
function fileState(path: string) {
  const descriptor = openSync(path, "r");
  try {
    return { bytes: readFileSync(descriptor), stat: fstatSync(descriptor, { bigint: true }) };
  } finally {
    closeSync(descriptor);
  }
}
function localHelper(root: string, body?: string) {
  const script = join(root, "scripts/check-staged.mjs");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(helper, script);
  if (body) {
    const tool = join(root, "node_modules/@biomejs/biome/bin/biome");
    mkdirSync(dirname(tool), { recursive: true });
    writeFileSync(tool, body);
  }
  return script;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("staged checker command", () => {
  it("accepts an unborn repository without creating a source index", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-staged-unborn-"));
    roots.push(root);
    command(root, ["init", "-q"]);
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const result = spawnSync(process.execPath, [helper], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratch },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, ".git/index"))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });
  it("accepts an empty index without installed formatters", () => {
    const { root, scratch } = fixture();
    const result = run(root, scratch, localHelper(root));
    expect(result.status, result.output).toBe(0);
    unchanged(root, result.index);
  });
  it.each(["part.ts", "part.md"])("checks staged %s without touching unstaged hunks", (path) => {
    const { root, scratch } = fixture();
    stage(root, path, path.endsWith("ts") ? "export const value = 1;\n" : "# Staged\n");
    const unstaged = path.endsWith("ts") ? "export const value = ;\n" : "#    Unstaged\n";
    writeFileSync(join(root, path), unstaged);
    writeFileSync(join(root, "unrelated.ts"), "invalid syntax !!!");
    const result = run(root, scratch);
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(join(root, path), "utf8")).toBe(unstaged);
    unchanged(root, result.index);
  });
  it.each(["bad.ts", "bad.md"])(
    "rejects invalid staged %s despite a valid working file",
    (path) => {
      const { root, scratch } = fixture();
      stage(root, path, path.endsWith("ts") ? "export const value = ;\n" : "#    Staged\n");
      const valid = path.endsWith("ts") ? "export const value = 1;\n" : "# Valid\n";
      writeFileSync(join(root, path), valid);
      const result = run(root, scratch);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toMatch(/staged|index/i);
      expect(readFileSync(join(root, path), "utf8")).toBe(valid);
      unchanged(root, result.index);
    },
  );
  it("handles literal unusual paths, renames, deletion and symlinks without dereferencing", () => {
    const { root, scratch } = fixture();
    stage(root, "old.ts", "export const old = 1;\n");
    stage(root, "delete.ts", "invalid !!!");
    command(root, ["commit", "-qm", "fixture"]);
    command(root, ["mv", "old.ts", "renamed.ts"]);
    command(root, ["rm", "delete.ts"]);
    for (const path of ["space name.ts", "line\nbreak.ts", "über.ts", "-dash.ts", "[literal].ts"])
      stage(root, path, "export const value = 1;\n");
    for (const path of ["space name.md", "line\nbreak.md", "über.md", "-dash.md", "[literal].md"])
      stage(root, path, "# Literal path\n");
    symlinkSync("/nonexistent/never-read", join(root, "link.ts"));
    command(root, ["add", "link.ts"]);
    const result = run(root, scratch);
    expect(result.status, result.output).toBe(0);
    unchanged(root, result.index);
  });
  it("rejects unformatted staged JSON and YAML and accepts their formatted replacements", () => {
    const { root, scratch } = fixture();
    stage(root, "data.json", '{"a":1}\n');
    stage(root, "data.yml", "a:    1\n");
    const bad = run(root, scratch);
    expect(bad.status).toBe(1);
    unchanged(root, bad.index);
    stage(root, "data.json", '{ "a": 1 }\n');
    const yaml = run(root, scratch);
    expect(yaml.status).toBe(1);
    expect(yaml.output).toContain("data.yml");
    unchanged(root, yaml.index);
    stage(root, "data.yml", "a: 1\n");
    const good = run(root, scratch);
    expect(good.status, good.output).toBe(0);
    unchanged(root, good.index);
  });
  it("does not follow staged configuration symlinks", () => {
    const { root, scratch } = fixture();
    rmSync(join(root, "biome.json"));
    symlinkSync("/never/read", join(root, "biome.json"));
    command(root, ["add", "biome.json"]);
    stage(root, "file.ts", "export const value = 1;\n");
    const result = run(root, scratch);
    expect(result.status).toBe(1);
    expect(result.output).toContain("configuration must be a regular file");
    unchanged(root, result.index);
  });
  it("checks a regular file replacing a symlink and never follows the reverse change", () => {
    const { root, scratch } = fixture();
    symlinkSync("/never/read", join(root, "changed.ts"));
    command(root, ["add", "changed.ts"]);
    command(root, ["commit", "-qm", "fixture"]);
    rmSync(join(root, "changed.ts"));
    stage(root, "changed.ts", "export const broken = ;\n");
    expect(command(root, ["diff", "--cached", "--name-status"])).toContain("T\tchanged.ts");
    const bad = run(root, scratch);
    expect(bad.status, bad.output).toBe(1);
    unchanged(root, bad.index);
    stage(root, "changed.ts", "export const valid = 1;\n");
    const good = run(root, scratch);
    expect(good.status, good.output).toBe(0);
    unchanged(root, good.index);
    command(root, ["commit", "-qm", "fixture"]);
    rmSync(join(root, "changed.ts"));
    symlinkSync("/still/never/read", join(root, "changed.ts"));
    command(root, ["add", "changed.ts"]);
    const link = run(root, scratch);
    expect(link.status, link.output).toBe(0);
    unchanged(root, link.index);
  });
  it("reads an explicitly selected alternate index without touching the default index", () => {
    const { root, scratch } = fixture();
    stage(root, "file.ts", "export const value = 1;\n");
    const alternate = join(root, "alternate-index");
    const before = readFileSync(join(root, ".git/index"));
    copyFileSync(join(root, ".git/index"), alternate);
    command(root, ["reset", "--quiet", "--", "file.ts"]);
    const actual = readFileSync(join(root, ".git/index"));
    writeFileSync(join(root, "file.ts"), "invalid unstaged !!!");
    const result = spawnSync(process.execPath, [helper], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: alternate, TMPDIR: scratch },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(alternate)).toEqual(before);
    expect(readFileSync(join(root, ".git/index"))).toEqual(actual);
    expect(readdirSync(scratch)).toEqual([]);
  });
  it("honors staged feed overrides and ignore rules even when working configs differ", () => {
    const { root, scratch } = fixture();
    stage(root, "feeds/region.jsonc", '{\n  "a": 1,\n}\n');
    stage(root, "generated.md", "#    Ignored\n");
    stage(root, "services/openlr-resolver/owned.json", "invalid JSON");
    writeFileSync(join(root, "biome.json"), "invalid config");
    writeFileSync(join(root, ".prettierignore"), "");
    const result = run(root, scratch);
    expect(result.status, result.output).toBe(0);
    unchanged(root, result.index);
  });
  it("reports a missing local tool without installing anything", () => {
    const { root, scratch } = fixture();
    stage(root, "file.ts", "export const value = 1;\n");
    const result = run(root, scratch, localHelper(root));
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/install.*frozen-lockfile/i);
    unchanged(root, result.index);
  });
  it("does not fall back to tools installed above the helper's repository", () => {
    const { root, scratch } = fixture();
    stage(root, "file.ts", "export const value = 1;\n");
    localHelper(root, "process.exit(0);");
    const isolated = localHelper(join(root, "nested"));
    const result = run(root, scratch, isolated);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/install.*frozen-lockfile/i);
    unchanged(root, result.index);
  });
  it("isolates inherited Git hook variables from snapshot initialization", () => {
    const { root, scratch } = fixture();
    stage(root, "file.ts", "export const value = 1;\n");
    const config = join(root, ".git/config");
    const before = fileState(config);
    const index = readFileSync(join(root, ".git/index"));
    const result = spawnSync(process.execPath, [helper], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratch, GIT_DIR: join(root, ".git"), GIT_WORK_TREE: root },
    });
    expect(result.status, result.stderr).toBe(0);
    const after = fileState(config);
    expect(after.stat.dev).toBe(before.stat.dev);
    expect(after.stat.ino).toBe(before.stat.ino);
    expect(after.stat.ctimeNs).toBe(before.stat.ctimeNs);
    expect(after.bytes).toEqual(before.bytes);
    unchanged(root, index);
    expect(readdirSync(scratch)).toEqual([]);
  });
  it("propagates formatter failure and cleans the snapshot", () => {
    const { root, scratch } = fixture();
    stage(root, "file.ts", "export const value = 1;\n");
    const result = run(
      root,
      scratch,
      localHelper(root, 'process.stderr.write("tool failed\\n"); process.exit(7);'),
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain("tool failed");
    unchanged(root, result.index);
  });
  it("fails safely when another real Git process changes the index during checking", () => {
    const { root, scratch } = fixture();
    stage(root, "file.ts", "export const value = 1;\n");
    const script = localHelper(
      root,
      `const {spawnSync}=require('node:child_process'); const {writeFileSync}=require('node:fs');
      writeFileSync(${JSON.stringify(join(root, "concurrent.txt"))}, 'other process');
      const r=spawnSync('git',['add','concurrent.txt'],{cwd:${JSON.stringify(root)}});process.exit(r.status);`,
    );
    const result = run(root, scratch, script);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/index changed/i);
    expect(result.stdout).not.toContain("index and working files unchanged");
    expect(command(root, ["show", ":concurrent.txt"])).toBe("other process");
    expect(command(root, ["show", ":file.ts"])).toBe("export const value = 1;\n");
  });
  it("rejects an index replacement even when another process restores identical bytes", () => {
    const { root, scratch } = fixture();
    stage(root, "file.ts", "export const value = 1;\n");
    const script = localHelper(
      root,
      `const fs=require('node:fs');const {spawnSync}=require('node:child_process');
      const root=${JSON.stringify(root)}; const index=root+'/.git/index'; const before=fs.readFileSync(index);
      fs.writeFileSync(root+'/concurrent.txt','keep unstaged');
      const r=spawnSync('git',['add','concurrent.txt'],{cwd:root});
      if(r.status!==0)process.exit(r.status);fs.writeFileSync(index,before);`,
    );
    const result = run(root, scratch, script);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/index changed/i);
    unchanged(root, result.index);
    expect(readFileSync(join(root, "concurrent.txt"), "utf8")).toBe("keep unstaged");
  });
  it.each(["replace", "overwrite"])(
    "keeps index bytes and identity coherent during a read-time %s",
    (operation) => {
      const { root: temporaryRoot, scratch } = fixture();
      const root = realpathSync(temporaryRoot);
      stage(root, "file.ts", "export const broken = ;\n");
      const index = join(root, ".git/index");
      const replacement = join(root, "replacement-index");
      copyFileSync(index, replacement);
      writeFileSync(join(root, "file.ts"), "export const valid = 1;\n");
      const added = spawnSync("git", ["add", "file.ts"], {
        cwd: root,
        env: { ...process.env, GIT_INDEX_FILE: replacement },
      });
      expect(added.status).toBe(0);
      const replacementBytes = readFileSync(replacement);
      const observed = join(root, "observed-staged-bytes");
      const closed = join(root, "closed-index-descriptor");
      const script = localHelper(
        root,
        `const fs=require('node:fs');
        fs.writeFileSync(${JSON.stringify(observed)},fs.readFileSync(process.argv.at(-1)));`,
      );
      const preload = join(root, "read-race.cjs");
      writeFileSync(
        preload,
        `const fs=require('node:fs');
        const index=${JSON.stringify(index)}, replacement=${JSON.stringify(replacement)};
        const open=fs.openSync, read=fs.readFileSync, close=fs.closeSync;
        let descriptor, changed=false;
        fs.openSync=function(path,...args){const fd=open.call(fs,path,...args);if(path===index)descriptor=fd;return fd;};
        fs.readFileSync=function(file,...args){
          if(!changed&&(file===index||file===descriptor)){
            changed=true;
            ${operation === "replace" ? "fs.renameSync(index,index+'.previous');fs.renameSync(replacement,index);" : "fs.writeFileSync(index,read.call(fs,replacement));"}
          }
          return read.call(fs,file,...args);
        };
        fs.closeSync=function(fd){const result=close.call(fs,fd);
          if(fd===descriptor){descriptor=undefined;let released=false;try{fs.fstatSync(fd);}catch(error){released=error.code==='EBADF';}
            if(released)fs.writeFileSync(${JSON.stringify(closed)},'closed');}
          return result;
        };require('node:module').syncBuiltinESMExports();`,
      );
      const result = spawnSync(process.execPath, ["--require", preload, script], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TMPDIR: scratch },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/index changed/i);
      expect(readFileSync(index)).toEqual(replacementBytes);
      expect(readFileSync(join(root, "file.ts"), "utf8")).toBe("export const valid = 1;\n");
      expect(existsSync(observed)).toBe(false);
      expect(readFileSync(closed, "utf8")).toBe("closed");
      expect(readdirSync(scratch)).toEqual([]);
    },
  );
});
