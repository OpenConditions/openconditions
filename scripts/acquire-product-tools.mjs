import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { consumerPackageManager, contract } from "./validate-product-manifests.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function command(command, args, cwd, home) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600000,
    env: {
      PATH: process.env.PATH,
      PNPM_HOME: process.env.PNPM_HOME,
      HOME: home,
      CI: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}
export function acquireProductTools(output, cachedRepository) {
  const scratch = mkdtempSync(join(tmpdir(), "oc-contract-build-"));
  try {
    const run = (commandName, args, cwd) => command(commandName, args, cwd, scratch);
    const repo = join(scratch, "git"),
      source = join(scratch, "source"),
      packed = join(scratch, "packed");
    mkdirSync(repo);
    mkdirSync(source);
    mkdirSync(packed);
    run("git", ["init", "--bare"], repo);
    // Optional local object cache is expert/test-only. The exact commit still owns every byte.
    run(
      "git",
      [
        "fetch",
        "--depth=1",
        cachedRepository ?? "https://github.com/OpenMapX/openmapx.git",
        contract.sourceSha,
      ],
      repo,
    );
    const archive = execFileSync("git", ["--no-replace-objects", "archive", contract.sourceSha], {
      cwd: repo,
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", source], { input: archive });
    const pkg = join(source, "packages/extension-cli"),
      admission = join(source, contract.admission.sourceFile);
    if (sha(readFileSync(admission)) !== contract.admission.sourceSha256)
      throw Error("Pinned admission source mismatch");
    const manager = consumerPackageManager(scratch, {
      PATH: process.env.PATH,
      HOME: scratch,
      PNPM_HOME: process.env.PNPM_HOME,
    });
    run(manager, ["install", "--frozen-lockfile", "--ignore-scripts"], source);
    run(manager, ["run", "build"], pkg);
    run(manager, ["pack", "--ignore-scripts", "--pack-destination", packed], pkg);
    run(
      process.execPath,
      [
        "-e",
        'require("tsup").build({entry:["../core/src/services/community-manifest.ts"],config:false,format:["esm"],target:"node24",outDir:process.argv[1],sourcemap:true,metafile:true,noExternal:[/.*/]})',
        packed,
      ],
      pkg,
    );
    const tarball = join(packed, "openmapx-extension-cli-0.1.0.tgz"),
      bundle = join(packed, "community-manifest.js");
    if (
      sha(readFileSync(tarball)) !== contract.portable.archiveSha256 ||
      sha(readFileSync(bundle)) !== contract.admission.entrySha256
    ) {
      const rejected = output + ".rejected";
      mkdirSync(rejected);
      copyFileSync(tarball, join(rejected, "portable.tgz"));
      copyFileSync(bundle, join(rejected, "admission.mjs"));
      throw Error(
        "Built OpenMapX bytes differ from reviewed pins: " +
          JSON.stringify({
            tarball: sha(readFileSync(tarball)),
            admission: sha(readFileSync(bundle)),
            diagnostics: rejected,
          }),
      );
    }
    mkdirSync(output);
    copyFileSync(tarball, join(output, "portable.tgz"));
    copyFileSync(bundle, join(output, "admission.mjs"));
    writeFileSync(
      join(output, "build.json"),
      JSON.stringify({
        source: contract.sourceSha,
        sourceArchiveSha256: sha(archive),
        archiveSha256: contract.portable.archiveSha256,
        admissionSha256: contract.admission.entrySha256,
        manager,
        releaseAuthority: false,
      }),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error("acquire-product-tools OUTPUT (new owned directory)");
  acquireProductTools(process.argv[2]);
}
