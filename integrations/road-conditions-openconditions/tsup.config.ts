import { defineConfig } from "tsup";

// Builds the OpenMapX community-integration artifact layout: the host loads the
// backend bundle from `dist/backend/index.mjs` and calls its `setup(ctx)`. The
// provider reads OpenConditions over HTTP only; any @openconditions/* import is
// inlined (noExternal) so the installed artifact needs no node_modules.
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
