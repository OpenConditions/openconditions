import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["@openconditions/core", "@openconditions/roads"],
  noExternal: [],
  bundle: true,
});
