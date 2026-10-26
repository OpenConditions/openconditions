import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/profile.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["postgres", "vitest"],
});
