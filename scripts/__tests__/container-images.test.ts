import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../qualify-container-images.py", import.meta.url));
const owned: string[] = [];
const digest = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
function put(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}
function call(args: string[], env = process.env) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8", env, timeout: 30_000 });
}
function fixture(platform = "amd64", change?: (root: string) => void, image = "ingest") {
  const root = mkdtempSync(join(tmpdir(), "oc-image-artifact-"));
  owned.push(root);
  const layout = join(root, "input");
  mkdirSync(layout);
  const blob = (obj: unknown) => {
    const data = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    const hash = digest(data);
    put(join(layout, "blobs/sha256", hash.slice(7)), data);
    return { digest: hash, size: data.length };
  };
  const config = blob({
    architecture: platform,
    os: "linux",
    rootfs: { type: "layers", diff_ids: [digest(Buffer.from("layer"))] },
    config: {
      User: "1001",
      Labels: {
        "org.opencontainers.image.title":
          image === "openlr-resolver"
            ? "OpenConditions OpenLR resolver"
            : `OpenConditions ${image}`,
      },
    },
  });
  const layer = blob(Buffer.from("layer"));
  const manifest = blob({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { ...config, mediaType: "application/vnd.oci.image.config.v1+json" },
    layers: [{ ...layer, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" }],
  });
  put(
    join(layout, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          ...manifest,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          platform: { os: "linux", architecture: platform },
        },
      ],
    }),
  );
  put(join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  change?.(layout);
  const archive = join(root, "image.oci.tar");
  const tar = spawnSync(
    "tar",
    ["-cf", archive, "-C", layout, "index.json", "oci-layout", "blobs"],
    { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  expect(tar.status).toBe(0);
  return { root, layout, archive, config, manifest };
}
afterEach(() => {
  for (const p of owned.splice(0)) rmSync(p, { recursive: true, force: true });
});

const workflowEnv = {
  ...process.env,
  GITHUB_ACTIONS: "true",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  IMAGE_BUILD_RESULT: "success",
};
function reports(image = "contributions-api") {
  const f = fixture("amd64", undefined, image);
  const r = call(["inspect", "--archive", f.archive]);
  expect(r.status, r.stderr).toBe(0);
  const identity = JSON.parse(r.stdout);
  const runtime = {
    identity,
    passed: true,
    health: "healthy",
    physicalPostGIS: "160004|3.4.3",
    dockerRuntimeImageId: identity.configDigest,
    checks:
      image === "openlr-resolver"
        ? {
            openlrGraphHttpNative: {
              graphCounts: [5, 5],
              invalidReferenceStatus: 400,
              geos: "fixture",
              libpq: 180006,
              match: {
                confidence: 0.9,
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [8, 50],
                    [8.0054, 50],
                  ],
                },
              },
            },
          }
        : {
            httpNativeCrypto: {
              status: "ok",
              service:
                image === "federation"
                  ? "openconditions-federation-api"
                  : `openconditions-${image}`,
            },
            migratedTables: 58,
            ...(image === "ingest"
              ? {
                  osmiumVersion: "osmium version 1.19.1",
                  osmiumFileInfo: { data: { count: { nodes: 8 } } },
                  bundledFeedsMigrationsImpit: true,
                }
              : {}),
          },
    cleanup: [
      { kind: "container", name: "fixture-app", removalExit: 0, absent: true },
      { kind: "container", name: "fixture-db", removalExit: 0, absent: true },
      { kind: "network", name: "fixture-network", removalExit: 0, absent: true },
    ],
    loadedImageCleanup: { owned: false },
  };
  const data: Record<string, unknown> = {
    "identity.json": identity,
    "scan.json": {
      SchemaVersion: 2,
      CreatedAt: "2026-10-27T00:00:00Z",
      Metadata: { ImageID: identity.configDigest, OS: { Family: "alpine" } },
      Results: [
        { Type: "alpine", Packages: [{ Name: "fixture" }] },
        {
          Type: image === "openlr-resolver" ? "python-pkg" : "node-pkg",
          Packages: [{ Name: "fixture" }],
        },
      ],
    },
    "sbom.cdx.json": {
      bomFormat: "CycloneDX",
      components: [{ name: "fixture" }],
      metadata: {
        tools: { components: [{ name: "trivy", version: "0.76.1" }] },
        component: {
          properties: [{ name: "aquasecurity:trivy:ImageID", value: identity.configDigest }],
        },
      },
    },
    "runtime.json": runtime,
    "scanner-db.json": {
      Version: 2,
      UpdatedAt: "2026-10-26T19:00:00Z",
      NextUpdate: "2026-10-27T19:00:00Z",
    },
    "build-metadata.json": {
      "buildx.build.ref": "fixture/no-authority",
      "containerimage.config.digest": identity.configDigest,
      "containerimage.digest": identity.platformManifestDigest,
    },
  };
  for (const [name, value] of Object.entries(data)) put(join(f.root, name), JSON.stringify(value));
  return { ...f, data, identity };
}
function verify(root: string, image = "contributions-api") {
  return call(
    ["verify", "--directory", root, "--image", image, "--source", "a".repeat(40)],
    workflowEnv,
  );
}

