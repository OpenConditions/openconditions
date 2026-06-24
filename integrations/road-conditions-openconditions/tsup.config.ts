import { defineConfig } from "tsup";

// Builds the OpenMapX community-integration artifact layout: the host loads the
// backend bundle from `dist/backend/index.mjs` and calls its `setup(ctx)`. The
// only runtime dependency (@openconditions/core) is inlined (noExternal) so the
// installed artifact needs no node_modules — esbuild tree-shakes core down to
// the one helper this provider uses (observationsByBbox + severity).
export default defineConfig({
  entry: { "backend/index": "src/index.ts" },
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  outDir: "dist",
  dts: false,
  sourcemap: false,
  clean: true,
  noExternal: [/^@openconditions\//],
});
