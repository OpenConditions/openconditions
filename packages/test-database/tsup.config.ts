import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/profile.ts", "src/registry.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["postgres", "vitest"],
});
