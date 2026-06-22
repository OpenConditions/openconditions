import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // Inject an `import.meta.url` shim so runMigrations() resolves the drizzle
  // migrations folder correctly in the CJS build too (esbuild otherwise stubs
  // import.meta to {} for CJS, breaking new URL("../drizzle", import.meta.url)).
  shims: true,
});
