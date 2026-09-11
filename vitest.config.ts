import { defineConfig } from "vitest/config";

// Explicit projects keep quick unit runs separate from disposable database suites.
export default defineConfig({
  test: {
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**", "services/*/src/**", "integrations/*/src/**"],
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
          include: [
            "packages/**/*.test.ts",
            "services/**/*.test.ts",
            "integrations/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          globals: true,
          include: [
            "packages/**/*.integration.test.ts",
            "services/**/*.integration.test.ts",
            "integrations/**/*.integration.test.ts",
            "scripts/**/*.integration.test.ts",
          ],
          exclude: ["**/node_modules/**"],
        },
      },
    ],
  },
});
