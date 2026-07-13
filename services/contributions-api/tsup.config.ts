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

// The federation ingest entry pulls the ingest pipeline's toRow, whose domain
// dispatch inlines @openconditions/roads INCLUDING its module-level feed-file
// load. Copy the feed data next to the bundle (same pattern as the ingest
// service) so the inlined resolveFeedsDir() finds it at ./feeds/roads.
const roadsFeeds = fileURLToPath(new URL("../../packages/roads/feeds/roads", import.meta.url));
const bundledFeeds = fileURLToPath(new URL("./dist/feeds/roads", import.meta.url));

export default defineConfig({
  // federation/ingest is a public subpath entry: the federation service's
  // POST /peer/inbox route runs the SAME federated ingest (one trust
  // boundary); dts is emitted only for that subpath.
  entry: ["src/index.ts", "src/main.ts", "src/federation/ingest.ts"],
  format: ["esm"],
  dts: { entry: { "federation/ingest": "src/federation/ingest.ts" } },
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["postgres"],
  noExternal: [/^@openconditions\//, "drizzle-orm"],
  bundle: true,
  async onSuccess() {
    await rm(bundledDrizzle, { recursive: true, force: true });
    await cp(coreDrizzle, bundledDrizzle, { recursive: true });
    await rm(bundledFeeds, { recursive: true, force: true });
    await cp(roadsFeeds, bundledFeeds, { recursive: true });
  },
});
