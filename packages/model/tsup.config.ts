import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // canonicalize ships ESM only (no `require` export condition). Bundling it
  // keeps the CJS build loadable, which drizzle-kit needs: it loads the core
  // DB schema, and so this package, through a CommonJS require hook.
  noExternal: ["canonicalize"],
});
