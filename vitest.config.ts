import { defineConfig } from "vitest/config";

// Single source of truth for the whole repo's test run. The `node` project
// covers all backend/library code under packages/*, services/*, integrations/*.
// There are intentionally no per-package vitest configs — this file owns
// discovery for every workspace package.
export default defineConfig({
  test: {
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
          name: "node",
          environment: "node",
          globals: true,
          include: [
            "packages/**/*.test.ts",
            "services/**/*.test.ts",
            "integrations/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**"],
        },
      },
    ],
  },
});
