import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["@openconditions/core"],
  // canonicalize ships ESM-only; bundle it so the CJS build does not depend
  // on require(esm) support in the consuming runtime.
  noExternal: ["canonicalize"],
});
