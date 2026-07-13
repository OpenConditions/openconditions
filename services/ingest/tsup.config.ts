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

// @openconditions/roads is inlined (noExternal), so its runtime-read feed data
// files don't travel with the bundle. Copy them next to the entry; the inlined
// resolveFeedsDir() finds them at ./feeds/roads. Lives in dist/ so it rides the
// turbo dist/** cache and the Docker `COPY dist`.
const roadsFeeds = fileURLToPath(new URL("../../packages/roads/feeds/roads", import.meta.url));
const bundledFeeds = fileURLToPath(new URL("./dist/feeds/roads", import.meta.url));

export default defineConfig({
  // The normalize seam and the row mapping (toRow — the ONE content-hash
  // implementation) are extra entries so the contributions-api service can
  // import them: the central write-normalization choke point and the
  // byte-equivalence hash are shared, never reimplemented. dts is emitted only
  // for those public subpaths.
  entry: ["src/index.ts", "src/pipeline/normalize.ts", "src/pipeline/write-postgis.ts"],
  format: ["esm"],
  dts: {
    entry: {
      "pipeline/normalize": "src/pipeline/normalize.ts",
      "pipeline/write-postgis": "src/pipeline/write-postgis.ts",
    },
  },
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["fastify", "postgres", "croner"],
  noExternal: [/^@openconditions\//, "fast-xml-parser", "drizzle-orm"],
  bundle: true,
  async onSuccess() {
    await rm(bundledDrizzle, { recursive: true, force: true });
    await cp(coreDrizzle, bundledDrizzle, { recursive: true });
    await rm(bundledFeeds, { recursive: true, force: true });
    await cp(roadsFeeds, bundledFeeds, { recursive: true });
  },
});
