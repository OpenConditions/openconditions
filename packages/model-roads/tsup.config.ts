import { defineConfig } from "tsup";

export default defineConfig({
  // `src/restrictions.ts` is a second entry so a consumer that needs only the
  // restriction contract does not bundle the registry module and its
  // crosswalk tables.
  entry: ["src/index.ts", "src/restrictions.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