describe("image artifact identities through real OCI files/processes", () => {
  it("distinguishes archive, index, platform-manifest and config identities", () => {
    const f = fixture();
    const r = call(["inspect", "--archive", f.archive]);
    expect(r.status, r.stderr).toBe(0);
    const x = JSON.parse(r.stdout);
    expect(x.configDigest).toBe(f.config.digest);
    expect(x.platformManifestDigest).toBe(f.manifest.digest);
    expect(x.archiveContentSha256).toBe(digest(readFileSync(f.archive)).slice(7));
    expect(x.ociIndexContentSha256).toBe(
      digest(readFileSync(join(f.layout, "index.json"))).slice(7),
    );
    expect(x.registryAuthority).toBe(false);
    expect(x.platform).toBe("linux/amd64");
  });
  it("rejects an unqualified architecture", () => {
    const f = fixture("arm64");
    const r = call(["inspect", "--archive", f.archive]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("platform");
  });
  it("rejects corrupt content-addressed blobs", () => {
    const f = fixture("amd64", (p) => {
      const index = JSON.parse(readFileSync(join(p, "index.json"), "utf8"));
      put(join(p, "blobs/sha256", index.manifests[0].digest.slice(7)), "corrupt");
    });
    const r = call(["inspect", "--archive", f.archive]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("digest");
  });
  it("rejects duplicate JSON keys and extra platform manifests", () => {
    for (const transform of [
      (s: string) => s.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
      (s: string) => {
        const x = JSON.parse(s);
        x.manifests.push(x.manifests[0]);
        return JSON.stringify(x);
      },
    ]) {
      const f = fixture("amd64", (p) =>
        put(join(p, "index.json"), transform(readFileSync(join(p, "index.json"), "utf8"))),
      );
      expect(call(["inspect", "--archive", f.archive]).status).toBe(1);
    }
  });
  it("rejects unexpected archive data without extraction", () => {
    const f = fixture();
    put(join(f.layout, "unrelated"), "private");
    expect(spawnSync("tar", ["-rf", f.archive, "-C", f.layout, "unrelated"]).status).toBe(0);
    const r = call(["inspect", "--archive", f.archive]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("archive");
  });
  it("rejects a symlink at a valid OCI blob path without following it", () => {
    const f = fixture("amd64", (root) => {
      const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
      const manifest = JSON.parse(
        readFileSync(join(root, "blobs/sha256", index.manifests[0].digest.slice(7)), "utf8"),
      );
      const path = join(root, "blobs/sha256", manifest.config.digest.slice(7));
      rmSync(path);
      symlinkSync("/must-not-be-read", path);
    });
    const r = call(["inspect", "--archive", f.archive]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("links");
  });
  it("rejects an unknown image before building", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-image-tool-"));
    owned.push(root);
    const r = call([
      "qualify",
      "--image",
      "not-an-image",
      "--output",
      join(root, "output"),
      "--source",
      "a".repeat(40),
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("image");
  });
  it.each(["failure", "cancelled", "skipped", "unknown", ""])(
    "blocks a %s matrix outcome before accepting artifacts",
    (state) => {
      const root = mkdtempSync(join(tmpdir(), "oc-image-collect-"));
      owned.push(root);
      const r = call(["collect", "--directory", root, "--source", "a".repeat(40)], {
        ...process.env,
        IMAGE_BUILD_RESULT: state,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("matrix");
    },
  );
  it("rejects missing matrix artifacts even after a successful matrix result", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-image-collect-"));
    owned.push(root);
    const r = call(["collect", "--directory", root, "--source", "a".repeat(40)], {
      ...process.env,
      IMAGE_BUILD_RESULT: "success",
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing");
  });
});

describe("complete image matrix evidence", () => {
  it("accepts linked image/scan/SBOM/runtime data with no publication authority", () => {
    const f = reports();
    const r = verify(f.root);
    expect(r.status, r.stderr).toBe(0);
    const x = JSON.parse(r.stdout);
    expect(x.identity).toEqual(f.identity);
    expect(x.execution).toEqual({ kind: "github", runId: 123, attempt: 2 });
    expect(x.releaseAuthority).toBe(false);
  });
  it.each([
    "low-finding",
    "wrong-scanned-image",
    "wrong-sbom-image",
    "wrong-build-image",
    "unhealthy",
    "missing-native",
    "duplicate-cleanup",
    "wrong-runtime-image",
    "zero-migrations",
    "failed-cleanup",
    "stale-db",
    "empty-coverage",
    "empty-package-inventory",
  ])("rejects %s instead of qualifying", (kind) => {
    const f = reports();
    const d = JSON.parse(JSON.stringify(f.data));
    if (kind === "low-finding")
      d["scan.json"].Results[0].Vulnerabilities = [
        { VulnerabilityID: "CVE-fixture", Severity: "LOW" },
      ];
    if (kind === "wrong-scanned-image")
      d["scan.json"].Metadata.ImageID = "sha256:" + "f".repeat(64);
    if (kind === "wrong-sbom-image")
      d["sbom.cdx.json"].metadata.component.properties[0].value = "wrong";
    if (kind === "wrong-build-image")
      d["build-metadata.json"]["containerimage.digest"] = f.identity.configDigest;
    if (kind === "unhealthy") d["runtime.json"].health = "starting";
    if (kind === "missing-native") d["runtime.json"].checks = {};
    if (kind === "duplicate-cleanup")
      d["runtime.json"].cleanup = [
        d["runtime.json"].cleanup[0],
        d["runtime.json"].cleanup[0],
        d["runtime.json"].cleanup[0],
      ];
    if (kind === "wrong-runtime-image")
      d["runtime.json"].dockerRuntimeImageId = "sha256:" + "f".repeat(64);
    if (kind === "zero-migrations") d["runtime.json"].checks.migratedTables = 0;
    if (kind === "failed-cleanup") d["runtime.json"].cleanup[0].absent = false;
    if (kind === "stale-db") d["scanner-db.json"].NextUpdate = "2026-10-26T20:00:00Z";
    if (kind === "empty-coverage") d["scan.json"].Results = [];
    if (kind === "empty-package-inventory") d["scan.json"].Results[0].Packages = [];
    for (const [name, value] of Object.entries(d)) put(join(f.root, name), JSON.stringify(value));
    expect(verify(f.root).status).toBe(1);
  });
});

describe("matrix artifact readback", () => {
  it("requires all four roles from the same exact source/run/attempt", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-images-matrix-"));
    owned.push(root);
    for (const image of ["ingest", "contributions-api", "federation", "openlr-resolver"]) {
      const f = reports(image);
      const r = verify(f.root, image);
      expect(r.status, r.stderr).toBe(0);
      put(join(f.root, "qualified.json"), r.stdout);
      renameSync(f.root, join(root, `image-${image}-2`));
    }
    const args = ["collect", "--directory", root, "--source", "a".repeat(40)];
    expect(call(args, workflowEnv).status).toBe(0);
    const path = join(root, "image-federation-2", "qualified.json");
    const original = JSON.parse(readFileSync(path, "utf8"));
    for (const mutation of [
      { ...original, sourceSha: "b".repeat(40) },
      { ...original, execution: { ...original.execution, runId: 124 } },
      { ...original, execution: { ...original.execution, attempt: 1 } },
    ]) {
      put(path, JSON.stringify(mutation));
      expect(call(args, workflowEnv).status).toBe(1);
    }
    put(path, JSON.stringify(original));
    rmSync(join(root, "image-ingest-2", "runtime.json"));
    expect(call(args, workflowEnv).status).toBe(1);
  });
  it("fails a real build subprocess and preserves source/index while leaving no green marker", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-images-build-failure-"));
    owned.push(root);
    const bin = join(root, "bin");
    const output = join(root, "output");
    mkdirSync(bin);
    put(join(bin, "docker"), `#!${process.execPath}\nprocess.exit(19);\n`);
    chmodSync(join(bin, "docker"), 0o755);
    const sha = spawnSync("git", ["--no-replace-objects", "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    const indexPath = spawnSync("git", ["rev-parse", "--git-path", "index"], {
      encoding: "utf8",
    }).stdout.trim();
    const before = readFileSync(indexPath);
    const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
    }).stdout.trim();
    const r = spawnSync(
      python,
      [script, "qualify", "--image", "openlr-resolver", "--source", sha, "--output", output],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        timeout: 30_000,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("exit 19");
    expect(existsSync(join(output, "qualified.json"))).toBe(false);
    expect(readFileSync(indexPath)).toEqual(before);
    expect(readFileSync(join(output, "build.log"), "utf8")).toBe("");
  });
});

describe("immutable source and archive reads", () => {
  it("fails closed on a real archive pathname ABA race without mixed identity evidence", () => {
    const a = fixture("amd64", undefined, "contributions-api");
    const b = fixture("amd64", undefined, "federation");
    const originalHash = digest(readFileSync(a.archive)).slice(7);
    const code = `import importlib.util,sys,json,os,shutil
from pathlib import Path
spec=importlib.util.spec_from_file_location('qualification',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
real=m.tarfile.open
def swap(*args,**kwargs):
 os.rename(sys.argv[2],sys.argv[2]+".saved");shutil.copyfile(sys.argv[3],sys.argv[2])
 opened=real(*args,**kwargs)
 os.unlink(sys.argv[2]);os.rename(sys.argv[2]+".saved",sys.argv[2]);return opened
m.tarfile.open=swap
print(json.dumps(m.inspect_archive(Path(sys.argv[2]))))`;
    const r = spawnSync("python3", ["-c", code, script, a.archive, b.archive], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("archive changed during validation");
    expect(r.stdout).toBe("");
    expect(digest(readFileSync(a.archive)).slice(7)).toBe(originalHash);
  });
  it("archives raw Git bytes/modes despite replacement objects without changing source or index", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-image-git-source-"));
    owned.push(root);
    const repo = join(root, "repo");
    const work = join(root, "work");
    mkdirSync(repo);
    mkdirSync(work);
    const git = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    git(["init", "-q"]);
    const name = "- ü\nfixture";
    put(join(repo, name), "original\n");
    chmodSync(join(repo, name), 0o755);
    const commit = () => {
      git(["add", "."]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "fixture",
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    const a = commit();
    put(join(repo, name), "replacement\n");
    const b = commit();
    git(["checkout", "-q", a]);
    git(["replace", a, b]);
    const index = readFileSync(join(repo, ".git/index"));
    const code = `import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('qualification',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
print(m.snapshot(Path(sys.argv[2]),sys.argv[3],Path(sys.argv[4])))`;
    const r = spawnSync("python3", ["-c", code, script, repo, a, work], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(work, "source", name), "utf8")).toBe("original\n");
    expect(statSync(join(work, "source", name)).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(repo, name), "utf8")).toBe("original\n");
    expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
    expect(git(["--no-replace-objects", "rev-parse", "HEAD"])).toBe(a);
    expect(git(["replace", "-l"])).toBe(a);
  });
});

describe("image ownership uncertainty", () => {
  it.each(["transient daemon API error", "permission denied"])(
    "aborts before loading/deleting a pre-existing image after %s then recovery",
    (message) => {
      const f = fixture();
      const inspected = call(["inspect", "--archive", f.archive]);
      expect(inspected.status, inspected.stderr).toBe(0);
      put(join(f.root, "identity.json"), inspected.stdout);
      const bin = join(f.root, "bin");
      mkdirSync(bin);
      const state = join(f.root, "state.json");
      const body = `#!${process.execPath}
const fs=require('node:fs');
const path=process.env.OC_FAKE_STATE;
const i=JSON.parse(fs.readFileSync(process.env.OC_FAKE_IDENTITY,'utf8'));
let s;try{s=JSON.parse(fs.readFileSync(path,'utf8'));}catch{s={calls:[],inspections:0};}
const a=process.argv.slice(2);s.calls.push(a);
function end(code,out='',err=''){fs.writeFileSync(path,JSON.stringify(s));if(out)process.stdout.write(out);if(err)process.stderr.write(err);process.exit(code);}
if(a[0]==='image'&&a[1]==='inspect'){
 s.inspections++;
 if(s.inspections===1){s.first=a[2];end(1,'',process.env.OC_FAKE_ERROR);}
 if(s.removed&&a[2]===s.first)end(1,'','Error response from daemon: No such image: '+a[2]);
 end(0,JSON.stringify([{Id:a[2],Descriptor:{digest:a[2]},Architecture:'amd64',Os:'linux',RootFS:{Layers:i.diffIds},Config:{User:'1001'}}]));
}
if(a[0]==='load')end(0,'Loaded image ID: '+s.first+'\\n');
if(a[0]==='network'&&a[1]==='create')end(19,'','stop after recovered daemon');
if(a[0]==='image'&&a[1]==='rm'){s.removed=true;end(0);}
if(a[0]==='container'&&a[1]==='inspect')end(1,'','Error response from daemon: No such container: '+a[2]);
if(a[0]==='network'&&a[1]==='inspect')end(1,'','Error response from daemon: network '+a[2]+' not found');
end(20,'','unexpected test command');
`;
      put(join(bin, "docker"), body);
      chmodSync(join(bin, "docker"), 0o755);
      const code = `import importlib.util,sys,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('qualification',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=Path(sys.argv[2]);m.runtime_smoke('ingest',json.loads((p/'identity.json').read_text()),p,p)`;
      const r = spawnSync("python3", ["-c", code, script, f.root], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          OC_FAKE_STATE: state,
          OC_FAKE_IDENTITY: join(f.root, "identity.json"),
          OC_FAKE_ERROR: message,
        },
      });
      expect(r.status).toBe(1);
      const observed = JSON.parse(readFileSync(state, "utf8"));
      expect(
        observed.calls.some((a: string[]) => a[0] === "load"),
        JSON.stringify(observed),
      ).toBe(false);
      expect(observed.calls.some((a: string[]) => a[0] === "image" && a[1] === "rm")).toBe(false);
      expect(observed.removed).not.toBe(true);
      expect(r.stderr).toContain("image presence");
    },
  );
});
