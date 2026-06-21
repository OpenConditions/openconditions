import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["fastify", "postgres", "croner"],
  noExternal: [/^@openconditions\//, "fast-xml-parser", "drizzle-orm"],
  bundle: true,
});
