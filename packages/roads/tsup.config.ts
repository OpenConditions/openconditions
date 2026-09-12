import { defineConfig } from "tsup";

export default defineConfig({
  // `src/restrictions.ts` is a second entry so a consumer that needs only the
  // pure restriction contract does not pull in `feeds.ts`, which resolves the
  // feed-data directory at import time and is unavailable inside an extension
  // bundle.
  entry: ["src/index.ts", "src/restrictions.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["@openconditions/core", "@openconditions/ingest-framework", "zod"],
});
