import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// @openconditions/core is inlined into this bundle (noExternal), so its
// drizzle-kit migrations folder no longer travels with it. The main.ts entry
// runMigrations() at boot and reads those files at runtime, so copy them next
// to the bundle entry (dist/drizzle); core resolves `./drizzle` there.
const coreDrizzle = fileURLToPath(new URL("../../packages/core/drizzle", import.meta.url));
const bundledDrizzle = fileURLToPath(new URL("./dist/drizzle", import.meta.url));

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["postgres"],
  noExternal: [/^@openconditions\//, "drizzle-orm"],
  bundle: true,
  async onSuccess() {
    await rm(bundledDrizzle, { recursive: true, force: true });
    await cp(coreDrizzle, bundledDrizzle, { recursive: true });
  },
});
