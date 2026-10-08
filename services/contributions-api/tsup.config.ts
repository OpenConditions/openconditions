import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// @openconditions/core is inlined into this bundle (noExternal), so its
// drizzle-kit migrations folder no longer travels with it. The main.ts entry
// runMigrations() at boot and reads those files at runtime, so copy them next
// to the bundle entry (dist/drizzle); core resolves `./drizzle` there. Lives
// inside dist/ so it rides the turbo `dist/**` output cache and the Docker
// `COPY dist`.
const coreDrizzle = fileURLToPath(new URL("../../packages/core/drizzle", import.meta.url));
const bundledDrizzle = fileURLToPath(new URL("./dist/drizzle", import.meta.url));

export default defineConfig({
  // federation/inbox is a public subpath entry: the federation service's
  // POST /peer/inbox route lands peer records through the SAME crowd paths
  // (one trust boundary); dts is emitted only for the subpaths.
  entry: ["src/index.ts", "src/main.ts", "src/federation/inbox.ts", "src/contrib.ts"],
  format: ["esm"],
  dts: {
    entry: {
      "federation/inbox": "src/federation/inbox.ts",
      contrib: "src/contrib.ts",
    },
  },
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // impit is a native module, imported lazily by the ingest framework's
  // impersonating fetch; esbuild cannot bundle its per-platform binaries.
  external: ["postgres", "impit"],
  noExternal: [/^@openconditions\//, "drizzle-orm"],
  bundle: true,
  async onSuccess() {
    await rm(bundledDrizzle, { recursive: true, force: true });
    await cp(coreDrizzle, bundledDrizzle, { recursive: true });
  },
});
