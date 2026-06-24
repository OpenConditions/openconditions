import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // The installed artifact runs inside the OpenMapX host with no access to this
  // workspace, so the only runtime dependency (@openconditions/core) is inlined
  // rather than left as a bare import. esbuild tree-shakes core down to the one
  // helper this provider uses (observationsByBbox + severity), keeping the
  // bundle small and free of postgres/drizzle.
  noExternal: [/^@openconditions\//],
});
