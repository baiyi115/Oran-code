import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "tmp/**", "pnpm-lock.yaml"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The CLI and its debug tooling are allowed to print and exit directly.
      "no-console": "off",
      "no-process-exit": "off",
      // A leading underscore marks an intentionally unused parameter (test stubs, port adapters).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs", "*.config.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // These two modules exist to match terminal control bytes (ESC/BEL); no-control-regex is noise here.
    files: ["packages/oran-code/src/tui/terminal-streams.ts", "packages/oran-code/src/tools/output-pipeline.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },
  {
    // In tests, any is used to inspect private state and an empty async generator stands in for a
    // stub; both are idioms here.
    files: ["packages/**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "require-yield": "off",
    },
  },
);
