import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["@divviup/prio3", "@divviup/vdaf", "@cloudflare/privacypass-ts", "postgres"],
});
