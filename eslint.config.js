// @ts-check
import tseslint from "typescript-eslint";

const spikeImports = "^@openconditions/probe-spike(?:/|$)|^@divviup/|(?:^|/)probe-spike(?:/|$)";
const containerImports = "^testcontainers$|^@testcontainers/";
const ingestImports =
  "^@openconditions/ingest(?:/|$)|(?:^|/)services/ingest(?:/|$)|(?:^|/)ingest/src/";
const transportImports =
  "^@openconditions/federation(?:/|$)|(?:^|/)(?:peer-health|peer-blocklist|anomaly)(?:\\.[cm]?ts|\\.[cm]?js)?$|^\\./rate(?:\\.[cm]?ts|\\.[cm]?js)?$";

/** AST restrictions cover import, re-export, dynamic import and CommonJS require.
 * @param {string[]} patterns
 */
function importRestrictions(patterns) {
  return patterns.flatMap((pattern) => {
    // esquery uses slash-delimited regexes; Unicode escapes keep path slashes unambiguous.
    const expression = pattern.replaceAll("/", "\\u002f");
    return [
      `ImportDeclaration[source.value=/${expression}/]`,
      `ExportNamedDeclaration[source.value=/${expression}/]`,
      `ExportAllDeclaration[source.value=/${expression}/]`,
      `ImportExpression[source.value=/${expression}/]`,
      `TSImportType[source.value=/${expression}/]`,
      `TSImportEqualsDeclaration[moduleReference.expression.value=/${expression}/]`,
      `CallExpression[callee.name='require'][arguments.0.value=/${expression}/]`,
    ].map((selector) => ({
      selector,
      message:
        pattern === containerImports
          ? "Import testcontainers only in *.integration.test.ts or *.integration.ts."
          : pattern === ingestImports
            ? "Use @openconditions/normalize or @openconditions/storage, not the ingest service."
            : pattern === transportImports
              ? "Event truth must remain independent of federation transport health."
              : "Keep experimental probe dependencies in probe-spike or test-only code.",
    }));
  });
}

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.d.ts",
      "coverage/",
      ".turbo/",
      "services/openlr-resolver/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["**/*.integration.test.ts", "**/*.integration.ts"],
    rules: { "no-restricted-syntax": ["error", ...importRestrictions([containerImports])] },
  },
  {
    files: ["packages/*/src/**/*.{ts,tsx,js,mjs,cjs}", "services/*/src/**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["packages/probe-spike/**", "**/__tests__/**", "**/*.test.ts", "**/*.integration.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...importRestrictions([spikeImports, containerImports])],
    },
  },
  {
    files: ["services/contributions-api/src/**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.integration.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...importRestrictions([spikeImports, ingestImports, containerImports]),
      ],
    },
  },
  {
    files: [
      "packages/core/src/{evidence,crossSourceDedupe}.ts",
      "packages/roads/src/evidence-policy.ts",
      "packages/federation/src/filter.ts",
      "services/contributions-api/src/{evidence,reputation,landing,subclaim,reviewer,federation}/**/*.ts",
    ],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.integration.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...importRestrictions([spikeImports, ingestImports, transportImports, containerImports]),
      ],
    },
  }
);
