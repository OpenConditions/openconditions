import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: [
    "@openconditions/datex2",
    "@openconditions/ingest-framework",
    "@openconditions/model",
    "@openconditions/model-charging",
    "@openconditions/ocpi",
    "zod",
  ],
});
