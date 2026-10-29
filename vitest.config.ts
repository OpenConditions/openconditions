import { defineConfig } from "vitest/config";

// Explicit projects keep quick unit runs separate from disposable database suites.
export default defineConfig({
  test: {
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**", "services/*/src/**"],
      exclude: [
        "**/node_modules/**",
        "**/*.test.ts",
        "**/*.d.ts",
        "**/__tests__/**",
        "**/test/**",
        "**/*.config.*",
      ],
    },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          globals: true,
          testTimeout: 15_000,
          include: ["packages/**/*.test.ts", "services/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/*.integration.test.ts",
            "scripts/__tests__/packed-packages.test.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          globals: true,
          // After the unit project and two files at a time: the database
          // suites are the heavy ones.
          sequence: { groupOrder: 1 },
          maxWorkers: 2,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // One PostGIS server per run, whose migrated template each suite clones.
          globalSetup: ["scripts/postgis-global-setup.integration.ts"],
          include: [
            "packages/**/*.integration.test.ts",
            "services/**/*.integration.test.ts",
            "scripts/**/*.integration.test.ts",
          ],
          exclude: ["**/node_modules/**"],
        },
      },
      {
        test: {
          name: "packed",
          environment: "node",
          // External installs/compilers run after existing application suites.
          sequence: { groupOrder: 2 },
          maxWorkers: 1,
          testTimeout: 150_000,
          hookTimeout: 60_000,
          include: ["scripts/__tests__/packed-packages.test.ts"],
        },
      },
    ],
  },
});
