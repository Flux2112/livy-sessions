import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/out/",
      "**/dist/",
      "**/node_modules/",
      "**/esbuild.js",
      "**/jest.config.js",
      "**/__mocks__/",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-console": "error",
      "prefer-const": "error",
      "no-var": "error"
    }
  },
  {
    // NOTE: Phase 2 will move dependencyStore, managedDepStore, and sessionManager
    // out of packages/core into packages/extension. Until then, core still contains
    // these three VSCode-coupled files and this rule is scoped to new files only.
    files: ["packages/core/src/**/*.ts"],
    ignores: [
      "packages/core/src/dependencyStore.ts",
      "packages/core/src/managedDepStore.ts",
      "packages/core/src/sessionManager.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "vscode", message: "packages/core must not depend on the VSCode API." }]
      }]
    }
  },
  {
    files: ["**/__tests__/**/*.test.ts"],
    ...tseslint.configs.disableTypeChecked,
  }
);
