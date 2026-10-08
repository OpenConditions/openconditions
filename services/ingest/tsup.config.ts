import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// @openconditions/core is inlined into this bundle (noExternal), so its
// drizzle-kit migrations folder no longer travels with it. runMigrations()
// reads those files at runtime, so copy them next to the bundle entry
// (dist/drizzle); core resolves `./drizzle` there. Lives inside dist/ so it
// rides the existing turbo `dist/**` output cache and the Docker `COPY dist`.
const coreDrizzle = fileURLToPath(new URL("../../packages/core/drizzle", import.meta.url));
const bundledDrizzle = fileURLToPath(new URL("./dist/drizzle", import.meta.url));

// The feed catalogue is read at runtime, so the repo's `feeds/` (every domain's
// region files and the shared credentials) is copied next to the entry, where
// the baked catalogue layer finds it at ./feeds. Lives in dist/ so it rides the
// turbo dist/** cache and the Docker `COPY dist`.
const repoFeeds = fileURLToPath(new URL("../../feeds", import.meta.url));
const bundledFeeds = fileURLToPath(new URL("./dist/feeds", import.meta.url));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // impit is a native module, imported lazily by the ingest framework's
  // impersonating fetch; esbuild cannot bundle its per-platform binaries.
  external: ["fastify", "postgres", "croner", "impit"],
  noExternal: [/^@openconditions\//, "fast-xml-parser", "drizzle-orm"],
  bundle: true,
  async onSuccess() {
    await rm(bundledDrizzle, { recursive: true, force: true });
    await cp(coreDrizzle, bundledDrizzle, { recursive: true });
    await rm(bundledFeeds, { recursive: true, force: true });
    await cp(repoFeeds, bundledFeeds, { recursive: true });
  },
});
