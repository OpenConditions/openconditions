import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per standard, so a test loads only the schemas it checks against.
  entry: ["src/index.ts", "src/standards/*.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  // Not cleaned: several suites build this package while others read it.
  clean: false,
  outDir: "dist",
});
